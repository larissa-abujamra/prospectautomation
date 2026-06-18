// Helpers do Google Calendar reusados pelo reschedule/no-show (olivia-remarcar,
// olivia-noshow). A olivia-agendar tem os seus próprios (criação); aqui ficam os
// de cancelar e mover, pra não mexer no caminho de agendamento que já funciona.
//
// FUSO: São Paulo é UTC-3 fixo (sem horário de verão desde 2019).

const GCAL = 'https://www.googleapis.com/calendar/v3'

/** Troca o refresh token por access token (OAuth2 de usuário). null se faltar secret. */
export async function getGoogleAccessToken(): Promise<string | null> {
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

/** Calendário "dono" (conta OAuth da Olivia) — fallback quando o evento não está
 * na agenda do rep ou ela não é editável. */
export function ownerCalendarId(): string {
  return Deno.env.get('GOOGLE_CALENDAR_ID') ?? 'primary'
}

/**
 * Cancela (deleta) um evento. Tenta na agenda do rep; se 403/404, tenta na agenda
 * dona (onde o fallback de criação põe os eventos). Idempotente: 404/410 (já não
 * existe) conta como sucesso. Devolve { ok, status }.
 */
export async function deleteEvent(
  accessToken: string,
  eventId: string,
  calendarIds: string[],
): Promise<{ ok: boolean; status: number | null }> {
  const alvos = [...new Set(calendarIds.filter(Boolean))]
  let ultimoStatus: number | null = null
  for (const cal of alvos) {
    const resp = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    )
    ultimoStatus = resp.status
    if (resp.ok || resp.status === 404 || resp.status === 410) return { ok: true, status: resp.status }
  }
  return { ok: false, status: ultimoStatus }
}

/**
 * Move um evento (novo início/fim, ISO UTC), notificando os convidados
 * (sendUpdates=all). Tenta nas agendas dadas (rep, depois dona). Devolve
 * { ok, status, htmlLink, meetLink }.
 */
export async function patchEventTime(
  accessToken: string,
  eventId: string,
  calendarIds: string[],
  startIso: string,
  endIso: string,
): Promise<{ ok: boolean; status: number | null; htmlLink: string | null; meetLink: string | null }> {
  const alvos = [...new Set(calendarIds.filter(Boolean))]
  let ultimoStatus: number | null = null
  for (const cal of alvos) {
    const resp = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: { dateTime: startIso }, end: { dateTime: endIso } }),
      },
    )
    ultimoStatus = resp.status
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}))
      const meet =
        (data as any)?.hangoutLink ??
        (data as any)?.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri ??
        null
      return { ok: true, status: resp.status, htmlLink: (data as any)?.htmlLink ?? null, meetLink: meet }
    }
  }
  return { ok: false, status: ultimoStatus, htmlLink: null, meetLink: null }
}
