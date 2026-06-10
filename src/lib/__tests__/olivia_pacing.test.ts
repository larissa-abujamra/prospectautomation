import { describe, it, expect } from 'vitest'
import { pacingDelayMs } from '../../../supabase/functions/_shared/olivia_pacing'

// rand fixo em 0.5 → fator de jitter = 1 (sem variação), p/ asserts determinísticos.
const noJitter = { rand: () => 0.5 }

describe('pacingDelayMs', () => {
  it('respeita o piso (minMs) para texto curto/vazio', () => {
    expect(pacingDelayMs('', noJitter)).toBe(4000)
    expect(pacingDelayMs('oi', noJitter)).toBe(4000 + 2 * 45)
  })

  it('cresce com o tamanho do texto', () => {
    const curto = pacingDelayMs('a'.repeat(20), noJitter)
    const longo = pacingDelayMs('a'.repeat(120), noJitter)
    expect(longo).toBeGreaterThan(curto)
  })

  it('respeita o teto (maxMs) para texto longo', () => {
    expect(pacingDelayMs('a'.repeat(5000), noJitter)).toBe(22000)
  })

  it('nunca sai de [minMs, maxMs], mesmo com jitter nos extremos', () => {
    for (const rand of [() => 0, () => 0.999, () => 0.5]) {
      for (const len of [0, 5, 50, 500, 5000]) {
        const d = pacingDelayMs('x'.repeat(len), { rand })
        expect(d).toBeGreaterThanOrEqual(4000)
        expect(d).toBeLessThanOrEqual(22000)
      }
    }
  })

  it('jitter varia o resultado em torno da base', () => {
    const baixo = pacingDelayMs('a'.repeat(80), { rand: () => 0 })   // -25%
    const alto = pacingDelayMs('a'.repeat(80), { rand: () => 1 })    // +25%
    expect(alto).toBeGreaterThan(baixo)
  })

  it('parâmetros são configuráveis', () => {
    expect(pacingDelayMs('', { minMs: 1000, rand: () => 0.5 })).toBe(1000)
  })
})
