// Edge Function: olivia-remarcar  (chamada pelo APP, com usuário autenticado)
// =============================================================================
// Remarca uma reunião já agendada e dispara a mensagem da Olivia ao cliente.
// Três motivos:
//   - 'pedir'   : o time quer remarcar → cancela o evento, reabre o agendamento
//                 (estado 'agendando') e a Olivia pede um novo horário ao cliente.
//   - 'noshow'  : o cliente não compareceu → igual ao 'pedir', mas a mensagem é
//                 a de "não te encontrei na call, quer remarcar?".
//   - 'definir' : o time define um novo horário (novo_slot_iso) → MOVE o evento
//                 no Calendar e a Olivia confirma o novo horário ao cliente.
//
// Calendário SEMPRE em sincronia (full sync): cancela ('pedir'/'noshow') ou move
// ('definir') o evento real. A mensagem vai pela olivia-responder (modo remarcar),
// que reusa o LLM + o canal ativo.
//
// AUTH: usuário logado (app) — verify_jwt=true + requireAuthenticatedUser.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { deleteEvent, patchEventTime, getGoogleAccessToken, ownerCalendarId } from '../_shared/google_calendar.ts'
import { AGENDA_PADRAO, rotuloSlot } from '../_shared/olivia_agenda.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Dispara a mensagem da Olivia (modo remarcar) server-to-server.
async function mandarMensagem(
  motivo: 'pedir' | 'noshow' | 'definir',
  leadId: string,
  novoHorarioLabel: string | null,
): Promise<{ ok: boolean; erro: string | null }> {
  const url = Deno.env.get('SUPABASE_URL')
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!url || !secret) return { ok: false, erro: 'faltam SUPABASE_URL/OLIVIA_TRIGGER_SECRET' }
  try {
    const r = await fetch(`${url}/functions/v1/olivia-responder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
      body: JSON.stringify({ lead_id: leadId, remarcar: motivo, novo_horario_label: novoHorarioLabel }),
    })
    const d = await r.json().catch(() => ({}))
    if (r.ok && (d as { enviado?: boolean }).enviado) return { ok: true, erro: null }
    return { ok: false, erro: (d as { error?: string; erro_envio?: string; reason?: string }).error ?? (d as { erro_envio?: string }).erro_envio ?? (d as { reason?: string }).reason ?? `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Não autorizado.' }, 401)

  let leadId = ''
  let motivo: 'pedir' | 'noshow' | 'definir' = 'pedir'
  let novoSlotIso: string | null = null
  try {
    const b = await req.json()
    leadId = String(b.lead_id ?? '')
    const m = String(b.motivo ?? 'pedir')
    if (m !== 'pedir' && m !== 'noshow' && m !== 'definir') return json({ error: 'motivo inválido (pedir|noshow|definir).' }, 400)
    motivo = m
    novoSlotIso = b.novo_slot_iso ? String(b.novo_slot_iso) : null
    if (!leadId) return json({ error: 'Informe lead_id.' }, 400)
    if (motivo === 'definir' && !novoSlotIso) return json({ error: 'definir exige novo_slot_iso.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido.' }, 400)
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select('id, olivia_estado, reuniao_at, reuniao_calendar_event_id, olivia_assigned_rep_email')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  const token = await getGoogleAccessToken()
  const calIds = [lead.olivia_assigned_rep_email, ownerCalendarId()].filter(Boolean) as string[]
  const eventId = lead.reuniao_calendar_event_id as string | null

  if (motivo === 'definir') {
    const startMs = Date.parse(novoSlotIso!)
    if (Number.isNaN(startMs)) return json({ error: 'novo_slot_iso inválido.' }, 400)
    const endIso = new Date(startMs + AGENDA_PADRAO.duracaoMin * 60_000).toISOString()
    if (token && eventId) {
      const moved = await patchEventTime(token, eventId, calIds, novoSlotIso!, endIso)
      if (!moved.ok) return json({ error: 'Falha ao mover o evento no Calendar.', status: moved.status }, 502)
      await supabase.from('leads').update({
        reuniao_at: novoSlotIso,
        reuniao_link: moved.meetLink ?? moved.htmlLink,
        reuniao_calendar_link: moved.htmlLink,
        olivia_noshow_em: null, // re-arma o no-show pro novo horário
      }).eq('id', leadId)
    } else {
      // Sem token/evento: ao menos atualiza o horário no banco (sem mover evento).
      await supabase.from('leads').update({ reuniao_at: novoSlotIso, olivia_noshow_em: null }).eq('id', leadId)
    }
    const env = await mandarMensagem('definir', leadId, rotuloSlot(novoSlotIso!))
    return json({ ok: true, motivo, novo_slot: novoSlotIso, mensagem_enviada: env.ok, erro_mensagem: env.erro })
  }

  // 'pedir' | 'noshow': cancela o evento e REABRE o agendamento.
  let cancelStatus: number | null = null
  if (token && eventId) {
    const del = await deleteEvent(token, eventId, calIds)
    cancelStatus = del.status
  }
  await supabase.from('leads').update({
    olivia_estado: 'agendando',
    reuniao_at: null,
    reuniao_link: null,
    reuniao_calendar_event_id: null,
    reuniao_calendar_link: null,
    reuniao_calendar_title: null,
    olivia_slots: null,
    olivia_slots_at: null,
    olivia_pending_slot_iso: null,
    olivia_pending_rep_email: null,
    olivia_pending_rep_nome: null,
    olivia_assigned_rep_email: null,
    olivia_assigned_rep_nome: null,
    olivia_noshow_em: motivo === 'noshow' ? new Date().toISOString() : null,
  }).eq('id', leadId)

  const env = await mandarMensagem(motivo, leadId, null)
  return json({ ok: true, motivo, evento_cancelado: cancelStatus, mensagem_enviada: env.ok, erro_mensagem: env.erro })
})
