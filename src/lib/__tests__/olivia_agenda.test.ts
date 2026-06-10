import { describe, it, expect } from 'vitest'
import {
  proporSlots,
  rotuloSlot,
  formatarPropostaSlots,
  slotEhValido,
  montarEventoCalendar,
  formatarConfirmacao,
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
  it('numera os horários e pede o número', () => {
    const msg = formatarPropostaSlots(['2026-06-09T17:00:00Z', '2026-06-09T17:30:00Z'])
    expect(msg).toContain('1) ter, 09/06 às 14:00')
    expect(msg).toContain('2) ter, 09/06 às 14:30')
    expect(msg).toMatch(/número/i)
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
})
