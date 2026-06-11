// Conversas do HubSpot (Olivia no inbox — inbound + outbound via HubSpot).
// =============================================================================
// Partes PURAS (sem I/O além de Web Crypto) — unit-testadas no Vitest e usadas
// pela Edge Function `olivia-hubspot-webhook` e pela `olivia-responder` (envio).
//
// ARQUITETURA (decisão de 11/06): tudo centrado no HubSpot. O número de WhatsApp
// permanece conectado ao HubSpot; as respostas dos leads caem no INBOX do
// HubSpot; este módulo recebe o webhook `conversation.newMessage` do app privado
// e a Olivia responde DE VOLTA pela API de Conversas — a conversa inteira fica
// visível e gerenciável no inbox (humano pode assumir a qualquer momento).
//
// ANTI-INVENÇÃO: os campos de envio (canal, conta do canal, destinatário) são
// SEMPRE copiados de uma mensagem real do thread — nunca fabricados.
// =============================================================================

// --- Assinatura v3 do HubSpot (X-HubSpot-Signature-v3) ------------------------

const encoder = new TextEncoder()

// Janela máxima aceita entre o timestamp do header e o relógio local (replay).
export const HUBSPOT_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000

/**
 * String-base da assinatura v3: method + uri + body + timestamp (docs HubSpot).
 * Separado do verify para ser testável sem crypto.
 */
export function hubspotV3BaseString(
  method: string,
  uri: string,
  rawBody: string,
  timestamp: string,
): string {
  return `${method}${uri}${rawBody}${timestamp}`
}

/**
 * Verifica o header `X-HubSpot-Signature-v3` (HMAC-SHA256 base64 do base string,
 * chave = client secret do app privado). Timestamp velho (>5min) é rejeitado
 * (anti-replay, conforme docs). Sem segredo/headers → false.
 */
export async function verifyHubspotV3Signature(opts: {
  clientSecret: string | null | undefined
  method: string
  uri: string
  rawBody: string
  timestampHeader: string | null | undefined
  signatureHeader: string | null | undefined
  nowMs?: number
}): Promise<boolean> {
  const { clientSecret, method, uri, rawBody, timestampHeader, signatureHeader } = opts
  if (!clientSecret || !timestampHeader || !signatureHeader) return false

  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts)) return false
  const now = opts.nowMs ?? Date.now()
  if (Math.abs(now - ts) > HUBSPOT_SIGNATURE_MAX_SKEW_MS) return false

  const base = hubspotV3BaseString(method, uri, rawBody, timestampHeader)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(base))
  const actual = btoa(String.fromCharCode(...new Uint8Array(mac)))

  // Comparação em tempo constante (endpoint público).
  if (actual.length !== signatureHeader.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ signatureHeader.charCodeAt(i)
  }
  return diff === 0
}

// --- Parse dos eventos do webhook ---------------------------------------------

export interface NewMessageEvent {
  threadId: string
  messageId: string
  /** 'MESSAGE' = mensagem real; 'COMMENT' = nota interna (ignorada). */
  messageType: string
  occurredAt: number | null
}

/**
 * Filtra o array de eventos do webhook para os `conversation.newMessage` com
 * ids válidos. Tolerante a formato inesperado (sem throw): o endpoint responde
 * 200 rápido e o que não parsear é descartado.
 */
export function parseNewMessageEvents(body: unknown): NewMessageEvent[] {
  if (!Array.isArray(body)) return []
  const out: NewMessageEvent[] = []
  for (const ev of body) {
    if (ev?.subscriptionType !== 'conversation.newMessage') continue
    const threadId = ev?.objectId != null ? String(ev.objectId) : null
    const messageId = typeof ev?.messageId === 'string' ? ev.messageId : null
    if (!threadId || !messageId) continue
    out.push({
      threadId,
      messageId,
      messageType: typeof ev?.messageType === 'string' ? ev.messageType : 'MESSAGE',
      occurredAt: Number.isFinite(Number(ev?.occurredAt)) ? Number(ev.occurredAt) : null,
    })
  }
  return out
}

// --- Normalização da mensagem do thread (GET .../messages/{id}) ---------------

export interface HubspotInbound {
  texto: string | null
  /** Telefone E.164 do remetente (deliveryIdentifier HS_PHONE_NUMBER), se houver. */
  phone: string | null
  channelId: string | null
  channelAccountId: string | null
  senderActorId: string | null
  createdAt: string | null
}

/**
 * Normaliza UMA mensagem da API de Conversas. Devolve null quando não é uma
 * mensagem INCOMING de tipo MESSAGE (ex.: nossa própria saída, comentário,
 * evento de sistema) — é o gate anti-eco: a Olivia nunca responde a si mesma.
 */
export function extractInbound(msg: unknown): HubspotInbound | null {
  const m = msg as Record<string, any>
  if (!m || m.type !== 'MESSAGE' || m.direction !== 'INCOMING') return null

  const sender = Array.isArray(m.senders) ? m.senders[0] : null
  const di = sender?.deliveryIdentifier
  const phone =
    di?.type === 'HS_PHONE_NUMBER' && typeof di?.value === 'string' ? di.value : null

  return {
    texto: typeof m.text === 'string' && m.text.trim() ? m.text.trim() : null,
    phone,
    channelId: m.channelId != null ? String(m.channelId) : null,
    channelAccountId: m.channelAccountId != null ? String(m.channelAccountId) : null,
    senderActorId: typeof sender?.actorId === 'string' ? sender.actorId : null,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : null,
  }
}

// --- Corpo do envio (POST .../threads/{id}/messages) --------------------------

export interface EnvioHubspotCampos {
  /** Mensagem INCOMING de referência: define canal + destinatário (cópia, nunca invenção). */
  inbound: HubspotInbound
  /** Ator remetente "A-<userId>" (agente). Vem de mensagem OUTGOING anterior ou de env. */
  senderActorId: string
  texto: string
}

/**
 * Monta o corpo do POST de resposta no thread. Canal/conta/destinatário são
 * copiados da mensagem recebida; só o texto e o ator de envio variam.
 * Devolve null se faltar campo essencial (não chuta canal).
 */
export function montarEnvioHubspot(campos: EnvioHubspotCampos): Record<string, unknown> | null {
  const { inbound, senderActorId, texto } = campos
  if (!texto.trim() || !senderActorId) return null
  if (!inbound.channelId || !inbound.channelAccountId) return null
  // Destinatário: o ator OU o telefone de entrega do remetente original.
  const recipient: Record<string, unknown> = {}
  if (inbound.senderActorId) recipient.actorId = inbound.senderActorId
  if (inbound.phone) {
    recipient.deliveryIdentifiers = [{ type: 'HS_PHONE_NUMBER', value: inbound.phone }]
  }
  if (!recipient.actorId && !recipient.deliveryIdentifiers) return null

  return {
    type: 'MESSAGE',
    text: texto,
    senderActorId,
    channelId: inbound.channelId,
    channelAccountId: inbound.channelAccountId,
    recipients: [recipient],
  }
}

/**
 * Acha o ator remetente para a resposta: a mensagem OUTGOING mais recente do
 * thread cujo actorId seja de agente ("A-..."), ou null (caller decide fallback
 * por env). Bots/integrações ("I-...") não servem como sender da API.
 */
export function acharSenderActor(mensagens: unknown[]): string | null {
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i] as Record<string, any>
    if (m?.type !== 'MESSAGE' || m?.direction !== 'OUTGOING') continue
    const actor = Array.isArray(m.senders) ? m.senders[0]?.actorId : null
    if (typeof actor === 'string' && actor.startsWith('A-')) return actor
  }
  return null
}
