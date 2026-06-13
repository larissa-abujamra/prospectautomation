import { describe, it, expect } from 'vitest'
import {
  proporSlots,
  proporSlotsMulti,
  escolherRep,
  extrairIso,
  rotuloSlot,
  formatarPropostaSlots,
  slotEhValido,
  montarEventoCalendar,
  formatarConfirmacao,
  avaliarHorarioSugerido,
  formatarHorarioIndisponivel,
  formatarPedidoEmail,
  parseHorarioSugerido,
  slotsExpirados,
  SLOTS_TTL_MS,
  AGENDA_PADRAO,
  type AgendaConfig,
} from '../../../supabase/functions/_shared/olivia_agenda'

// Helpers de "relógio local" (UTC-3) pra asserir sem hard-codar ISO.
const OFFSET = -180
const localParts = (iso: string) => {
  const d = new Date(Date.parse(iso) + OFFSET * 60_000)
  return { dow: d.getUTCDay(), hora: d.getUTCHours(), min: d.getUTCMinutes(), dia: d.getUTCDate() }
}
const ms = (iso: string) => Date.parse(iso)

describe('proporSlots', () => {
  // Segunda, 08/06/2026, 12:00 em São Paulo (UTC-3) = 15:00Z.
  const segNoon = ms('2026-06-08T12:00:00-03:00')

  it('propõe maxSlots horários, em horário comercial e dia útil', () => {
    const slots = proporSlots(segNoon, [])
    expect(slots).toHaveLength(AGENDA_PADRAO.maxSlots)
    for (const s of slots) {
      const p = localParts(s)
      expect(p.dow).toBeGreaterThanOrEqual(1) // não-domingo
      expect(p.dow).toBeLessThanOrEqual(5) // não-sábado
      expect(p.hora).toBeGreaterThanOrEqual(AGENDA_PADRAO.horaInicio)
      expect(p.hora).toBeLessThan(AGENDA_PADRAO.horaFim)
    }
  })

  it('respeita a antecedência (não propõe nada cedo demais)', () => {
    const slots = proporSlots(segNoon, [])
    const minInicio = segNoon + AGENDA_PADRAO.antecedenciaMin * 60_000
    for (const s of slots) expect(ms(s)).toBeGreaterThanOrEqual(minInicio)
    // 12:00 + 120min = 14:00 local → primeiro slot é 14:00 seg.
    expect(localParts(slots[0])).toMatchObject({ hora: 14, min: 0 })
  })

  it('pula intervalos ocupados (free/busy)', () => {
    const busy = [{ startMs: ms('2026-06-08T14:00:00-03:00'), endMs: ms('2026-06-08T15:30:00-03:00') }]
    const slots = proporSlots(segNoon, busy)
    for (const s of slots) {
      const start = ms(s)
      const end = start + AGENDA_PADRAO.duracaoMin * 60_000
      const overlap = start < busy[0].endMs && end > busy[0].startMs
      expect(overlap).toBe(false)
    }
    // primeiro livre depois do busy: 15:30 local
    expect(localParts(slots[0])).toMatchObject({ hora: 15, min: 30 })
  })

  it('não deixa o slot ultrapassar o fim da janela', () => {
    // Sexta 17:40 local: só cabe um início até 17:30 (17:30+30=18:00). 17:40→não.
    const cfg: AgendaConfig = { ...AGENDA_PADRAO, antecedenciaMin: 0, maxSlots: 10 }
    const sexLate = ms('2026-06-12T17:40:00-03:00')
    const slots = proporSlots(sexLate, [], cfg)
    for (const s of slots) {
      const p = localParts(s)
      expect(p.hora * 60 + p.min + cfg.duracaoMin).toBeLessThanOrEqual(cfg.horaFim * 60)
    }
  })

  it('pula o fim de semana (sexta tarde → próximo é segunda)', () => {
    // Sexta 17:00 local: cabe só 17:00 e 17:30 na sexta; o resto vai pra segunda.
    const cfg: AgendaConfig = { ...AGENDA_PADRAO, antecedenciaMin: 0, maxSlots: 3 }
    const sex = ms('2026-06-12T17:00:00-03:00')
    const slots = proporSlots(sex, [], cfg)
    expect(localParts(slots[0]).dow).toBe(5) // sexta
    const ultimo = localParts(slots[slots.length - 1])
    expect(ultimo.dow).toBe(1) // segunda (pulou sáb/dom)
  })
})

describe('rotuloSlot', () => {
  it('formata em pt-BR no fuso local', () => {
    // 2026-06-09 é uma terça.
    expect(rotuloSlot('2026-06-09T17:00:00Z')).toBe('ter, 09/06 às 14:00')
  })
})

describe('formatarPropostaSlots', () => {
  it('numera os horários sem wording robótico e abre espaço pra sugestão do lead', () => {
    const msg = formatarPropostaSlots(['2026-06-09T17:00:00Z', '2026-06-09T17:30:00Z'])
    expect(msg).toContain('1) ter, 09/06 às 14:00')
    expect(msg).toContain('2) ter, 09/06 às 14:30')
    expect(msg).not.toMatch(/responder só o número/i)
    expect(msg).toMatch(/me fala um horário melhor/i)
  })
  it('lista vazia → fallback honesto (sem inventar horário)', () => {
    expect(formatarPropostaSlots([])).toMatch(/não achei/i)
  })
})

describe('slotEhValido (anti-invenção)', () => {
  const propostas = ['2026-06-09T17:00:00Z', '2026-06-09T17:30:00Z']
  it('aceita só horário exatamente proposto (tolerante a formato ISO)', () => {
    expect(slotEhValido('2026-06-09T17:00:00Z', propostas)).toBe(true)
    expect(slotEhValido('2026-06-09T14:00:00-03:00', propostas)).toBe(true) // mesmo instante
  })
  it('rejeita horário não proposto, vazio ou inválido', () => {
    expect(slotEhValido('2026-06-09T18:00:00Z', propostas)).toBe(false)
    expect(slotEhValido(null, propostas)).toBe(false)
    expect(slotEhValido('xpto', propostas)).toBe(false)
    expect(slotEhValido('2026-06-09T17:00:00Z', [])).toBe(false)
  })
})

describe('avaliarHorarioSugerido', () => {
  const agora = ms('2026-06-08T12:00:00-03:00')
  const ana = 'ana@innerai.com'
  const bruno = 'bruno@innerai.com'

  it('accepts a prospect-suggested business-hour slot when at least one rep is free', () => {
    const result = avaliarHorarioSugerido('2026-06-08T17:00:00Z', {
      [ana]: [{ startMs: ms('2026-06-08T14:00:00-03:00'), endMs: ms('2026-06-08T14:30:00-03:00') }],
      [bruno]: [],
    }, agora)

    expect(result).toEqual({
      ok: true,
      iso: '2026-06-08T17:00:00.000Z',
      reps: [bruno],
    })
  })

  it('rejects a prospect-suggested slot when nobody can take it and asks for another time', () => {
    const suggested = '2026-06-08T17:00:00Z'
    const result = avaliarHorarioSugerido(suggested, {
      [ana]: [{ startMs: ms('2026-06-08T14:00:00-03:00'), endMs: ms('2026-06-08T14:30:00-03:00') }],
      [bruno]: [{ startMs: ms('2026-06-08T14:00:00-03:00'), endMs: ms('2026-06-08T14:30:00-03:00') }],
    }, agora)

    expect(result.ok).toBe(false)
    expect(result.motivo).toBe('sem_rep_livre')
    expect(formatarHorarioIndisponivel(suggested)).toMatch(/outro horário/i)
  })
})

describe('parseHorarioSugerido', () => {
  const agora = ms('2026-06-13T16:00:00-03:00') // sábado

  it('entende dia da semana + hora em pt-BR', () => {
    const result = parseHorarioSugerido('segunda 15h', agora)
    expect(result).toEqual({ ok: true, iso: '2026-06-15T18:00:00.000Z' })
  })

  it('entende período aproximado em pt-BR', () => {
    const result = parseHorarioSugerido('terça de manhã', agora)
    expect(result).toEqual({ ok: true, iso: '2026-06-16T13:00:00.000Z' })
  })

  it('entende expressões simples em inglês', () => {
    const result = parseHorarioSugerido('tomorrow afternoon', agora)
    expect(result).toEqual({ ok: true, iso: '2026-06-14T18:00:00.000Z' })
  })

  it('pede mais detalhe quando falta dia ou período claro', () => {
    expect(parseHorarioSugerido('pode ser essa semana', agora).ok).toBe(false)
    expect(parseHorarioSugerido('15h', agora).ok).toBe(false)
  })
})

describe('proporSlotsMulti (time / multi-rep)', () => {
  const segNoon = ms('2026-06-08T12:00:00-03:00') // segunda 12h BRT
  const A = 'ana@innerai.com', B = 'bruno@innerai.com'

  it('propõe slots e lista os reps livres em cada um', () => {
    const slots = proporSlotsMulti(segNoon, { [A]: [], [B]: [] })
    expect(slots).toHaveLength(AGENDA_PADRAO.maxSlots)
    for (const s of slots) {
      expect(typeof s.iso).toBe('string')
      expect(s.reps.sort()).toEqual([A, B].sort())
    }
    expect(localParts(slots[0].iso)).toMatchObject({ hora: 14, min: 0 })
  })

  it('espalha opções em vez de pegar só os primeiros horários cronológicos', () => {
    const cfg: AgendaConfig = { ...AGENDA_PADRAO, antecedenciaMin: 0, maxSlots: 3 }
    const segMorning = ms('2026-06-08T07:00:00-03:00')
    const slots = proporSlotsMulti(segMorning, { [A]: [], [B]: [] }, cfg)
    const labels = slots.map((s) => localParts(s.iso))

    expect(labels).toEqual([
      expect.objectContaining({ dow: 1, hora: 9, min: 0 }),
      expect.objectContaining({ dow: 1, hora: 14, min: 0 }),
      expect.objectContaining({ dow: 2, hora: 10, min: 0 }),
    ])
  })

  it('inclui o slot se PELO MENOS UM rep está livre, listando só os livres', () => {
    // Ana ocupada 14:00–15:30; Bruno livre.
    const busy = { [A]: [{ startMs: ms('2026-06-08T14:00:00-03:00'), endMs: ms('2026-06-08T15:30:00-03:00') }], [B]: [] }
    const slots = proporSlotsMulti(segNoon, busy)
    // primeiro slot 14:00: só Bruno livre
    expect(slots[0].reps).toEqual([B])
    // um slot após 15:30 deve voltar a ter os dois
    const depois = slots.find((s) => localParts(s.iso).hora >= 16)
    if (depois) expect(depois.reps.sort()).toEqual([A, B].sort())
  })

  it('pula horários em que NINGUÉM está livre', () => {
    const busy = {
      [A]: [{ startMs: ms('2026-06-08T14:00:00-03:00'), endMs: ms('2026-06-08T14:30:00-03:00') }],
      [B]: [{ startMs: ms('2026-06-08T14:00:00-03:00'), endMs: ms('2026-06-08T14:30:00-03:00') }],
    }
    const slots = proporSlotsMulti(segNoon, busy)
    // 14:00 está totalmente ocupado → primeiro proposto é 14:30+
    expect(slots.every((s) => Date.parse(s.iso) !== ms('2026-06-08T14:00:00-03:00'))).toBe(true)
  })

  it('sem reps legíveis → sem slots (não inventa disponibilidade)', () => {
    expect(proporSlotsMulti(segNoon, {})).toEqual([])
  })

  it('primeiros dias 100% lotados pra todos → ainda enche maxSlots em dias seguintes', () => {
    // Ana e Bruno ocupados de agora até +2 dias inteiros.
    const buscaInteira = [{ startMs: segNoon, endMs: segNoon + 2 * 86_400_000 }]
    const slots = proporSlotsMulti(segNoon, { [A]: buscaInteira, [B]: buscaInteira })
    expect(slots).toHaveLength(AGENDA_PADRAO.maxSlots) // não starva
    // todos os slots caem DEPOIS do bloqueio de 2 dias
    for (const s of slots) expect(Date.parse(s.iso)).toBeGreaterThanOrEqual(segNoon + 2 * 86_400_000)
  })
})

describe('escolherRep', () => {
  it('escolhe um rep livre de forma estável por lead', () => {
    const reps = ['a@x.com', 'b@x.com', 'c@x.com']
    const r1 = escolherRep(reps, 'lead-1')
    expect(reps).toContain(r1)
    expect(escolherRep(reps, 'lead-1')).toBe(r1) // determinístico
  })
  it('sem reps → null', () => {
    expect(escolherRep([], 'lead-1')).toBeNull()
  })
})

describe('extrairIso', () => {
  it('aceita string ou {iso}', () => {
    expect(extrairIso('2026-06-09T17:00:00Z')).toBe('2026-06-09T17:00:00Z')
    expect(extrairIso({ iso: '2026-06-09T17:00:00Z', reps: ['a@x.com'] })).toBe('2026-06-09T17:00:00Z')
    expect(extrairIso(null)).toBeNull()
  })
})

describe('slotsExpirados', () => {
  const agora = ms('2026-06-10T12:00:00Z')
  it('dentro do TTL → não expirado', () => {
    expect(slotsExpirados('2026-06-10T11:00:00Z', agora)).toBe(false) // 1h atrás
    expect(slotsExpirados(new Date(agora - SLOTS_TTL_MS + 60_000).toISOString(), agora)).toBe(false)
  })
  it('além do TTL → expirado', () => {
    expect(slotsExpirados('2026-06-08T12:00:00Z', agora)).toBe(true) // 2 dias
    expect(slotsExpirados(new Date(agora - SLOTS_TTL_MS - 1000).toISOString(), agora)).toBe(true)
  })
  it('sem timestamp ou inválido → tratado como expirado (lado seguro)', () => {
    expect(slotsExpirados(null, agora)).toBe(true)
    expect(slotsExpirados(undefined, agora)).toBe(true)
    expect(slotsExpirados('xpto', agora)).toBe(true)
  })
})

describe('montarEventoCalendar', () => {
  const lead = {
    nome: 'Pietra Pâtisserie',
    dono_nome: 'Ana Carla',
    cidade: 'São Paulo',
    whatsapp_phone: '+5511963366136',
    whatsapp_dono: null,
  }
  it('monta evento com Google Meet e janela de duração correta', () => {
    const ev = montarEventoCalendar(lead, '2026-06-09T17:00:00Z', 'req-1')
    expect(ev.summary).toContain('Pietra Pâtisserie')
    expect(ev.start.dateTime).toBe('2026-06-09T17:00:00Z')
    expect(ev.end.dateTime).toBe('2026-06-09T17:30:00.000Z') // +30min
    expect(ev.start.timeZone).toBe('America/Sao_Paulo')
    expect(ev.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet')
    expect(ev.conferenceData.createRequest.requestId).toBe('req-1')
    expect(ev.description).toContain('Ana Carla')
    expect(ev.attendees).toBeUndefined() // sem attendees por padrão
  })

  it('convida o rep como attendee quando passado', () => {
    const ev = montarEventoCalendar(lead, '2026-06-09T17:00:00Z', 'req-1', { attendees: ['ana@innerai.com', 'invalido'] })
    expect(ev.attendees).toEqual([{ email: 'ana@innerai.com' }]) // só e-mails válidos
  })

  it('uses the client <> employee title and includes the prospect attendee email', () => {
    const ev = montarEventoCalendar(lead, '2026-06-09T17:00:00Z', 'req-1', {
      attendees: ['ana@innerai.com'],
      prospectEmail: 'cliente@example.com',
      repNome: 'Ana Inner',
    })

    expect(ev.summary).toBe('Ana Carla <> Ana Inner')
    expect(ev.attendees).toEqual([
      { email: 'ana@innerai.com' },
      { email: 'cliente@example.com' },
    ])
  })
})

describe('formatarConfirmacao', () => {
  it('inclui o link do Meet quando há', () => {
    const m = formatarConfirmacao('2026-06-09T17:00:00Z', 'https://meet.google.com/abc-defg-hij')
    expect(m).toContain('ter, 09/06 às 14:00')
    expect(m).toContain('meet.google.com/abc-defg-hij')
  })
  it('sem link, ainda confirma o horário', () => {
    const m = formatarConfirmacao('2026-06-09T17:00:00Z', null)
    expect(m).toContain('ter, 09/06 às 14:00')
    expect(m).not.toContain('Link')
  })

  it('asks for the email before finalizing a confirmed slot without prospect email', () => {
    const m = formatarPedidoEmail('2026-06-09T17:00:00Z')
    expect(m).toContain('ter, 09/06 às 14:00')
    expect(m).toMatch(/e-mail/i)
    expect(m).toMatch(/convite/i)
  })
})
