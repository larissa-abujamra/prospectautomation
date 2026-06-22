// Webhook da Meta WhatsApp Cloud API (Olivia Autônoma — Fase A, inbound).
// =============================================================================
// Partes PURAS (sem I/O além de Web Crypto) — unit-testadas no Vitest e usadas
// pela Edge Function `whatsapp-webhook`. Mantém o padrão do projeto: lógica
// testável aqui, fiação fina na function.
//
// ANTI-INVENÇÃO: nada é fabricado. Mensagem de número desconhecido fica sem
// lead_id; status desconhecido é ignorado; texto inexistente fica null.
// =============================================================================

// --- Verificação do webhook (GET hub.challenge) -----------------------------

/**
 * Valida o handshake de assinatura do webhook da Meta (GET com hub.mode,
 * hub.verify_token e hub.challenge). Token vazio/ausente nunca verifica.
 */
export function verifyChallenge(
  params: URLSearchParams,
  expectedToken: string | null | undefined,
): { ok: boolean; challenge: string } {
  const ok =
    !!expectedToken &&
    params.get('hub.mode') === 'subscribe' &&
    params.get('hub.verify_token') === expectedToken
  return { ok, challenge: params.get('hub.challenge') ?? '' }
}

// --- Assinatura X-Hub-Signature-256 (POST) -----------------------------------

const encoder = new TextEncoder()

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verifica o HMAC-SHA256 do corpo cru contra o header `X-Hub-Signature-256`
 * ("sha256=<hex>"). Web Crypto roda igual no Deno (Edge Function) e no Node 20+
 * (Vitest). Sem segredo ou sem header → false (endpoint público não processa
 * payload não assinado).
 */
export async function verifyMetaSignature(
  appSecret: string | null | undefined,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!appSecret || !signatureHeader) return false
  const expected = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length).toLowerCase()
    : null
  if (!expected) return false

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const actual = bytesToHex(mac)

  // Comparação em tempo constante (evita timing attack no endpoint público).
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

// --- Parse dos eventos (POST body) -------------------------------------------

export interface InboundMessage {
  kind: 'message'
  wamid: string
  from: string // dígitos crus da Meta, ex. "5511963366136"
  tipo: string
  corpo: string | null
  timestamp: string // ISO
  raw: unknown
}

export interface StatusUpdate {
  kind: 'status'
  wamid: string
  status: string // 'sent' | 'delivered' | 'read' | 'failed' | ...
  timestamp: string // ISO
}

export type WebhookEvent = InboundMessage | StatusUpdate

// Epoch em segundos (string, padrão da Meta) → ISO. Inválido → null.
function epochToIso(ts: unknown): string | null {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

// Extrai o texto "humano" da mensagem conforme o tipo. Mídia sem caption → null.
function extractCorpo(msg: Record<string, any>): string | null {
  switch (msg?.type) {
    case 'text':
      return typeof msg.text?.body === 'string' ? msg.text.body : null
    case 'button':
      return typeof msg.button?.text === 'string' ? msg.button.text : null
    case 'interactive': {
      const i = msg.interactive
      return i?.button_reply?.title ?? i?.list_reply?.title ?? null
    }
    case 'contacts': {
      // Cartão(ões) de contato compartilhado(s). Achata os telefones num texto no
      // MESMO formato que o inbox do HubSpot produz ("[Contato compartilhado: ...]"),
      // pra a Olivia (escolherNumeroBr no registrar_dono) tratar igual nos dois canais.
      const contatos = Array.isArray(msg.contacts) ? msg.contacts : []
      const nums: string[] = []
      let nome: string | null = null
      for (const c of contatos) {
        // Nome do cartão (formatted_name é o padrão; first_name como fallback) — vai
        // embutido no texto pra a Olivia personalizar a 1ª mensagem ({{1}} = "Oi <nome>!").
        if (!nome) {
          const fn = c?.name?.formatted_name ?? c?.name?.first_name
          if (typeof fn === 'string' && fn.trim()) nome = fn.trim()
        }
        for (const p of Array.isArray(c?.phones) ? c.phones : []) {
          const v = p?.wa_id ?? p?.phone
          if (typeof v === 'string' && v.trim()) nums.push(v.trim())
        }
      }
      if (!nums.length) return null
      const corpoCard = `[Contato compartilhado: ${nums.join(', ')}`
      return nome ? `${corpoCard} | nome: ${nome}]` : `${corpoCard}]`
    }
    default:
      return typeof msg?.[msg?.type]?.caption === 'string' ? msg[msg.type].caption : null
  }
}

/**
 * Achata o payload do webhook (entry[].changes[].value) em eventos simples.
 * Tolerante a formato inesperado: o que não parser vira nada (sem throw) — o
 * endpoint sempre responde 200 rápido para a Meta não re-entregar à exaustão.
 */
export function parseWebhookEvents(body: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = []
  const entries = (body as Record<string, any>)?.entry
  if (!Array.isArray(entries)) return events

  for (const entry of entries) {
    const changes = entry?.changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const value = change?.value
      if (change?.field !== 'messages' || !value) continue

      for (const msg of Array.isArray(value.messages) ? value.messages : []) {
        const wamid = typeof msg?.id === 'string' ? msg.id : null
        const from = typeof msg?.from === 'string' ? msg.from : null
        const timestamp = epochToIso(msg?.timestamp)
        if (!wamid || !from || !timestamp) continue
        events.push({
          kind: 'message',
          wamid,
          from,
          tipo: typeof msg.type === 'string' ? msg.type : 'unknown',
          corpo: extractCorpo(msg),
          timestamp,
          raw: msg,
        })
      }

      for (const st of Array.isArray(value.statuses) ? value.statuses : []) {
        const wamid = typeof st?.id === 'string' ? st.id : null
        const status = typeof st?.status === 'string' ? st.status : null
        const timestamp = epochToIso(st?.timestamp)
        if (!wamid || !status || !timestamp) continue
        events.push({ kind: 'status', wamid, status, timestamp })
      }
    }
  }
  return events
}

// --- Progressão do whatsapp_send_status --------------------------------------

// Ordem natural do envio. 'replied' (lead respondeu) é terminal e domina tudo.
const SEND_STATUS_RANK: Record<string, number> = {
  failed: 0,
  invalid: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  replied: 4,
}

/**
 * Decide se um status novo (da Meta ou 'replied' por mensagem recebida) pode
 * sobrescrever o atual. Nunca regride (webhook chega fora de ordem); 'failed'
 * só vale se ainda não houve entrega.
 */
export function shouldAdvanceSendStatus(
  current: string | null | undefined,
  next: string,
): boolean {
  const nextRank = SEND_STATUS_RANK[next]
  if (nextRank === undefined) return false // status desconhecido → ignora
  if (!current || SEND_STATUS_RANK[current] === undefined) return true
  if (next === 'failed' || next === 'invalid') {
    return SEND_STATUS_RANK[current] <= 1 // só falha quem não foi entregue
  }
  return nextRank > SEND_STATUS_RANK[current]
}

// --- Match do remetente com o lead --------------------------------------------

/**
 * Variantes E.164 plausíveis do `from` da Meta para casar com
 * leads.whatsapp_phone / whatsapp_dono (gravados como "+55...").
 * Quirk BR conhecido: a Meta às vezes entrega celular SEM o 9º dígito
 * (12 dígitos: 55 + DDD + 8). Geramos a variante com '9' APENAS para match —
 * nada é gravado, então não fere o anti-invenção.
 */
export function inboundPhoneCandidates(from: string): string[] {
  const digits = from.replace(/\D/g, '')
  if (!digits) return []
  const candidates = new Set<string>([`+${digits}`])
  if (digits.startsWith('55')) {
    const national = digits.slice(2)
    if (national.length === 10 && /^[6-9]/.test(national.slice(2, 3))) {
      // celular sem o nono dígito → variante com 9 (só para procurar o lead)
      candidates.add(`+55${national.slice(0, 2)}9${national.slice(2)}`)
    }
    if (national.length === 11 && national[2] === '9') {
      // e o inverso: gravado sem 9, chegou com 9
      candidates.add(`+55${national.slice(0, 2)}${national.slice(3)}`)
    }
  }
  // Hardening: só E.164-BR estritos (+ e 10-15 dígitos). Garante que nada além de
  // [+0-9] chega à interpolação do filtro PostgREST (.or(...)) nos webhooks —
  // defesa em profundidade caso a normalização acima mude.
  return [...candidates].filter((c) => /^\+\d{10,15}$/.test(c))
}

// --- Estado da Olivia ----------------------------------------------------------

export type OliviaEstado =
  | 'aguardando'
  | 'conversando'
  | 'agendando'
  | 'agendado'
  | 'handoff'
  | 'optout'

// Estados que uma resposta do lead NÃO altera: optout é definitivo (LGPD),
// handoff é do humano, agendado/agendando são da Fase B/C.
const ESTADOS_PRESERVADOS: ReadonlySet<string> = new Set([
  'optout',
  'handoff',
  'agendado',
  'agendando',
])

/**
 * Próximo estado quando chega mensagem do lead. Fase A só promove para
 * 'conversando'; estados "fortes" são preservados.
 */
export function estadoAposResposta(
  atual: string | null | undefined,
): OliviaEstado | null {
  if (atual && ESTADOS_PRESERVADOS.has(atual)) return null // não mexe
  return 'conversando'
}
