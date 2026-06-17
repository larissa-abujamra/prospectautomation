// Edge Function: olivia-hubspot-webhook
// =============================================================================
// Olivia no inbox do HubSpot (inbound): recebe o webhook `conversation.newMessage`
// do app privado do HubSpot quando o lead responde no WhatsApp. Decisão de
// arquitetura (11/06): TUDO centrado no HubSpot — o número fica conectado ao
// HubSpot, as respostas caem no inbox, e a Olivia responde de volta pela API de
// Conversas (a conversa inteira fica gerenciável no inbox).
//
// FLUXO: valida assinatura v3 → busca a mensagem na API de Conversas → só
// processa INCOMING MESSAGE com texto (anti-eco) → casa o contato com o lead
// (hubspot_contact_id, fallback por telefone) → grava em whatsapp_mensagens
// (dedup por id da mensagem) → avança status/estado → dispara olivia-responder.
//
// SETUP (app privado prospect-automation-whatsapp → aba Webhooks):
//   URL de destino: https://<project-ref>.supabase.co/functions/v1/olivia-hubspot-webhook
//   Assinatura: conversation.newMessage
//
// Secrets:
//   HUBSPOT_APP_CLIENT_SECRET     (segredo do cliente do app — valida a assinatura v3)
//   HUBSPOT_CONVERSATIONS_TOKEN   (token com conversations.read; fallback no
//                                  HUBSPOT_PRIVATE_APP_TOKEN quando os escopos
//                                  forem adicionados ao app principal)
//   OLIVIA_TRIGGER_SECRET         (mesmo da olivia-responder)
//
// DEPLOY: chamada pelo HUBSPOT, não por usuário logado — SEM verificação de JWT:
//   supabase functions deploy olivia-hubspot-webhook --no-verify-jwt
// Segurança = assinatura HMAC v3 validada em todo POST (sem segredo → 503, igual
// ao whatsapp-webhook: não descarta inbound em silêncio durante setup/rotação).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  extractInbound,
  parseNewMessageEvents,
  verifyHubspotV3Signature,
  type NewMessageEvent,
} from '../_shared/hubspot_conversations.ts'
import {
  estadoAposResposta,
  inboundPhoneCandidates,
  shouldAdvanceSendStatus,
} from '../_shared/whatsapp_webhook.ts'
import {
  HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO,
  hubspotReplyContactCandidates,
  patchHubspotReplyOutreach,
  queueHubspotOliviaReportingSync,
  queueHubspotDealStageSync,
} from '../_shared/hubspot.ts'
import {
  advanceableWorkflowCurrentStatuses,
  buildHubspotWorkflowWritebackPatch,
  parseHubspotWorkflowWritebackPayload,
  verifyWorkflowSecret,
  workflowSecretAttempt,
} from '../_shared/hubspot_workflow_writeback.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

type Supabase = ReturnType<typeof createClient>

const HUBSPOT_BASE = 'https://api.hubapi.com'

function hsToken(): string | null {
  return (
    Deno.env.get('HUBSPOT_CONVERSATIONS_TOKEN') ??
    Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN') ??
    null
  )
}

function hubspotWritebackSecret(): string | null {
  return Deno.env.get('OLIVIA_HUBSPOT_WRITEBACK_SECRET') ?? Deno.env.get('OLIVIA_TRIGGER_SECRET') ?? null
}

async function hsGet(path: string): Promise<Record<string, unknown> | null> {
  const token = hsToken()
  if (!token) return null
  const resp = await fetch(`${HUBSPOT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) {
    console.error('olivia-hubspot-webhook: GET', path, 'HTTP', resp.status)
    return null
  }
  return await resp.json().catch(() => null)
}

interface LeadRow {
  id: string
  whatsapp_send_status: string | null
  whatsapp_sent_at: string | null
  olivia_estado: string | null
  hubspot_thread_id: string | null
  hubspot_contact_id: string | null
  hubspot_deal_id: string | null
}

// Casa o thread com o lead: 1º pelo contato associado (hubspot_contact_id é
// gravado pelo exportar-hubspot), 2º pelo telefone do remetente (variantes BR).
// Anti-invenção: sem match → mensagem fica registrada sem lead_id, sem chute.
async function acharLead(
  supabase: Supabase,
  associatedContactId: string | null,
  phone: string | null,
): Promise<LeadRow | null> {
  const cols = 'id, whatsapp_send_status, whatsapp_sent_at, olivia_estado, hubspot_thread_id, hubspot_contact_id, hubspot_deal_id'
  if (associatedContactId) {
    const { data } = await supabase
      .from('leads')
      .select(cols)
      .eq('hubspot_contact_id', associatedContactId)
      .limit(1)
    if (data?.[0]) return data[0] as unknown as LeadRow
  }
  if (phone) {
    const candidates = inboundPhoneCandidates(phone)
    if (candidates.length > 0) {
      const quoted = candidates.map((c) => `"${c}"`).join(',')
      const { data } = await supabase
        .from('leads')
        .select(cols)
        .or(`whatsapp_phone.in.(${quoted}),whatsapp_dono.in.(${quoted})`)
        .limit(1)
      if (data?.[0]) return data[0] as unknown as LeadRow
    }
  }
  return null
}

async function processarEvento(supabase: Supabase, ev: NewMessageEvent): Promise<void> {
  if (ev.messageType === 'COMMENT') return // nota interna do time — não é o lead

  // Busca a mensagem real (texto, direção, canal). Sem token/escopo ainda → loga
  // e sai: o evento se perde, mas o setup é detectável nos logs (nada silencioso).
  const msg = await hsGet(
    `/conversations/v3/conversations/threads/${ev.threadId}/messages/${ev.messageId}`,
  )
  if (!msg) {
    console.error('olivia-hubspot-webhook: sem acesso à mensagem (token/escopo?)', ev.threadId)
    return
  }

  const inbound = extractInbound(msg)
  if (!inbound) return // OUTGOING/sistema → anti-eco: nunca respondemos a nós mesmos

  // Filtro de canal: a WABA tem vários números da Inner (suporte etc.) e o
  // webhook do portal recebe TUDO. Só processamos o canal da Olivia — as outras
  // linhas nem são gravadas (além de não responder, que o match de lead já
  // garantia). Sem env configurada → comportamento antigo (grava tudo).
  const canalOlivia = Deno.env.get('OLIVIA_HUBSPOT_CHANNEL_ACCOUNT')
  if (canalOlivia && inbound.channelAccountId !== canalOlivia) {
    console.warn('olivia-hubspot-webhook: inbound ignorado por canal diferente', {
      expectedChannelAccountId: canalOlivia,
      receivedChannelAccountId: inbound.channelAccountId,
      threadId: ev.threadId,
      messageId: ev.messageId,
    })
    return
  }

  // Contato associado ao thread (para casar com o lead).
  const thread = await hsGet(`/conversations/v3/conversations/threads/${ev.threadId}`)
  const associatedContactId =
    thread?.associatedContactId != null ? String(thread.associatedContactId) : null

  const lead = await acharLead(supabase, associatedContactId, inbound.phone)

  // Dedup pela própria chave do HubSpot (re-entrega de webhook é normal).
  const { error: insErr, data: inserted } = await supabase
    .from('whatsapp_mensagens')
    .upsert(
      {
        lead_id: lead?.id ?? null,
        direcao: 'in',
        wamid: `hs:${ev.messageId}`,
        tipo: 'text',
        corpo: inbound.texto,
        enviada_em: inbound.createdAt ?? new Date().toISOString(),
        raw: { hubspot: { threadId: ev.threadId, messageId: ev.messageId } },
      },
      { onConflict: 'wamid', ignoreDuplicates: true },
    )
    .select('id')
  if (insErr) {
    console.error('olivia-hubspot-webhook: falha ao gravar mensagem', insErr.message)
    return
  }
  const isNew = (inserted?.length ?? 0) > 0
  if (!lead || !isNew) return

  const patch: Record<string, unknown> = { hubspot_thread_id: ev.threadId }
  const respondeuAgora = shouldAdvanceSendStatus(lead.whatsapp_send_status, 'replied')
  if (respondeuAgora) patch.whatsapp_send_status = 'replied'
  const novoEstado = estadoAposResposta(lead.olivia_estado)
  if (novoEstado && novoEstado !== lead.olivia_estado) patch.olivia_estado = novoEstado
  const { error: updErr } = await supabase.from('leads').update(patch).eq('id', lead.id)
  if (updErr) {
    console.error('olivia-hubspot-webhook: falha ao atualizar lead', updErr.message)
  }

  const replyContactIds = hubspotReplyContactCandidates(lead.hubspot_contact_id, associatedContactId)

  // Write-back no HubSpot: whatsapp_outreach='replied' é o GUARD do follow-up
  // (Fase D) — o branch de 48h dos workflows só re-dispara quem continua
  // 'Enviado'. Sem isto, quem respondeu levaria follow-up junto (spam).
  if (respondeuAgora) {
    await marcarRepliedNoHubspot(replyContactIds)
  }

  if (respondeuAgora) {
    queueHubspotOliviaReportingSync(
      { contactId: replyContactIds[0] ?? null, dealId: lead.hubspot_deal_id },
      { ...lead, hubspot_thread_id: ev.threadId, whatsapp_send_status: 'replied' },
      { disparoStatus: 'replied', respostaEm: inbound.createdAt ?? new Date().toISOString() },
      'olivia-hubspot-webhook:reply',
    )
  }

  if (novoEstado === 'conversando' && novoEstado !== lead.olivia_estado) {
    queueHubspotDealStageSync(
      lead.hubspot_deal_id,
      HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO,
      'olivia-hubspot-webhook',
    )
  }

  triggerOliviaResponder(lead.id)
}

// Marca o contato como 'replied' no HubSpot (guard do follow-up de 48h).
// Usa o token principal (crm.objects.contacts.write, já concedido). Falha aqui
// não derruba o fluxo — só loga (o follow-up erraria pro lado do re-envio).
async function marcarRepliedNoHubspot(contactIds: readonly string[]): Promise<void> {
  const token = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')
  await patchHubspotReplyOutreach(token, contactIds, 'olivia-hubspot-webhook')
}

// Fire-and-forget (o HubSpot precisa do 200 rápido; re-tenta em non-2xx).
function triggerOliviaResponder(leadId: string): void {
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!secret || !supabaseUrl) return // Olivia desligada → fluxo manual no inbox
  const p = fetch(`${supabaseUrl}/functions/v1/olivia-responder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
    body: JSON.stringify({ lead_id: leadId }),
  })
    .then((r) => {
      if (!r.ok) console.error('olivia-hubspot-webhook: olivia-responder respondeu', r.status)
    })
    .catch((e) =>
      console.error('olivia-hubspot-webhook: falha ao chamar olivia-responder', e?.message),
    )
  try {
    ;(globalThis as { EdgeRuntime?: { waitUntil?: (pr: Promise<unknown>) => void } }).EdgeRuntime
      ?.waitUntil?.(p)
  } catch {
    /* ambiente sem EdgeRuntime (teste) — ignora */
  }
}

function statusAdvanceFilter(status: 'sent' | 'delivered' | 'read'): string {
  const currentStatuses = advanceableWorkflowCurrentStatuses(status)
  const parts: string[] = []
  if (currentStatuses.includes(null)) parts.push('whatsapp_send_status.is.null')
  const nonNullStatuses = currentStatuses.filter((s): s is string => s != null)
  if (nonNullStatuses.length > 0) {
    parts.push(`whatsapp_send_status.in.(${nonNullStatuses.join(',')})`)
  }
  return parts.join(',')
}

async function processarWorkflowWriteback(supabase: Supabase, rawBody: string): Promise<Response> {
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: 'JSON inválido.' }, 400)
  }

  const parsed = parseHubspotWorkflowWritebackPayload(body)
  if (!parsed.ok) return json({ error: parsed.error }, 400)

  const { data: lead, error: selErr } = await supabase
    .from('leads')
    .select('id, whatsapp_send_status, whatsapp_sent_at')
    .eq('hubspot_contact_id', parsed.contactId)
    .limit(1)
    .maybeSingle()

  if (selErr) {
    console.error('olivia-hubspot-webhook: write-back select falhou', selErr.message)
    return json({ error: 'Falha ao buscar lead.' }, 500)
  }
  if (!lead) {
    return json({ error: 'Lead não encontrado para hubspot_contact_id.' }, 404)
  }

  const patch = buildHubspotWorkflowWritebackPatch(lead, parsed)
  if (!patch.shouldUpdate) {
    return json({
      received: true,
      updated: false,
      lead_id: lead.id,
      status: lead.whatsapp_send_status,
      whatsapp_sent_at: lead.whatsapp_sent_at,
    })
  }

  let updated = false
  if (patch.patch.whatsapp_send_status) {
    const { data, error } = await supabase
      .from('leads')
      .update({ whatsapp_send_status: patch.patch.whatsapp_send_status })
      .eq('id', lead.id)
      .or(statusAdvanceFilter(patch.patch.whatsapp_send_status))
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('olivia-hubspot-webhook: write-back status update falhou', error.message)
      return json({ error: 'Falha ao atualizar status do lead.' }, 500)
    }
    updated ||= !!data
  }

  if (patch.patch.whatsapp_sent_at) {
    const { data, error } = await supabase
      .from('leads')
      .update({ whatsapp_sent_at: patch.patch.whatsapp_sent_at })
      .eq('id', lead.id)
      .is('whatsapp_sent_at', null)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('olivia-hubspot-webhook: write-back sent_at update falhou', error.message)
      return json({ error: 'Falha ao atualizar data de envio do lead.' }, 500)
    }
    updated ||= !!data
  }

  const { data: finalLead } = await supabase
    .from('leads')
    .select('id, whatsapp_send_status, whatsapp_sent_at')
    .eq('id', lead.id)
    .maybeSingle()

  return json({
    received: true,
    updated,
    lead_id: finalLead?.id ?? lead.id,
    status: finalLead?.whatsapp_send_status ?? lead.whatsapp_send_status,
    whatsapp_sent_at: finalLead?.whatsapp_sent_at ?? lead.whatsapp_sent_at,
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const rawBody = await req.text()
  if (workflowSecretAttempt(req.headers)) {
    const triggerSecret = hubspotWritebackSecret()
    if (!triggerSecret) {
      console.error('olivia-hubspot-webhook: OLIVIA_HUBSPOT_WRITEBACK_SECRET/OLIVIA_TRIGGER_SECRET não configurado')
      return json({ error: 'Write-back não configurado.' }, 503)
    }
    if (!verifyWorkflowSecret(req.headers, triggerSecret)) {
      return json({ error: 'Não autorizado.' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    return await processarWorkflowWriteback(supabase, rawBody)
  }

  // Sem o client secret não dá pra validar NADA — 503 faz o HubSpot re-entregar
  // com backoff até o secret existir (janela de setup), preservando os inbounds.
  const clientSecret = Deno.env.get('HUBSPOT_APP_CLIENT_SECRET')
  if (!clientSecret) {
    console.error('olivia-hubspot-webhook: HUBSPOT_APP_CLIENT_SECRET não configurado')
    return json({ error: 'Webhook não configurado.' }, 503)
  }

  // O HubSpot assina a URL PÚBLICA que ele chamou; dentro do edge runtime o
  // req.url pode vir reescrito (host interno). Verifica contra os candidatos
  // plausíveis — basta um bater (cada verify é constant-time).
  const path = '/functions/v1/olivia-hubspot-webhook'
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const uriCandidates = [...new Set([`${supabaseUrl}${path}`, req.url])].filter(Boolean)
  const headers = {
    timestampHeader: req.headers.get('x-hubspot-request-timestamp'),
    signatureHeader: req.headers.get('x-hubspot-signature-v3'),
  }
  let ok = false
  for (const uri of uriCandidates) {
    if (await verifyHubspotV3Signature({ clientSecret, method: 'POST', uri, rawBody, ...headers })) {
      ok = true
      break
    }
  }
  if (!ok) return json({ error: 'Assinatura inválida.' }, 401)

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return json({ received: true }) // assinado mas malformado → aceita e ignora
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Erro num evento não pode virar non-2xx (o HubSpot re-entregaria o lote).
  for (const ev of parseNewMessageEvents(body)) {
    try {
      await processarEvento(supabase, ev)
    } catch (e) {
      console.error(
        'olivia-hubspot-webhook: erro processando evento',
        ev.threadId,
        e instanceof Error ? e.message : e,
      )
    }
  }

  return json({ received: true })
})
