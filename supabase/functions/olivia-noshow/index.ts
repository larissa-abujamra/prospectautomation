// Edge Function: olivia-noshow  (cron)
// =============================================================================
// No-show automático: reuniões que JÁ passaram (grace de 2h) e ainda estão
// 'agendado' → assume que o cliente não compareceu, cancela o evento, REABRE o
// agendamento e a Olivia manda a mensagem de "não te encontrei, quer remarcar?".
// One-shot por reunião (olivia_noshow_em); re-arma ao remarcar.
//
// RISCO ACEITO: não dá pra saber se a call de fato aconteceu (não lemos presença
// no Meet). Quem fez a call deve mover o lead de 'agendado' (ex.: pra
// 'interessado') — aí ele sai desta seleção. Se ficar 'agendado', vira no-show.
//
// AUTH: só servidor/cron — OLIVIA_TRIGGER_SECRET. DRY-RUN por padrão.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { deleteEvent, getGoogleAccessToken, ownerCalendarId } from '../_shared/google_calendar.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const GRACE_HORAS = 2
const MAX_POR_RUN = 25

interface NoshowRow {
  id: string
  nome: string | null
  reuniao_at: string
  horas_desde_reuniao: number | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) return json({ error: 'Não autorizado.' }, 401)

  let dryRun = true
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object' && (b as { dry_run?: unknown }).dry_run === false) dryRun = false
  } catch { /* dry-run */ }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: reunioes, error } = await supabase.rpc('olivia_reunioes_noshow', { grace_horas: GRACE_HORAS, limite: MAX_POR_RUN })
  if (error) {
    console.error('olivia-noshow: falha na seleção (RPC)', error.message)
    return json({ error: 'Falha ao selecionar reuniões.' }, 502)
  }
  const lista = (reunioes ?? []) as NoshowRow[]

  if (dryRun) {
    return json({ dry_run: true, selecionados: lista.length, reunioes: lista.map((r) => ({ lead_id: r.id, nome: r.nome, reuniao_at: r.reuniao_at, horas_desde_reuniao: r.horas_desde_reuniao })) })
  }

  const token = await getGoogleAccessToken()
  let disparados = 0
  let pulados = 0
  const erros: { lead_id: string; erro: string }[] = []
  for (const r of lista) {
    try {
      // Campos pro cancelamento do evento (a RPC não traz; busca por lead).
      const { data: l } = await supabase
        .from('leads')
        .select('reuniao_calendar_event_id, olivia_assigned_rep_email')
        .eq('id', r.id)
        .single()
      if (token && l?.reuniao_calendar_event_id) {
        await deleteEvent(token, l.reuniao_calendar_event_id, [l.olivia_assigned_rep_email, ownerCalendarId()].filter(Boolean) as string[])
      }
      // Reabre + carimba one-shot (mesmo se a mensagem falhar, não re-dispara).
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
        olivia_noshow_em: new Date().toISOString(),
      }).eq('id', r.id)
      // Mensagem da Olivia (modo remarcar='noshow'). Pode pular se fora da 24h.
      const resp = await fetch(`${supabaseUrl}/functions/v1/olivia-responder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
        body: JSON.stringify({ lead_id: r.id, remarcar: 'noshow' }),
      })
      const d = await resp.json().catch(() => ({}))
      if (resp.ok && (d as { enviado?: boolean }).enviado) disparados++
      else if ((d as { skipped?: boolean }).skipped) pulados++
      else erros.push({ lead_id: r.id, erro: (d as { error?: string; reason?: string }).error ?? (d as { reason?: string }).reason ?? `HTTP ${resp.status}` })
    } catch (e) {
      erros.push({ lead_id: r.id, erro: e instanceof Error ? e.message : String(e) })
    }
  }

  return json({ dry_run: false, selecionados: lista.length, disparados, pulados, erros: erros.length, erros_detalhe: erros })
})
