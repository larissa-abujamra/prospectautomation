import { describe, it, expect } from 'vitest'
import { dentroDoHorario, proximaAbertura } from '../../../supabase/functions/_shared/olivia_horario'

// America/Sao_Paulo = UTC-3 (sem DST). Âncoras (confirmadas):
//   2026-06-10 = Qua, 2026-06-12 = Sex, 2026-06-13 = Sáb, 2026-06-14 = Dom.
// Defaults: seg–sex, 09:00–19:00 BRT.

describe('dentroDoHorario', () => {
  it('dia útil dentro da janela → true', () => {
    expect(dentroDoHorario('2026-06-10T15:00:00Z')).toBe(true) // Qua 12:00 BRT
    expect(dentroDoHorario('2026-06-10T12:00:00Z')).toBe(true) // Qua 09:00 BRT (borda de abertura)
  })
  it('antes de abrir / depois de fechar → false', () => {
    expect(dentroDoHorario('2026-06-10T06:00:00Z')).toBe(false) // Qua 03:00 BRT
    expect(dentroDoHorario('2026-06-10T11:59:00Z')).toBe(false) // Qua 08:59 BRT
    expect(dentroDoHorario('2026-06-10T22:00:00Z')).toBe(false) // Qua 19:00 BRT (fim exclusivo)
    expect(dentroDoHorario('2026-06-10T23:30:00Z')).toBe(false) // Qua 20:30 BRT
  })
  it('fim de semana → false mesmo no meio do dia', () => {
    expect(dentroDoHorario('2026-06-13T15:00:00Z')).toBe(false) // Sáb 12:00
    expect(dentroDoHorario('2026-06-14T15:00:00Z')).toBe(false) // Dom 12:00
  })
  it('iso inválido → false (não explode)', () => {
    expect(dentroDoHorario('lixo')).toBe(false)
  })
  it('respeita opts customizados', () => {
    // janela 8–22, inclui sábado
    expect(dentroDoHorario('2026-06-13T15:00:00Z', { dias: [1, 2, 3, 4, 5, 6], inicio: 8, fim: 22 })).toBe(true)
    expect(dentroDoHorario('2026-06-10T15:00:00Z', { tz: 'UTC' })).toBe(true) // 15:00 UTC ∈ [9,19)
    expect(dentroDoHorario('2026-06-10T20:00:00Z', { tz: 'UTC' })).toBe(false) // 20:00 UTC ≥ 19
  })
})

describe('proximaAbertura', () => {
  it('madrugada de dia útil → abertura do MESMO dia (09:00 BRT)', () => {
    const r = proximaAbertura('2026-06-10T06:00:00Z') // Qua 03:00 BRT
    expect(dentroDoHorario(r)).toBe(true)
    expect(r).toBe('2026-06-10T12:00:00.000Z') // Qua 09:00 BRT
  })
  it('depois de fechar numa sexta → segunda 09:00', () => {
    const r = proximaAbertura('2026-06-12T23:00:00Z') // Sex 20:00 BRT
    expect(dentroDoHorario(r)).toBe(true)
    // 2026-06-15 = segunda; 09:00 BRT = 12:00Z
    expect(r).toBe('2026-06-15T12:00:00.000Z')
  })
  it('sábado → segunda 09:00', () => {
    const r = proximaAbertura('2026-06-13T15:00:00Z') // Sáb 12:00
    expect(dentroDoHorario(r)).toBe(true)
    expect(r).toBe('2026-06-15T12:00:00.000Z')
  })
  it('resultado é sempre dentro do horário e no futuro', () => {
    for (const iso of ['2026-06-10T06:00:00Z', '2026-06-13T02:00:00Z', '2026-06-14T23:00:00Z']) {
      const r = proximaAbertura(iso)
      expect(dentroDoHorario(r)).toBe(true)
      expect(new Date(r).getTime()).toBeGreaterThan(new Date(iso).getTime())
    }
  })
})
