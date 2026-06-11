// Agendamento da Olivia (Olivia Autônoma — Fase C).
// =============================================================================
// Partes PURAS (sem I/O) — unit-testadas no Vitest e usadas pela Edge Function
// `olivia-agendar`. Geram horários livres a partir do free/busy do Google
// Calendar, formatam a proposta em pt-BR, validam a escolha do lead e montam o
// corpo do evento (com Google Meet).
//
// FUSO: Brasil aboliu o horário de verão em 2019 — São Paulo é UTC-3 fixo. Por
// isso basta um offset constante (configurável) em vez de uma lib de timezone.
// Trabalhamos em ms (epoch) e ISO UTC; o "relógio local" é o UTC deslocado.
//
// ANTI-INVENÇÃO: só propomos horário comercial REALMENTE livre na agenda; só
// confirmamos um horário que foi proposto (slotEhValido). Nada fabricado.
// =============================================================================

export interface BusyInterval {
  startMs: number
  endMs: number
}

export interface AgendaConfig {
  offsetMin: number // -180 = UTC-3 (São Paulo)
  horaInicio: number // 9  → 09:00 local
  horaFim: number // 18 → último início cabe até 18:00 local
  duracaoMin: number // 30
  diasUteis: number // quantos dias úteis olhar à frente
  antecedenciaMin: number // não propor algo a menos de X min de agora
  passoMin: number // granularidade dos candidatos (ex.: 30)
  maxSlots: number // quantas opções oferecer
}

export const AGENDA_PADRAO: AgendaConfig = {
  offsetMin: -180,
  horaInicio: 9,
  horaFim: 18,
  duracaoMin: 30,
  diasUteis: 5,
  antecedenciaMin: 120,
  passoMin: 30,
  maxSlots: 3,
}

// Componentes do "relógio local" (UTC deslocado pelo offset).
function partesLocais(ms: number, offsetMin: number) {
  const d = new Date(ms + offsetMin * 60_000)
  return {
    ano: d.getUTCFullYear(),
    mes: d.getUTCMonth(), // 0-11
    dia: d.getUTCDate(),
    diaSemana: d.getUTCDay(), // 0=dom ... 6=sáb
    hora: d.getUTCHours(),
    min: d.getUTCMinutes(),
  }
}

// Constrói o ms UTC de um horário local (ano/mes/dia/hora/min no fuso offset).
function msDeLocal(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  min: number,
  offsetMin: number,
): number {
  return Date.UTC(ano, mes, dia, hora, min, 0) - offsetMin * 60_000
}

function ehFimDeSemana(diaSemana: number): boolean {
  return diaSemana === 0 || diaSemana === 6
}

function sobrepoe(aStart: number, aEnd: number, busy: BusyInterval[]): boolean {
  return busy.some((b) => aStart < b.endMs && aEnd > b.startMs)
}

/**
 * Gera até `maxSlots` horários de início livres (ISO UTC), em dias úteis dentro
 * da janela comercial, a partir de `agoraMs` (+ antecedência), pulando os
 * intervalos ocupados (`busy`). Determinístico — `agoraMs` é injetado.
 */
export function proporSlots(
  agoraMs: number,
  busy: BusyInterval[],
  cfg: AgendaConfig = AGENDA_PADRAO,
): string[] {
  const minInicio = agoraMs + cfg.antecedenciaMin * 60_000
  const dur = cfg.duracaoMin * 60_000
  const slots: string[] = []

  const base = partesLocais(agoraMs, cfg.offsetMin)
  for (let d = 0; d <= cfg.diasUteis && slots.length < cfg.maxSlots; d++) {
    // Dia local = hoje + d (meio-dia evita qualquer borda de DST/limite).
    const diaRef = partesLocais(
      msDeLocal(base.ano, base.mes, base.dia, 12, 0, cfg.offsetMin) + d * 86_400_000,
      cfg.offsetMin,
    )
    if (ehFimDeSemana(diaRef.diaSemana)) continue

    for (let h = cfg.horaInicio; h <= cfg.horaFim && slots.length < cfg.maxSlots; h++) {
      for (let m = 0; m < 60 && slots.length < cfg.maxSlots; m += cfg.passoMin) {
        const start = msDeLocal(diaRef.ano, diaRef.mes, diaRef.dia, h, m, cfg.offsetMin)
        const end = start + dur
        // Cabe na janela (fim do slot não passa de horaFim:00 local)?
        const fim = partesLocais(end, cfg.offsetMin)
        const passouJanela = fim.hora > cfg.horaFim || (fim.hora === cfg.horaFim && fim.min > 0)
        if (passouJanela) continue
        if (start < minInicio) continue
        if (sobrepoe(start, end, busy)) continue
        slots.push(new Date(start).toISOString())
      }
    }
  }
  return slots
}

// Gera os INÍCIOS candidatos (ms) em dias úteis, dentro da janela comercial e
// depois da antecedência — sem checar ocupação. Usado pelo single e pelo multi.
function candidatosSlots(agoraMs: number, cfg: AgendaConfig, limite: number): number[] {
  const minInicio = agoraMs + cfg.antecedenciaMin * 60_000
  const dur = cfg.duracaoMin * 60_000
  const out: number[] = []
  const base = partesLocais(agoraMs, cfg.offsetMin)
  for (let d = 0; d <= cfg.diasUteis && out.length < limite; d++) {
    const diaRef = partesLocais(
      msDeLocal(base.ano, base.mes, base.dia, 12, 0, cfg.offsetMin) + d * 86_400_000,
      cfg.offsetMin,
    )
    if (ehFimDeSemana(diaRef.diaSemana)) continue
    for (let h = cfg.horaInicio; h <= cfg.horaFim && out.length < limite; h++) {
      for (let m = 0; m < 60 && out.length < limite; m += cfg.passoMin) {
        const start = msDeLocal(diaRef.ano, diaRef.mes, diaRef.dia, h, m, cfg.offsetMin)
        const end = start + dur
        const fim = partesLocais(end, cfg.offsetMin)
        if (fim.hora > cfg.horaFim || (fim.hora === cfg.horaFim && fim.min > 0)) continue
        if (start < minInicio) continue
        out.push(start)
      }
    }
  }
  return out
}

// Um horário proposto + quais reps do time estão livres nele (calendar ids).
export interface SlotComReps {
  iso: string
  reps: string[]
}

/**
 * Multi-rep: dado o free/busy POR rep (calendarId → intervalos ocupados), propõe
 * até maxSlots horários em que PELO MENOS UM rep está livre, listando quais. O
 * confirmar escolhe um rep livre desse slot. Reps cujo calendário não pôde ser
 * lido simplesmente não aparecem em `busyByRep` (anti-invenção: não afirmamos
 * que alguém está livre sem ter lido a agenda dele).
 */
export function proporSlotsMulti(
  agoraMs: number,
  busyByRep: Record<string, BusyInterval[]>,
  cfg: AgendaConfig = AGENDA_PADRAO,
): SlotComReps[] {
  const reps = Object.keys(busyByRep)
  const dur = cfg.duracaoMin * 60_000
  // Gera TODOS os candidatos da janela (não trunca cedo): se os primeiros dias
  // estiverem lotados pra todos os reps, ainda achamos horários nos dias seguintes.
  // O teto real é o loop de dias (diasUteis) dentro de candidatosSlots.
  const porDia = Math.ceil(((cfg.horaFim - cfg.horaInicio + 1) * 60) / cfg.passoMin)
  const limiteJanela = (cfg.diasUteis + 2) * porDia + 8
  const candidatos = candidatosSlots(agoraMs, cfg, limiteJanela)
  const out: SlotComReps[] = []
  for (const start of candidatos) {
    if (out.length >= cfg.maxSlots) break
    const end = start + dur
    const livres = reps.filter((r) => !sobrepoe(start, end, busyByRep[r] || []))
    if (livres.length > 0) out.push({ iso: new Date(start).toISOString(), reps: livres })
  }
  return out
}

const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const DIAS_ABREV = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

const pad = (n: number) => String(n).padStart(2, '0')

/** "ter, 12/06 às 14:00" no fuso local. */
export function rotuloSlot(iso: string, offsetMin = AGENDA_PADRAO.offsetMin): string {
  const p = partesLocais(Date.parse(iso), offsetMin)
  return `${DIAS_ABREV[p.diaSemana]}, ${pad(p.dia)}/${pad(p.mes + 1)} às ${pad(p.hora)}:${pad(p.min)}`
}

/**
 * Mensagem de WhatsApp propondo os horários (numerados, pt-BR). Vazio → mensagem
 * de fallback (a Edge Function escala pra humano nesse caso).
 */
export function formatarPropostaSlots(slotsIso: string[], offsetMin = AGENDA_PADRAO.offsetMin): string {
  if (slotsIso.length === 0) return 'Não achei horários livres nos próximos dias.'
  const linhas = slotsIso.map((iso, i) => `${i + 1}) ${rotuloSlot(iso, offsetMin)}`)
  return [
    'Consigo esses horários pra uma conversa rápida (30 min, online):',
    ...linhas,
    'Qual fica melhor pra você? Pode responder só o número 🙂',
  ].join('\n')
}

// TTL padrão dos horários propostos: 24h. Depois disso, re-propõe (a agenda pode
// ter mudado e o lead pode estar pensando noutra lista).
export const SLOTS_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Slots propostos estão velhos? `propostosEmIso` é o olivia_slots_at do lead.
 * Sem timestamp (proposta antiga, pré-0013) → trata como expirado (re-propõe,
 * lado seguro). Determinístico: `agoraMs` é injetado.
 */
export function slotsExpirados(
  propostosEmIso: string | null | undefined,
  agoraMs: number,
  ttlMs = SLOTS_TTL_MS,
): boolean {
  if (!propostosEmIso) return true
  const t = Date.parse(propostosEmIso)
  if (Number.isNaN(t)) return true
  return agoraMs - t > ttlMs
}

/**
 * Valida que `escolhaIso` é EXATAMENTE um dos horários propostos (compara o
 * instante, tolerante a formatação de ISO). Anti-invenção: nunca marca um
 * horário que não foi oferecido.
 */
export function slotEhValido(escolhaIso: string | null | undefined, propostas: string[]): boolean {
  if (!escolhaIso) return false
  const t = Date.parse(escolhaIso)
  if (Number.isNaN(t)) return false
  return propostas.some((p) => Date.parse(p) === t)
}

export interface EventoLead {
  nome: string
  dono_nome: string | null
  cidade: string | null
  whatsapp_phone: string | null
  whatsapp_dono: string | null
}

export interface CalendarEvent {
  summary: string
  description: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  attendees?: Array<{ email: string }>
  conferenceData: {
    createRequest: { requestId: string; conferenceSolutionKey: { type: 'hangoutsMeet' } }
  }
  reminders: { useDefault: false; overrides: Array<{ method: 'popup' | 'email'; minutes: number }> }
}

export interface EventoOpts {
  attendees?: string[] // e-mails a convidar (ex.: o rep escolhido do time)
  cfg?: AgendaConfig
}

/**
 * Corpo do evento do Google Calendar (events.insert) com Google Meet. `requestId`
 * vem de fora (determinístico p/ idempotência — ex.: lead_id+slot), já que não
 * usamos Math.random aqui. timeZone IANA derivado do offset (-180 → Sao_Paulo).
 * `opts.attendees` convida o(s) rep(s) do time (aparece na agenda deles).
 */
export function montarEventoCalendar(
  lead: EventoLead,
  slotIso: string,
  requestId: string,
  opts: EventoOpts = {},
): CalendarEvent {
  const cfg = opts.cfg ?? AGENDA_PADRAO
  const start = Date.parse(slotIso)
  const fimIso = new Date(start + cfg.duracaoMin * 60_000).toISOString()
  const quem = lead.dono_nome?.trim() || lead.nome
  const tz = cfg.offsetMin === -180 ? 'America/Sao_Paulo' : 'UTC'
  const attendees = (opts.attendees ?? []).filter((e) => e && e.includes('@')).map((email) => ({ email }))
  const ev: CalendarEvent = {
    summary: `Squad × ${lead.nome}`,
    description: [
      `Conversa de apresentação da Squad com ${quem}` + (lead.cidade ? ` (${lead.cidade})` : ''),
      'Agendada automaticamente pela Olivia via WhatsApp.',
      lead.whatsapp_dono?.trim() || lead.whatsapp_phone
        ? `WhatsApp: ${lead.whatsapp_dono?.trim() || lead.whatsapp_phone}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    start: { dateTime: slotIso, timeZone: tz },
    end: { dateTime: fimIso, timeZone: tz },
    conferenceData: {
      createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 60 },
      ],
    },
  }
  if (attendees.length) ev.attendees = attendees
  return ev
}

// ISO de um slot, seja string (formato antigo) ou {iso, reps} (multi-rep).
export function extrairIso(slot: string | SlotComReps | null | undefined): string | null {
  if (!slot) return null
  return typeof slot === 'string' ? slot : slot.iso
}

// Hash estável de string → inteiro não-negativo (sem Math.random — determinístico).
function hashInt(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * Escolhe UM rep livre para o slot, distribuindo entre leads de forma estável
 * (hash do lead). Sem reps livres → null. Determinístico e testável.
 */
export function escolherRep(repsLivres: string[], chaveLead: string): string | null {
  if (!repsLivres || repsLivres.length === 0) return null
  return repsLivres[hashInt(chaveLead) % repsLivres.length]
}

/** Mensagem de confirmação pós-agendamento (com link do Meet). */
export function formatarConfirmacao(
  slotIso: string,
  meetLink: string | null,
  offsetMin = AGENDA_PADRAO.offsetMin,
): string {
  const quando = rotuloSlot(slotIso, offsetMin)
  const base = `Marcado! ${quando}. Vou te mandar um lembrete antes 🙂`
  return meetLink ? `${base}\nLink da call: ${meetLink}` : base
}
