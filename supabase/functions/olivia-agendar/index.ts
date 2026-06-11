// Edge Function: olivia-agendar
// =============================================================================
// Olivia Autônoma (Fase C): conversa com o Google Calendar. Dois modos:
//   { lead_id, modo: 'propor' }    → lê o free/busy do TIME e devolve 2–3 horários
//        em que pelo menos um rep está livre (guarda quais reps por slot).
//   { lead_id, modo: 'confirmar', slot_iso } → escolhe um rep livre desse horário,
//        cria o evento (com Google Meet) na agenda dele (convite/attendee), grava
//        reuniao_at/reuniao_link/olivia_estado='agendado', status do lead.
// Plano: .claude/plans/2026-06-10-olivia-autonoma.md
//
// TIME (multi-rep): OLIVIA_REPS = JSON [{ "nome": "...", "email": "x@innerai.com" }, ...]
//   Sem ele → usa só GOOGLE_CALENDAR_ID (default 'primary'). A conta OAuth precisa
//   ver o free/busy dos reps (padrão no Workspace) — quem não puder ser lido é
//   omitido (anti-invenção). Escrita: tenta a agenda do rep; sem acesso, cai pra
//   'primary' + rep como convidado (aparece na agenda dele do mesmo jeito).
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
  escolherRep,
  extrairIso,
  formatarConfirmacao,
  formatarPropostaSlots,
  montarEventoCalendar,
  proporSlotsMulti,
  slotEhValido,
  type BusyInterval,
  type SlotComReps,
} from '../_shared/olivia_agenda.ts'

// Reps do time (calendários a consultar). OLIVIA_REPS = JSON [{nome,email}].
// Sem config → usa só o calendário da conta (GOOGLE_CALENDAR_ID, default primary).
interface Rep { nome: string; email: string }
function getReps(): Rep[] {
  const raw = Deno.env.get('OLIVIA_REPS')
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      const reps = (Array.isArray(arr) ? arr : [])
        .map((r) => ({ nome: String(r?.nome ?? '').trim(), email: String(r?.email ?? '').trim().toLowerCase() }))
        .filter((r) => r.email.includes('@'))
      // dedupe por e-mail (e-mail duplicado enviesaria o round-robin do escolherRep)
      const vistos = new Set<string>()
      const unicos = reps.filter((r) => (vistos.has(r.email) ? false : (vistos.add(r.email), true)))
      if (unicos.length) return unicos
    } catch (e) {
      console.error('olivia-agendar: OLIVIA_REPS inválido (usando calendário único)', e instanceof Error ? e.message : e)
    }
  }
  const cal = Deno.env.get('GOOGLE_CALENDAR_ID') ?? 'primary'
  return [{ nome: '', email: cal }]
}

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

// Free/busy de VÁRIOS calendários numa só chamada. Devolve só os calendários
// lidos com sucesso (os com erro — sem acesso — são OMITIDOS; anti-invenção:
// não afirmamos disponibilidade de quem não conseguimos ler).
async function freeBusyMulti(
  accessToken: string,
  calendarIds: string[],
  timeMinMs: number,
  timeMaxMs: number,
): Promise<Record<string, BusyInterval[]>> {
  const resp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: new Date(timeMinMs).toISOString(),
      timeMax: new Date(timeMaxMs).toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error((data as any)?.error?.message ?? `freeBusy HTTP ${resp.status}`)
  const cals = (data as any)?.calendars ?? {}
  const out: Record<string, BusyInterval[]> = {}
  for (const id of calendarIds) {
    const c = cals[id]
    if (!c || (Array.isArray(c.errors) && c.errors.length)) {
      console.error('olivia-agendar: sem acesso ao free/busy de', id, JSON.stringify(c?.errors ?? 'ausente'))
      continue // calendário inacessível → não entra na disponibilidade
    }
    out[id] = (c.busy ?? []).map((b: { start: string; end: string }) => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) }))
  }
  return out
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
  if (!resp.ok) {
    const err = new Error((data as any)?.error?.message ?? `insert HTTP ${resp.status}`) as Error & { status?: number }
    err.status = resp.status
    throw err
  }
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
  const reps = getReps()
  const repEmails = reps.map((r) => r.email)

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

  // --- PROPOR: free/busy do TIME → slots c/ rep livre, guarda, devolve mensagem ---
  if (modo === 'propor') {
    let busyByRep: Record<string, BusyInterval[]> = {}
    const token = await getAccessToken()
    if (token) {
      const fim = agoraMs + (AGENDA_PADRAO.diasUteis + 2) * 86_400_000
      try {
        busyByRep = await freeBusyMulti(token, repEmails, agoraMs, fim)
      } catch (e) {
        console.error('olivia-agendar: freeBusy falhou', e instanceof Error ? e.message : e)
        return json({ error: 'Falha ao ler a agenda.' }, 502)
      }
      if (Object.keys(busyByRep).length === 0) {
        // Nenhum calendário do time pôde ser lido → não inventa disponibilidade.
        return json({ error: 'Nenhum calendário do time acessível.' }, 502)
      }
    } else if (!dryRun) {
      return json({ error: 'Google Calendar não configurado (GOOGLE_* secrets).' }, 503)
    } else {
      // dry-run sem token: simula todos os reps livres (valida a lógica de slots).
      busyByRep = Object.fromEntries(repEmails.map((e) => [e, []]))
    }
    const slots: SlotComReps[] = proporSlotsMulti(agoraMs, busyByRep, AGENDA_PADRAO)
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
      mensagem: formatarPropostaSlots(slots.map((s) => s.iso)),
      dry_run: dryRun && !token,
    })
  }

  // --- CONFIRMAR: valida a escolha e cria o evento na agenda do rep livre ---
  const propostas: (string | SlotComReps)[] = Array.isArray(lead.olivia_slots) ? lead.olivia_slots : []
  const isos = propostas.map((s) => extrairIso(s)).filter((x): x is string => !!x)
  if (!slotEhValido(slotIso, isos)) {
    // Anti-invenção: nunca marca horário que não foi oferecido.
    return json({ error: 'Horário não está entre os propostos.', propostas: isos }, 422)
  }

  // Idempotência: se já tem reunião marcada, não cria outra.
  if (lead.olivia_estado === 'agendado' || lead.reuniao_at) {
    return json({ modo, agendado: true, idempotente: true, reuniao_at: lead.reuniao_at })
  }

  // Qual rep está livre nesse slot? (do que foi proposto). Escolhe um, estável p/ lead.
  const slotEscolhido = propostas.find((s) => extrairIso(s) && Date.parse(extrairIso(s)!) === Date.parse(slotIso!))
  const repsLivres = (slotEscolhido && typeof slotEscolhido !== 'string' && Array.isArray(slotEscolhido.reps) && slotEscolhido.reps.length)
    ? slotEscolhido.reps
    : repEmails // fallback: slots antigos sem reps → qualquer rep
  const repEscolhido = escolherRep(repsLivres, leadId) ?? repEmails[0]
  const repNome = reps.find((r) => r.email === repEscolhido)?.nome || ''

  const requestId = `${leadId}-${Date.parse(slotIso!)}` // determinístico (idempotência da CONFERÊNCIA)
  // Convida o rep como participante (aparece na agenda dele mesmo sem delegação).
  const evento = montarEventoCalendar(lead, slotIso!, requestId, { attendees: [repEscolhido] })

  if (dryRun) {
    return json({ modo, dry_run: true, rep: repEscolhido, evento, mensagem: formatarConfirmacao(slotIso!, null) })
  }

  const token = await getAccessToken()
  if (!token) return json({ error: 'Google Calendar não configurado (GOOGLE_* secrets).' }, 503)

  // Trava CAS: marca 'agendado' SÓ se ainda não estava (1ª confirmação vence).
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
    return json({ modo, agendado: true, idempotente: true })
  }

  // Cria o evento NA AGENDA DO REP escolhido; se faltar acesso de escrita (403),
  // cai pra agenda da conta + rep como convidado (sempre aparece na dele).
  let result: InsertResult
  try {
    try {
      result = await insertEvent(token, repEscolhido, evento)
    } catch (e) {
      // Só cai pra primary se foi NEGAÇÃO DE ACESSO (403) à agenda do rep — não
      // por erro transitório. O insert que falhou não criou nada (throw é no !ok),
      // então o insert em primary é a única criação (sem double-book).
      const status = (e as { status?: number })?.status
      if (status === 403 && repEscolhido !== 'primary') {
        console.error('olivia-agendar: sem escrita na agenda do rep, caindo p/ primary + convite', repEscolhido)
        result = await insertEvent(token, 'primary', evento)
      } else { throw e }
    }
  } catch (e) {
    console.error('olivia-agendar: insert falhou', e instanceof Error ? e.message : e)
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
    rep: repEscolhido,
    rep_nome: repNome,
    aviso_divergencia: updErr ? 'evento criado mas estado não gravado' : null,
    reuniao_at: slotIso,
    meet: result.meetLink,
    mensagem: formatarConfirmacao(slotIso!, result.meetLink),
  })
})
