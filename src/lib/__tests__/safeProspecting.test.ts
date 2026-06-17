import { describe, expect, it } from 'vitest'
import { SETORES } from '../setores'
import {
  buildSafeProspectingQueue,
  computeSafeDisparoPlan,
  GRANDE_SP_SAFE_PRESET,
  resolveMetaSafeDailyCap,
  SAFE_PROSPECTING_UI_PLACEMENT,
} from '../safeProspecting'

describe('Grande SP safe prospecting preset', () => {
  it('expands to every supported sector across every Greater Sao Paulo location', () => {
    const queue = buildSafeProspectingQueue()

    expect(queue).toHaveLength(SETORES.length * GRANDE_SP_SAFE_PRESET.locations.length)
    expect(new Set(queue.map((item) => item.setorLabel))).toEqual(new Set(SETORES))
    expect(queue.map((item) => item.params.local)).toContain('São Paulo, SP, Brasil')
    expect(queue.every((item) => item.params.max === GRANDE_SP_SAFE_PRESET.maxPerSearch)).toBe(true)
    expect(queue.every((item) => item.params.comSeguidores === false)).toBe(true)
  })

  it('keeps the approved UI placement and copy explicit about safe mode', () => {
    expect(SAFE_PROSPECTING_UI_PLACEMENT.page).toBe('Buscar')
    expect(SAFE_PROSPECTING_UI_PLACEMENT.after).toBe('SearchPanel')
    expect(GRANDE_SP_SAFE_PRESET.label).toBe('Grande SP + todos os setores + disparo seguro')
    expect(GRANDE_SP_SAFE_PRESET.description).toContain('não é garantia anti-ban')
  })
})

describe('Meta-safe disparo pacing', () => {
  it('uses conservative defaults when no existing cap is configured', () => {
    const cap = resolveMetaSafeDailyCap()

    expect(cap.dailyCap).toBe(40)
    expect(cap.source).toBe('default')
    expect(cap.dailyCap).toBeLessThanOrEqual(cap.hardCap)
  })

  it('clamps configured caps to the explicit hard cap', () => {
    const cap = resolveMetaSafeDailyCap({ configuredDailyCap: 500 })

    expect(cap.dailyCap).toBe(cap.hardCap)
    expect(cap.source).toBe('configured')
  })

  it('computes the safe batch from today usage and defers the rest', () => {
    const now = new Date('2026-06-15T15:00:00-03:00')
    const plan = computeSafeDisparoPlan({
      allLeads: [
        { id: 'sent-today', whatsapp_sent_at: '2026-06-15T10:00:00-03:00' },
        { id: 'sent-yesterday', whatsapp_sent_at: '2026-06-14T10:00:00-03:00' },
      ],
      selectedIds: ['a', 'b', 'c', 'd'],
      now,
      configuredDailyCap: 3,
    })

    expect(plan.dailyCap).toBe(3)
    expect(plan.sentToday).toBe(1)
    expect(plan.remainingToday).toBe(2)
    expect(plan.batchIds).toEqual(['a', 'b'])
    expect(plan.deferredIds).toEqual(['c', 'd'])
    expect(plan.batchDelayMs).toBeGreaterThan(0)
  })
})
