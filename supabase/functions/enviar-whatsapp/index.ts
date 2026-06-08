// Edge Function: enviar-whatsapp
// =============================================================================
// Módulo WhatsApp (Parte D): dispara o template aprovado para UM lead via a
// Meta WhatsApp Cloud API, escolhendo _f/_m pelo gênero do nome. Roda no servidor
// (Deno). As chaves NUNCA vão pro frontend — são secrets:
//   supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...   (id do número Olivia-Squad na Cloud API)
//   supabase secrets set WHATSAPP_ACCESS_TOKEN=...       (System User token c/ whatsapp_business_messaging)
//   supabase secrets set WHATSAPP_TEMPLATE_LANG=pt_BR    (opcional; deve casar com o idioma registrado do template)
//   supabase secrets set WHATSAPP_DAILY_CAP=20           (opcional; warm-up do número novo)
//   supabase secrets set WHATSAPP_GRAPH_VERSION=v21.0    (opcional)
//
// POR QUE MÉTA DIRETO E NÃO HUBSPOT: a API de automação do HubSpot está bloqueada
// por escopo neste portal (automation → 403), e a ação "Send WhatsApp" não é
// especificável via API pública. A Cloud API é a fonte real do WABA; o HubSpot
// segue como CRM (contato sincronizado) e recebe as respostas no inbox.
//
// SEGURANÇA: começa em DRY-RUN se faltar secret — monta e devolve o payload exato
// SEM enviar, para validar tudo antes do disparo real. Respeita um teto diário
// (warm-up). ANTI-INVENÇÃO: só envia lead mensageável; nada fabricado.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  buildTemplatePayload,
  parseSendResult,
  sendBlockReason,
  templateForGenero,
} from '../_shared/whatsapp_send.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
  const langCode = Deno.env.get('WHATSAPP_TEMPLATE_LANG') ?? 'pt_BR'
  const graphVersion = Deno.env.get('WHATSAPP_GRAPH_VERSION') ?? 'v21.0'
  const dailyCap = Number(Deno.env.get('WHATSAPP_DAILY_CAP') ?? '20')

  let leadId: string
  let dryRunReq = false
  try {
    const body = await req.json()
    leadId = String(body.lead_id ?? '')
    dryRunReq = Boolean(body.dry_run)
    if (!leadId) return json({ error: 'Informe lead_id.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  // Sem credenciais → dry-run forçado (valida sem enviar). Ou dry_run explícito.
  const dryRun = dryRunReq || !phoneNumberId || !accessToken

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select('id, nome, cidade, whatsapp_phone, whatsapp_status, nome_genero, whatsapp_send_status')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // Trava de mensageabilidade (anti-invenção).
  const blocked = sendBlockReason(lead)
  if (blocked) return json({ error: `Lead não enviável: ${blocked}` }, 422)

  // Idempotência leve: não re-enviar quem já recebeu (salvo falha anterior).
  if (lead.whatsapp_send_status === 'sent' || lead.whatsapp_send_status === 'delivered' ||
      lead.whatsapp_send_status === 'read' || lead.whatsapp_send_status === 'replied') {
    return json({ skipped: true, reason: 'já enviado', whatsapp_send_status: lead.whatsapp_send_status })
  }

  const payload = buildTemplatePayload(lead, langCode)
  const template = templateForGenero(lead.nome_genero)

  // --- DRY-RUN: valida e devolve o payload exato, sem enviar ---
  if (dryRun) {
    return json({
      dry_run: true,
      reason: !phoneNumberId || !accessToken ? 'faltam secrets WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN' : 'dry_run solicitado',
      template,
      language: langCode,
      endpoint: `https://graph.facebook.com/${graphVersion}/${phoneNumberId ?? '{PHONE_NUMBER_ID}'}/messages`,
      payload,
    })
  }

  // --- Warm-up: teto de envios nas últimas 24h ---
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .gte('whatsapp_sent_at', since)
    .in('whatsapp_send_status', ['sent', 'delivered', 'read', 'replied'])
  if ((count ?? 0) >= dailyCap) {
    return json({ error: `Teto diário atingido (${count}/${dailyCap}) — warm-up do número.` }, 429)
  }

  // --- Envio real via Cloud API ---
  try {
    const resp = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await resp.json().catch(() => ({}))
    const result = parseSendResult(resp.status, data)

    const patch: Record<string, unknown> = { whatsapp_send_status: result.status }
    if (result.status === 'sent') {
      patch.whatsapp_sent_at = new Date().toISOString()
      patch.whatsapp_msg_id = result.messageId
    }
    await supabase.from('leads').update(patch).eq('id', leadId)

    const httpOut = result.status === 'sent' ? 200 : 502
    return json(
      { status: result.status, messageId: result.messageId, errorCode: result.errorCode, errorMessage: result.errorMessage, template },
      httpOut,
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Erro desconhecido'
    await supabase.from('leads').update({ whatsapp_send_status: 'failed' }).eq('id', leadId)
    return json({ status: 'failed', error: message }, 502)
  }
})
