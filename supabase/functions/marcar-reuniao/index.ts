// Edge Function: marcar-reuniao
// =============================================================================
// Marca uma reunião MANUALMENTE num lead — pra quando o time agendou por fora
// (ex.: criou o convite do Google Meet à mão). Faz o que a olivia-agendar faz no
// 'confirmar', MENOS criar o evento no Calendar:
//   - grava reuniao_at / reuniao_link / prospect_email / rep no lead
//   - move olivia_estado='agendado' (o card vai pra coluna "Reunião agendada")
//   - reflete no HubSpot: estágio do deal → Reunião agendada + propriedades de reunião
// Chamada pelo app (usuário autenticado). Anti-invenção: campos vazios viram null.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  HUBSPOT_STAGE_REUNIAO_AGENDADA,
  queueHubspotDealStageSync,
  queueHubspotOliviaReportingSync,
} from '../_shared/hubspot.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const leadId = String(body.lead_id ?? '').trim()
  const reuniaoAt = String(body.reuniao_at ?? '').trim()
  if (!leadId) return json({ error: 'Informe lead_id.' }, 400)
  if (!reuniaoAt || Number.isNaN(Date.parse(reuniaoAt))) {
    return json({ error: 'Informe a data/hora da reunião (ISO válido).' }, 400)
  }
  const reuniaoLink = String(body.reuniao_link ?? '').trim() || null
  const prospectEmail = String(body.prospect_email ?? '').trim() || null
  const repEmail = String(body.rep_email ?? '').trim() || null
  const repNome = String(body.rep_nome ?? '').trim() || null

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select('id, nome, hubspot_contact_id, hubspot_deal_id, hubspot_responsavel_contact_id')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  const reuniaoIso = new Date(reuniaoAt).toISOString()
  const titulo = `Squad <> ${lead.nome}`
  const patch = {
    olivia_estado: 'agendado',
    reuniao_at: reuniaoIso,
    reuniao_link: reuniaoLink,
    prospect_email: prospectEmail,
    olivia_assigned_rep_email: repEmail,
    olivia_assigned_rep_nome: repNome,
    reuniao_calendar_title: titulo,
    status: 'interessado', // avança o funil — humano só entra na reunião
  }
  const { error: updErr } = await supabase.from('leads').update(patch).eq('id', leadId)
  if (updErr) return json({ error: `Falha ao gravar no lead: ${updErr.message}` }, 502)

  // Reflete no HubSpot (mesmos helpers da olivia-agendar). Fire-and-forget: falha
  // de sync não invalida o agendamento já gravado no banco.
  queueHubspotDealStageSync(lead.hubspot_deal_id, HUBSPOT_STAGE_REUNIAO_AGENDADA, 'marcar-reuniao')
  queueHubspotOliviaReportingSync(
    { contactId: lead.hubspot_responsavel_contact_id ?? lead.hubspot_contact_id, dealId: lead.hubspot_deal_id },
    { ...lead, ...patch },
    {
      reuniaoStatus: 'scheduled',
      reuniaoEm: reuniaoIso,
      reuniaoLink: reuniaoLink,
      reuniaoTitulo: titulo,
      innerResponsavelNome: repNome,
      innerResponsavelEmail: repEmail,
      prospectEmail: prospectEmail,
    },
    'marcar-reuniao',
  )

  return json({ ok: true, lead_id: leadId, reuniao_at: reuniaoIso })
})
