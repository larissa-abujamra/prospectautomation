// Edge Function: olivia-agendar
// =============================================================================
// Olivia Autônoma (Fase C): conversa com o Google Calendar. Dois modos:
//   { lead_id, modo: 'propor' }    → lê free/busy e devolve 2–3 horários livres
//   { lead_id, modo: 'confirmar', slot_iso } → cria o evento (com Google Meet),
//        grava reuniao_at/reuniao_link/olivia_estado='agendado', status do lead.
// Plano: .claude/plans/2026-06-10-olivia-autonoma.md
//
// É chamada SÓ pela olivia-responder (server-side) — exige OLIVIA_TRIGGER_SECRET
// (header x-olivia-secret). Deploy sem JWT:
//   supabase functions deploy olivia-agendar --no-verify-jwt
//
// GATED em credenciais do Google (como o webhook é gated no App Secret da Meta).
// Sem elas, devolve 503 com motivo claro — nada quebra silencioso.
// Secrets (OAuth de usuário p/ Gmail pessoal — refresh token não expira):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//   GOOGLE_CALENDAR_ID   (opcional; default 'primary')
//   OLIVIA_TRIGGER_SECRET
//   OLIVIA_DRY_RUN=false (p/ criar evento de verdade; default é dry-run)
//
// Setup do refresh token: ver supabase/README.md (fluxo OAuth de 1 vez).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  AGENDA_PADRAO,
  formatarConfirmacao,
  formatarPropostaSlots,
  montarEventoCalendar,
  proporSlots,
  slotEhValido,
  type BusyInterval,
} from '../_shared/olivia_agenda.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Troca o refresh token por um access token (OAuth2 do Google). Refresh tokens
// de OAuth de usuário não expiram (salvo revogação) — o access token vale ~1h.
async function getAccessToken(): Promise<string | null> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  const refreshToken = Deno.env.get('GOOGLE_REFRESH_TOKEN')
  if (!clientId || !clientSecret || !refreshToken) return null
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    const data = await resp.json().catch(() => ({}))
    return resp.ok ? ((data as { access_token?: string }).access_token ?? null) : null
  } catch {
    return null
  }
}

async function freeBusy(
  accessToken: string,
  calendarId: string,
  timeMinMs: number,
  timeMaxMs: number,
): Promise<BusyInterval[]> {
  const resp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: new Date(timeMinMs).toISOString(),
      timeMax: new Date(timeMaxMs).toISOString(),
      items: [{ id: calendarId }],
    }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error((data as any)?.error?.message ?? `freeBusy HTTP ${resp.status}`)
  const busy = (data as any)?.calendars?.[calendarId]?.busy ?? []
  return busy.map((b: { start: string; end: string }) => ({
    startMs: Date.parse(b.start),
    endMs: Date.parse(b.end),
  }))
}

interface InsertResult {
  htmlLink: string | null
  meetLink: string | null
  eventId: string | null
}

async function insertEvent(
  accessToken: string,
  calendarId: string,
  body: unknown,
): Promise<InsertResult> {
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
    `?conferenceDataVersion=1&sendUpdates=all`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error((data as any)?.error?.message ?? `insert HTTP ${resp.status}`)
  const meet =
    (data as any)?.hangoutLink ??
    (data as any)?.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri ??
    null
  return { htmlLink: (data as any)?.htmlLink ?? null, meetLink: meet, eventId: (data as any)?.id ?? null }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) {
    return json({ error: 'Não autorizado.' }, 401)
  }

  let leadId = ''
  let modo = ''
  let slotIso: string | null = null
  try {
    const b = await req.json()
    leadId = String(b.lead_id ?? '')
    modo = String(b.modo ?? '')
    slotIso = b.slot_iso ? String(b.slot_iso) : null
    if (!leadId || (modo !== 'propor' && modo !== 'confirmar')) {
      return json({ error: 'Informe lead_id e modo (propor|confirmar).' }, 400)
    }
  } catch {
    return json({ error: 'Corpo inválido.' }, 400)
  }

  const dryRun = Deno.env.get('OLIVIA_DRY_RUN') !== 'false'
  const calendarId = Deno.env.get('GOOGLE_CALENDAR_ID') ?? 'primary'

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select('id, nome, dono_nome, cidade, whatsapp_phone, whatsapp_dono, olivia_slots, olivia_estado, reuniao_at')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  const agoraMs = Date.parse(new Date().toISOString())

  // --- PROPOR: free/busy → slots livres, guarda no lead, devolve a mensagem ---
  if (modo === 'propor') {
    let busy: BusyInterval[] = []
    const token = await getAccessToken()
    if (token) {
      const fim = agoraMs + (AGENDA_PADRAO.diasUteis + 2) * 86_400_000
      try {
        busy = await freeBusy(token, calendarId, agoraMs, fim)
      } catch (e) {
        console.error('olivia-agendar: freeBusy falhou', e instanceof Error ? e.message : e)
        return json({ error: 'Falha ao ler a agenda.' }, 502)
      }
    } else if (!dryRun) {
      // Sem credenciais e não é dry-run → não dá pra agendar de verdade.
      return json({ error: 'Google Calendar não configurado (GOOGLE_* secrets).' }, 503)
    }
    // dry-run sem token: propõe sobre agenda vazia (valida a lógica de slots).
    const slots = proporSlots(agoraMs, busy)
    if (slots.length > 0) {
      const { error } = await supabase
        .from('leads')
        .update({ olivia_slots: slots, olivia_slots_at: new Date(agoraMs).toISOString() })
        .eq('id', leadId)
      if (error) console.error('olivia-agendar: falha ao gravar slots', error.message)
    }
    return json({
      modo,
      slots,
      mensagem: formatarPropostaSlots(slots),
      dry_run: dryRun && !token,
    })
  }

  // --- CONFIRMAR: valida a escolha contra os slots propostos e cria o evento ---
  const propostas: string[] = Array.isArray(lead.olivia_slots) ? lead.olivia_slots : []
  if (!slotEhValido(slotIso, propostas)) {
    // Anti-invenção: nunca marca horário que não foi oferecido.
    return json({ error: 'Horário não está entre os propostos.', propostas }, 422)
  }

  // Idempotência: se já tem reunião marcada, não cria outra (evita double-booking
  // em double-tap / re-trigger). events.insert NÃO é idempotente por requestId.
  if (lead.olivia_estado === 'agendado' || lead.reuniao_at) {
    return json({ modo, agendado: true, idempotente: true, reuniao_at: lead.reuniao_at })
  }

  const requestId = `${leadId}-${Date.parse(slotIso!)}` // determinístico (idempotência da CONFERÊNCIA)
  const evento = montarEventoCalendar(lead, slotIso!, requestId)

  if (dryRun) {
    return json({ modo, dry_run: true, evento, mensagem: formatarConfirmacao(slotIso!, null) })
  }

  const token = await getAccessToken()
  if (!token) return json({ error: 'Google Calendar não configurado (GOOGLE_* secrets).' }, 503)

  // Trava CAS: marca 'agendado' SÓ se ainda não estava — a primeira confirmação
  // concorrente vence; as outras saem sem inserir. Em falha de insert, desfazemos.
  const { data: claimed, error: claimErr } = await supabase
    .from('leads')
    .update({ olivia_estado: 'agendado' })
    .eq('id', leadId)
    .neq('olivia_estado', 'agendado')
    .select('id')
  if (claimErr) {
    console.error('olivia-agendar: falha no claim do agendamento', claimErr.message)
    return json({ error: 'Falha ao reservar o agendamento.' }, 502)
  }
  if (!claimed || claimed.length === 0) {
    // Outra confirmação já venceu a corrida → idempotente.
    return json({ modo, agendado: true, idempotente: true })
  }

  let result: InsertResult
  try {
    result = await insertEvent(token, calendarId, evento)
  } catch (e) {
    console.error('olivia-agendar: insert falhou', e instanceof Error ? e.message : e)
    // Desfaz o claim pra não travar o lead em 'agendado' sem evento.
    await supabase.from('leads').update({ olivia_estado: 'agendando' }).eq('id', leadId)
    return json({ error: 'Falha ao criar o evento.' }, 502)
  }

  const patch = {
    reuniao_at: slotIso,
    reuniao_link: result.meetLink ?? result.htmlLink,
    olivia_estado: 'agendado',
    status: 'interessado', // avança o funil — humano só entra na reunião
  }
  const { error: updErr } = await supabase.from('leads').update(patch).eq('id', leadId)
  // DIVERGÊNCIA: evento criado no Calendar mas o lead não gravou reuniao_at/link.
  // É grave (Calendar × DB fora de sincronia) — loga ALTO e sinaliza na resposta
  // pra quem chamou (olivia-responder) tratar como handoff, não como sucesso limpo.
  if (updErr) {
    console.error(
      'olivia-agendar: EVENTO CRIADO mas FALHOU ao gravar no lead (divergência!)',
      leadId,
      result.eventId,
      updErr.message,
    )
  }

  return json({
    modo,
    agendado: true,
    aviso_divergencia: updErr ? 'evento criado mas estado não gravado' : null,
    reuniao_at: slotIso,
    meet: result.meetLink,
    mensagem: formatarConfirmacao(slotIso!, result.meetLink),
  })
})
