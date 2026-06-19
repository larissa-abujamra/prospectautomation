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
  const livres: number[] = []

  const base = partesLocais(agoraMs, cfg.offsetMin)
  for (let d = 0; d <= cfg.diasUteis; d++) {
    // Dia local = hoje + d (meio-dia evita qualquer borda de DST/limite).
    const diaRef = partesLocais(
      msDeLocal(base.ano, base.mes, base.dia, 12, 0, cfg.offsetMin) + d * 86_400_000,
      cfg.offsetMin,
    )
    if (ehFimDeSemana(diaRef.diaSemana)) continue

    for (let h = cfg.horaInicio; h <= cfg.horaFim; h++) {
      for (let m = 0; m < 60; m += cfg.passoMin) {
        const start = msDeLocal(diaRef.ano, diaRef.mes, diaRef.dia, h, m, cfg.offsetMin)
        const end = start + dur
        // Cabe na janela (fim do slot não passa de horaFim:00 local)?
        const fim = partesLocais(end, cfg.offsetMin)
        const passouJanela = fim.hora > cfg.horaFim || (fim.hora === cfg.horaFim && fim.min > 0)
        if (passouJanela) continue
        if (start < minInicio) continue
        if (sobrepoe(start, end, busy)) continue
        livres.push(start)
      }
    }
  }
  return selecionarIniciosDistribuidos(livres, cfg).map((start) => new Date(start).toISOString())
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

function chaveDiaLocal(ms: number, offsetMin: number): string {
  const p = partesLocais(ms, offsetMin)
  return `${p.ano}-${String(p.mes + 1).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`
}

function minutoLocal(ms: number, offsetMin: number): number {
  const p = partesLocais(ms, offsetMin)
  return p.hora * 60 + p.min
}

function escolherMaisProximo(
  candidatos: number[],
  targetMin: number,
  cfg: AgendaConfig,
): number | null {
  if (candidatos.length === 0) return null
  return [...candidatos].sort((a, b) => {
    const dia = chaveDiaLocal(a, cfg.offsetMin).localeCompare(chaveDiaLocal(b, cfg.offsetMin))
    if (dia !== 0) return dia
    const dist = Math.abs(minutoLocal(a, cfg.offsetMin) - targetMin) - Math.abs(minutoLocal(b, cfg.offsetMin) - targetMin)
    if (dist !== 0) return dist
    return a - b
  })[0]
}

function selecionarIniciosDistribuidos(inicios: number[], cfg: AgendaConfig): number[] {
  const ordenados = [...inicios].sort((a, b) => a - b)
  if (ordenados.length <= cfg.maxSlots) return ordenados

  const escolhidos: number[] = []
  const add = (slot: number | null) => {
    if (slot !== null && !escolhidos.includes(slot) && escolhidos.length < cfg.maxSlots) {
      escolhidos.push(slot)
    }
  }

  const primeiro = ordenados[0]
  add(primeiro)

  const diaPrimeiro = chaveDiaLocal(primeiro, cfg.offsetMin)
  const duasHoras = 120 * 60_000
  const tarde = 14 * 60
  const manhaHumana = 10 * 60

  add(escolherMaisProximo(
    ordenados.filter((s) => chaveDiaLocal(s, cfg.offsetMin) === diaPrimeiro && s - primeiro >= duasHoras && minutoLocal(s, cfg.offsetMin) >= tarde),
    tarde,
    cfg,
  ))

  if (escolhidos.length < cfg.maxSlots) {
    add(escolherMaisProximo(
      ordenados.filter((s) => chaveDiaLocal(s, cfg.offsetMin) === diaPrimeiro && s - primeiro >= duasHoras),
      tarde,
      cfg,
    ))
  }

  add(escolherMaisProximo(
    ordenados.filter((s) => chaveDiaLocal(s, cfg.offsetMin) !== diaPrimeiro),
    manhaHumana,
    cfg,
  ))

  for (const slot of ordenados) add(slot)
  return escolhidos.sort((a, b) => a - b)
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
    const end = start + dur
    const livres = reps.filter((r) => !sobrepoe(start, end, busyByRep[r] || []))
    if (livres.length > 0) out.push({ iso: new Date(start).toISOString(), reps: livres })
  }
  const escolhidos = new Set(
    selecionarIniciosDistribuidos(out.map((slot) => Date.parse(slot.iso)), cfg)
      .map((start) => new Date(start).toISOString()),
  )
  return out.filter((slot) => escolhidos.has(slot.iso)).slice(0, cfg.maxSlots)
}

const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const DIAS_ABREV = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

const SEMANA_MS = 7 * 86_400_000

// Início (00:00 local) da segunda-feira da PRÓXIMA semana a partir de agoraMs.
function proximaSegundaMs(agoraMs: number, offsetMin: number): number {
  const p = partesLocais(agoraMs, offsetMin)
  const diasAteSeg = ((8 - p.diaSemana) % 7) || 7 // sempre cai na semana que vem
  return msDeLocal(p.ano, p.mes, p.dia, 0, 0, offsetMin) + diasAteSeg * 86_400_000
}

/**
 * Lê uma RESTRIÇÃO DE JANELA dita pelo lead ("semana que vem", "em duas
 * semanas", "mês que vem", "depois do dia 20", "depois de amanhã") e devolve o
 * INÍCIO (ms) a partir do qual a Olivia deve propor horários. null = sem
 * restrição de adiamento (propõe a partir de agora, comportamento padrão).
 *
 * Determinístico (anti-invenção): a data sai de regras, não de chute do LLM. O
 * LLM só repassa o texto do lead (resumo_disponibilidade); a conta é aqui.
 */
export function parseJanelaInicio(
  texto: string | null | undefined,
  agoraMs: number,
  cfg: AgendaConfig = AGENDA_PADRAO,
): number | null {
  if (!texto) return null
  const t = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos pra casar "mes"/"proxima"/"tres"
  const off = cfg.offsetMin

  // "em N semanas" / "daqui a N semanas" / "N semanas" / "semana que vem"
  const numPorExtenso: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4 }
  let semanas: number | null = null
  const mNum = t.match(/(\d+)\s*semanas?/)
  if (mNum) semanas = parseInt(mNum[1], 10)
  else {
    const mExt = t.match(/\b(um|uma|dois|duas|tres|quatro)\s+semanas?/)
    if (mExt) semanas = numPorExtenso[mExt[1]]
    else if (/semana\s+que\s+vem|proxima\s+semana|semana\s+proxima/.test(t)) semanas = 1
  }
  if (semanas != null && semanas >= 1) {
    return proximaSegundaMs(agoraMs, off) + (semanas - 1) * SEMANA_MS
  }

  // "mês que vem" / "próximo mês" → dia 1 do mês seguinte
  if (/mes\s+que\s+vem|proximo\s+mes/.test(t)) {
    const p = partesLocais(agoraMs, off)
    return msDeLocal(p.ano, p.mes + 1, 1, 0, 0, off)
  }

  // "depois do dia N" / "a partir do dia N" / "do dia N em diante"
  const mDia = t.match(/(?:depois do|a partir do|do)\s+dia\s+(\d{1,2})/)
  if (mDia) {
    const dia = parseInt(mDia[1], 10)
    if (dia >= 1 && dia <= 31) {
      const p = partesLocais(agoraMs, off)
      let ms = msDeLocal(p.ano, p.mes, dia, 0, 0, off)
      if (ms <= agoraMs) ms = msDeLocal(p.ano, p.mes + 1, dia, 0, 0, off) // já passou → mês que vem
      return ms
    }
  }

  // "depois de amanhã"
  if (/depois\s+de\s+amanha/.test(t)) {
    const p = partesLocais(agoraMs, off)
    return msDeLocal(p.ano, p.mes, p.dia, 0, 0, off) + 2 * 86_400_000
  }

  return null
}

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
    'Qual fica melhor pra você?',
    'Se nenhum desses funcionar, me fala um horário melhor pra você que eu checo aqui.',
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

export type HorarioSugeridoMotivo =
  | 'horario_invalido'
  | 'antecedencia'
  | 'fim_de_semana'
  | 'fora_horario'
  | 'sem_rep_livre'

export type HorarioSugeridoResultado =
  | { ok: true; iso: string; reps: string[] }
  | { ok: false; motivo: HorarioSugeridoMotivo; iso: string | null }

/**
 * Valida um horário sugerido pelo prospect contra a mesma janela comercial e
 * free/busy real usada nas propostas da Olivia. Se não couber, pedimos outro
 * horário em vez de forçar uma lista nova de slots da Olivia.
 */
export function avaliarHorarioSugerido(
  slotIso: string | null | undefined,
  busyByRep: Record<string, BusyInterval[]>,
  agoraMs: number,
  cfg: AgendaConfig = AGENDA_PADRAO,
): HorarioSugeridoResultado {
  const start = Date.parse(slotIso ?? '')
  if (Number.isNaN(start)) return { ok: false, motivo: 'horario_invalido', iso: null }

  const iso = new Date(start).toISOString()
  const minInicio = agoraMs + cfg.antecedenciaMin * 60_000
  if (start < minInicio) return { ok: false, motivo: 'antecedencia', iso }

  const local = partesLocais(start, cfg.offsetMin)
  if (ehFimDeSemana(local.diaSemana)) return { ok: false, motivo: 'fim_de_semana', iso }

  const end = start + cfg.duracaoMin * 60_000
  const fim = partesLocais(end, cfg.offsetMin)
  const foraJanela =
    local.hora < cfg.horaInicio ||
    local.hora > cfg.horaFim ||
    fim.hora > cfg.horaFim ||
    (fim.hora === cfg.horaFim && fim.min > 0)
  if (foraJanela) return { ok: false, motivo: 'fora_horario', iso }

  const livres = Object.entries(busyByRep)
    .filter(([, busy]) => !sobrepoe(start, end, busy || []))
    .map(([rep]) => rep)
  if (livres.length === 0) return { ok: false, motivo: 'sem_rep_livre', iso }

  return { ok: true, iso, reps: livres }
}

export function formatarHorarioIndisponivel(
  slotIso: string | null | undefined,
  offsetMin = AGENDA_PADRAO.offsetMin,
): string {
  const quando = slotIso && !Number.isNaN(Date.parse(slotIso))
    ? ` (${rotuloSlot(slotIso, offsetMin)})`
    : ''
  return `Esse horário${quando} não está livre pra gente. Você consegue me mandar outro horário que funcione pra você?`
}

export type ParseHorarioSugeridoMotivo = 'sem_texto' | 'sem_horario_claro'

export type ParseHorarioSugeridoResultado =
  | { ok: true; iso: string }
  | { ok: false; motivo: ParseHorarioSugeridoMotivo }

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function diaLocalSomado(agoraMs: number, dias: number, offsetMin: number) {
  const base = partesLocais(agoraMs, offsetMin)
  return partesLocais(
    msDeLocal(base.ano, base.mes, base.dia, 12, 0, offsetMin) + dias * 86_400_000,
    offsetMin,
  )
}

function proximoDiaSemana(
  agoraMs: number,
  diaSemana: number,
  hora: number,
  min: number,
  cfg: AgendaConfig,
): number {
  for (let d = 0; d <= 14; d++) {
    const dia = diaLocalSomado(agoraMs, d, cfg.offsetMin)
    if (dia.diaSemana !== diaSemana) continue
    const candidato = msDeLocal(dia.ano, dia.mes, dia.dia, hora, min, cfg.offsetMin)
    if (candidato >= agoraMs + cfg.antecedenciaMin * 60_000) return candidato
  }
  const fallback = diaLocalSomado(agoraMs, 7, cfg.offsetMin)
  return msDeLocal(fallback.ano, fallback.mes, fallback.dia, hora, min, cfg.offsetMin)
}

function extrairHoraSugerida(texto: string): { hora: number; min: number } | null {
  const pm = texto.match(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/)
  if (pm) {
    const base = Number(pm[1]) % 12
    return { hora: base + (pm[2] === 'pm' ? 12 : 0), min: 0 }
  }

  const exata = texto.match(/\b([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)?\b/)
  if (exata) return { hora: Number(exata[1]), min: Number(exata[2] ?? 0) }

  if (/\b(manha|morning)\b/.test(texto)) return { hora: 10, min: 0 }
  if (/\b(tarde|afternoon)\b/.test(texto)) return { hora: 15, min: 0 }
  if (/\b(noite|evening)\b/.test(texto)) return { hora: 17, min: 0 }
  return null
}

function extrairDiaSugerido(texto: string): { tipo: 'delta'; dias: number } | { tipo: 'weekday'; diaSemana: number } | null {
  if (/\b(depois de amanha|day after tomorrow)\b/.test(texto)) return { tipo: 'delta', dias: 2 }
  if (/\b(amanha|tomorrow)\b/.test(texto)) return { tipo: 'delta', dias: 1 }
  if (/\b(hoje|today)\b/.test(texto)) return { tipo: 'delta', dias: 0 }

  const dias: Array<[RegExp, number]> = [
    [/\b(seg|segunda|monday|mon)\b/, 1],
    [/\b(ter|terca|tuesday|tue)\b/, 2],
    [/\b(qua|quarta|wednesday|wed)\b/, 3],
    [/\b(qui|quinta|thursday|thu)\b/, 4],
    [/\b(sex|sexta|friday|fri)\b/, 5],
    [/\b(sab|sabado|saturday|sat)\b/, 6],
    [/\b(dom|domingo|sunday|sun)\b/, 0],
  ]
  const found = dias.find(([re]) => re.test(texto))
  return found ? { tipo: 'weekday', diaSemana: found[1] } : null
}

export function parseHorarioSugerido(
  texto: string | null | undefined,
  agoraMs: number,
  cfg: AgendaConfig = AGENDA_PADRAO,
): ParseHorarioSugeridoResultado {
  const normalizado = semAcento(texto?.trim() ?? '')
  if (!normalizado) return { ok: false, motivo: 'sem_texto' }

  const horario = extrairHoraSugerida(normalizado)
  if (!horario) return { ok: false, motivo: 'sem_horario_claro' }

  const dia = extrairDiaSugerido(normalizado)
  if (!dia) return { ok: false, motivo: 'sem_horario_claro' }

  let start: number
  if (dia?.tipo === 'delta') {
    const p = diaLocalSomado(agoraMs, dia.dias, cfg.offsetMin)
    start = msDeLocal(p.ano, p.mes, p.dia, horario.hora, horario.min, cfg.offsetMin)
  } else {
    start = proximoDiaSemana(agoraMs, dia.diaSemana, horario.hora, horario.min, cfg)
  }

  return { ok: true, iso: new Date(start).toISOString() }
}

export function formatarHorarioSugeridoAmbiguo(): string {
  return 'Consigo checar sim. Me manda um dia e horário mais certinho? Pode ser tipo "terça às 15h" ou "amanhã de tarde".'
}

export function formatarPedidoEmail(
  slotIso: string,
  offsetMin = AGENDA_PADRAO.offsetMin,
): string {
  // Pede o e-mail UMA vez e deixa claro que é OPCIONAL — se o lead não quiser dar,
  // a olivia-agendar marca assim mesmo e manda o link por aqui (não fica em loop).
  return `Boa, fica ${rotuloSlot(slotIso, offsetMin)} então! Qual o seu melhor e-mail pra eu te enviar o convite da agenda? Se preferir, te mando o link da call por aqui mesmo 🙂`
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
  prospectEmail?: string | null
  repNome?: string | null
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
  const attendeeEmails = [...(opts.attendees ?? []), opts.prospectEmail ?? '']
    .map((email) => email.trim())
    .filter((email) => email && email.includes('@'))
  const attendees = [...new Set(attendeeEmails)].map((email) => ({ email }))
  const repNome = opts.repNome?.trim()
  const ev: CalendarEvent = {
    summary: repNome ? `${quem} <> ${repNome}` : `Squad × ${lead.nome}`,
    description: [
      `Conversa de apresentação da Squad com ${quem}` + (lead.cidade ? ` (${lead.cidade})` : ''),
      'Agendada automaticamente pela Olivia via WhatsApp.',
      repNome ? `Inner AI: ${repNome}` : '',
      opts.prospectEmail?.trim() ? `Convite enviado para: ${opts.prospectEmail.trim()}` : '',
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

/**
 * Escolhe o rep livre com MENOS reuniões futuras (load balancing real, não só
 * hash). `loadByRep` = nº de reuniões futuras por e-mail (rep ausente = 0).
 * Empate no menor load → desempate determinístico por hash do lead (mesmo lead
 * → mesmo rep, estável e testável). Sem reps livres → null.
 */
export function escolherRepBalanceado(
  repsLivres: string[],
  loadByRep: Record<string, number>,
  chaveLead: string,
): string | null {
  if (!repsLivres || repsLivres.length === 0) return null
  const carga = (r: string) => loadByRep[r] ?? 0
  const minCarga = Math.min(...repsLivres.map(carga))
  const empatados = repsLivres.filter((r) => carga(r) === minCarga)
  return empatados[hashInt(chaveLead) % empatados.length]
}

/** Mensagem de confirmação pós-agendamento (com link do Meet). */
export function formatarConfirmacao(
  slotIso: string,
  meetLink: string | null,
  offsetMin = AGENDA_PADRAO.offsetMin,
  prospectEmail?: string | null,
): string {
  const quando = rotuloSlot(slotIso, offsetMin)
  const invite = prospectEmail?.trim()
    ? ` Enviei o convite para ${prospectEmail.trim()}.`
    : ''
  const base = `Marcado! ${quando}.${invite} Vou te mandar um lembrete antes 🙂`
  return meetLink ? `${base}\nLink da call: ${meetLink}` : base
}
