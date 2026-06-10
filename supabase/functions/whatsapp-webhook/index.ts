// Edge Function: whatsapp-webhook
// =============================================================================
// Olivia Autônoma (Fase A): recebe os webhooks da Meta WhatsApp Cloud API —
// mensagens que o lead manda (inbound) e status de entrega dos envios
// (sent→delivered→read). Plano: .claude/plans/2026-06-10-olivia-autonoma.md
//
// SETUP (Meta App Dashboard → WhatsApp → Configuration → Webhook):
//   Callback URL:  https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook
//   Verify token:  o mesmo valor de WHATSAPP_WEBHOOK_VERIFY_TOKEN
//   Subscrever o campo "messages".
//
// Secrets:
//   supabase secrets set WHATSAPP_WEBHOOK_VERIFY_TOKEN=<aleatório longo>
//   supabase secrets set WHATSAPP_APP_SECRET=<App Secret do app Meta>
//
// DEPLOY: este endpoint é chamado pela META, não por usuário logado — precisa
// ir SEM verificação de JWT:
//   supabase functions deploy whatsapp-webhook --no-verify-jwt
// A segurança vem da assinatura HMAC (X-Hub-Signature-256) validada em TODO
// POST. Sem WHATSAPP_APP_SECRET configurado, nenhum payload é processado.
//
// Princípios: responde 200 rápido (a Meta re-entrega em não-2xx — não queremos
// tempestade de retry por payload podre); dedup por wamid; nunca regride status;
// mensagem de número desconhecido é guardada sem lead_id (anti-invenção: não
// vincula no chute). A Fase B (LLM respondedora) pluga AQUI depois.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  estadoAposResposta,
  inboundPhoneCandidates,
  parseWebhookEvents,
  shouldAdvanceSendStatus,
  verifyChallenge,
  verifyMetaSignature,
  type InboundMessage,
  type StatusUpdate,
} from '../_shared/whatsapp_webhook.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

type Supabase = ReturnType<typeof createClient>

// Status de entrega: acha o lead pelo wamid do envio e avança o send_status.
async function applyStatus(supabase: Supabase, ev: StatusUpdate): Promise<void> {
  const { data: lead } = await supabase
    .from('leads')
    .select('id, whatsapp_send_status')
    .eq('whatsapp_msg_id', ev.wamid)
    .maybeSingle()
  if (!lead) return // envio que não rastreamos (ex.: mandado fora da ferramenta)

  if (shouldAdvanceSendStatus(lead.whatsapp_send_status, ev.status)) {
    const { error } = await supabase
      .from('leads')
      .update({ whatsapp_send_status: ev.status })
      .eq('id', lead.id)
    if (error) {
      console.error('whatsapp-webhook: falha ao atualizar send_status', error.message)
    }
  }
}

// Mensagem do lead: grava na memória (dedup por wamid), vincula ao lead pelo
// número e marca replied/conversando.
async function applyMessage(supabase: Supabase, ev: InboundMessage): Promise<void> {
  // Casa o remetente com whatsapp_phone OU whatsapp_dono (variantes BR com/sem 9).
  const candidates = inboundPhoneCandidates(ev.from)
  let lead: { id: string; whatsapp_send_status: string | null; olivia_estado: string | null } | null = null
  if (candidates.length > 0) {
    const quoted = candidates.map((c) => `"${c}"`).join(',')
    const { data } = await supabase
      .from('leads')
      .select('id, whatsapp_send_status, olivia_estado')
      .or(`whatsapp_phone.in.(${quoted}),whatsapp_dono.in.(${quoted})`)
      .limit(1)
    lead = (data?.[0] as typeof lead) ?? null
  }

  // Dedup: a Meta re-entrega webhooks; wamid é unique → conflito = já processado.
  const { error: insErr, data: inserted } = await supabase
    .from('whatsapp_mensagens')
    .upsert(
      {
        lead_id: lead?.id ?? null,
        direcao: 'in',
        wamid: ev.wamid,
        tipo: ev.tipo,
        corpo: ev.corpo,
        enviada_em: ev.timestamp,
        raw: ev.raw,
      },
      { onConflict: 'wamid', ignoreDuplicates: true },
    )
    .select('id')
  if (insErr) {
    console.error('whatsapp-webhook: falha ao gravar mensagem', insErr.message)
    return
  }
  const isNew = (inserted?.length ?? 0) > 0
  if (!lead || !isNew) return // sem lead p/ atualizar, ou re-entrega já tratada

  const patch: Record<string, unknown> = {}
  if (shouldAdvanceSendStatus(lead.whatsapp_send_status, 'replied')) {
    patch.whatsapp_send_status = 'replied'
  }
  const novoEstado = estadoAposResposta(lead.olivia_estado)
  if (novoEstado && novoEstado !== lead.olivia_estado) {
    patch.olivia_estado = novoEstado
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from('leads').update(patch).eq('id', lead.id)
    if (error) {
      console.error('whatsapp-webhook: falha ao atualizar lead pós-resposta', error.message)
    }
  }

  // Fase B pluga aqui: enfileirar `olivia-responder` para este lead (com delay
  // de cadência humana). Por ora o time vê a resposta na Base de Dados.
}

Deno.serve(async (req) => {
  // --- GET: handshake de verificação da Meta (uma vez, no setup) ---
  if (req.method === 'GET') {
    const { ok, challenge } = verifyChallenge(
      new URL(req.url).searchParams,
      Deno.env.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    )
    return ok
      ? new Response(challenge, { status: 200 })
      : new Response('Forbidden', { status: 403 })
  }

  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  // --- POST: eventos. Assinatura HMAC obrigatória (endpoint público). ---
  // EXCEÇÃO DELIBERADA ao "sempre 200": sem o App Secret não dá pra validar
  // NADA — e responder 200 descartaria mensagens reais em silêncio. O 503 faz
  // a Meta re-entregar com backoff até o secret ser configurado (janela de
  // deploy/rotação), preservando os inbounds. Não é retry storm: o backoff da
  // Meta é gradual e o estado é transitório por definição.
  const appSecret = Deno.env.get('WHATSAPP_APP_SECRET')
  if (!appSecret) {
    console.error('whatsapp-webhook: WHATSAPP_APP_SECRET não configurado — payload recusado')
    return json({ error: 'Webhook não configurado.' }, 503)
  }

  const rawBody = await req.text()
  const signed = await verifyMetaSignature(
    appSecret,
    rawBody,
    req.headers.get('x-hub-signature-256'),
  )
  if (!signed) return json({ error: 'Assinatura inválida.' }, 401)

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

  // Processa tudo, mas NUNCA estoura: erro num evento não pode virar non-2xx
  // (a Meta re-entregaria o lote inteiro em loop).
  for (const ev of parseWebhookEvents(body)) {
    try {
      if (ev.kind === 'status') await applyStatus(supabase, ev)
      else await applyMessage(supabase, ev)
    } catch (e) {
      console.error(
        'whatsapp-webhook: erro processando evento',
        ev.kind,
        e instanceof Error ? e.message : e,
      )
    }
  }

  return json({ received: true })
})
