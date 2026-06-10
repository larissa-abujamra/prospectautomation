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
    'Consigo esses horários pra uma conversa rápida (15 min, online):',
    ...linhas,
    'Qual fica melhor pra você? Pode responder só o número 🙂',
  ].join('\n')
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
  conferenceData: {
    createRequest: { requestId: string; conferenceSolutionKey: { type: 'hangoutsMeet' } }
  }
  reminders: { useDefault: false; overrides: Array<{ method: 'popup' | 'email'; minutes: number }> }
}

/**
 * Corpo do evento do Google Calendar (events.insert) com Google Meet. `requestId`
 * vem de fora (determinístico p/ idempotência — ex.: lead_id+slot), já que não
 * usamos Math.random aqui. timeZone IANA derivado do offset (-180 → Sao_Paulo).
 */
export function montarEventoCalendar(
  lead: EventoLead,
  slotIso: string,
  requestId: string,
  cfg: AgendaConfig = AGENDA_PADRAO,
): CalendarEvent {
  const start = Date.parse(slotIso)
  const fimIso = new Date(start + cfg.duracaoMin * 60_000).toISOString()
  const quem = lead.dono_nome?.trim() || lead.nome
  const tz = cfg.offsetMin === -180 ? 'America/Sao_Paulo' : 'UTC'
  return {
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
