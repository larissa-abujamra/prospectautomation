import { describe, it, expect } from 'vitest'
import {
  buildReplyPacingPlan,
  pacingDelayMs,
  splitReplyParts,
} from '../../../supabase/functions/_shared/olivia_pacing'

// rand fixo em 0.5 → fator de jitter = 1 (sem variação), p/ asserts determinísticos.
const noJitter = { rand: () => 0.5 }

describe('pacingDelayMs', () => {
  it('respeita o piso (minMs) para texto curto/vazio', () => {
    expect(pacingDelayMs('', noJitter)).toBe(1800)
    expect(pacingDelayMs('oi', noJitter)).toBe(1800 + 2 * 28)
  })

  it('cresce com o tamanho do texto', () => {
    const curto = pacingDelayMs('a'.repeat(20), noJitter)
    const longo = pacingDelayMs('a'.repeat(120), noJitter)
    expect(longo).toBeGreaterThan(curto)
  })

  it('respeita o teto (maxMs) para texto longo', () => {
    expect(pacingDelayMs('a'.repeat(5000), noJitter)).toBe(12000)
  })

  it('nunca sai de [minMs, maxMs], mesmo com jitter nos extremos', () => {
    for (const rand of [() => 0, () => 0.999, () => 0.5]) {
      for (const len of [0, 5, 50, 500, 5000]) {
        const d = pacingDelayMs('x'.repeat(len), { rand })
        expect(d).toBeGreaterThanOrEqual(1800)
        expect(d).toBeLessThanOrEqual(12000)
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

  it('encurta mensagens urgentes/operacionais', () => {
    const normal = pacingDelayMs('Confirmado, vou te mandar o convite agora.', noJitter)
    const urgente = pacingDelayMs('Confirmado, vou te mandar o convite agora.', {
      ...noJitter,
      urgency: 'urgent',
    })

    expect(urgente).toBeLessThan(normal)
    expect(urgente).toBeLessThanOrEqual(3200)
  })

  it('zera em dry-run/teste para não atrasar verificação', () => {
    expect(pacingDelayMs('mensagem longa', { dryRun: true })).toBe(0)
    expect(pacingDelayMs('mensagem longa', { testMode: true })).toBe(0)
    expect(pacingDelayMs('mensagem longa', { disabled: true })).toBe(0)
  })
})

describe('splitReplyParts', () => {
  it('mantém uma resposta simples como uma única parte', () => {
    expect(splitReplyParts('Oi! Posso te mostrar os horários?')).toEqual([
      'Oi! Posso te mostrar os horários?',
    ])
  })

  it('divide apenas blocos separados por linha em branco quando multipart está ligado', () => {
    expect(splitReplyParts('Perfeito!\n\nTenho 10h ou 15h amanhã.', { multipart: true })).toEqual([
      'Perfeito!',
      'Tenho 10h ou 15h amanhã.',
    ])
  })
})

describe('buildReplyPacingPlan', () => {
  it('planeja pausa inicial curta para resposta curta', () => {
    const plano = buildReplyPacingPlan('Oi!', noJitter)

    expect(plano.parts).toEqual(['Oi!'])
    expect(plano.initialDelayMs).toBe(1800 + 3 * 28)
    expect(plano.betweenPartDelayMs).toEqual([])
  })

  it('planeja resposta longa com atraso limitado', () => {
    const plano = buildReplyPacingPlan('a'.repeat(1000), noJitter)

    expect(plano.initialDelayMs).toBe(12000)
    expect(plano.totalDelayMs).toBe(12000)
  })

  it('planeja pausas curtas entre respostas multipart', () => {
    const plano = buildReplyPacingPlan('Perfeito!\n\nTenho 10h ou 15h amanhã.', {
      ...noJitter,
      multipart: true,
    })

    expect(plano.parts).toEqual(['Perfeito!', 'Tenho 10h ou 15h amanhã.'])
    expect(plano.betweenPartDelayMs).toHaveLength(1)
    expect(plano.betweenPartDelayMs[0]).toBeGreaterThanOrEqual(900)
    expect(plano.betweenPartDelayMs[0]).toBeLessThanOrEqual(3200)
  })

  it('mantém mensagens urgentes e de sistema dentro de teto operacional', () => {
    const urgente = buildReplyPacingPlan('Convite enviado. Te vejo amanhã.', {
      ...noJitter,
      urgency: 'urgent',
    })
    const sistema = buildReplyPacingPlan('Reunião confirmada e convite criado.', {
      ...noJitter,
      urgency: 'system',
    })

    expect(urgente.totalDelayMs).toBeLessThanOrEqual(3200)
    expect(sistema.totalDelayMs).toBeLessThanOrEqual(1800)
  })

  it('não cria atraso em dry-run/teste mesmo com multipart', () => {
    const plano = buildReplyPacingPlan('A\n\nB', { dryRun: true, multipart: true })

    expect(plano.parts).toEqual(['A', 'B'])
    expect(plano.initialDelayMs).toBe(0)
    expect(plano.betweenPartDelayMs).toEqual([0])
    expect(plano.totalDelayMs).toBe(0)
  })
})
