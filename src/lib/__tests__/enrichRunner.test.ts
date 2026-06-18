import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock o módulo de dados: enriquecerLead é I/O (Scrapingdog/OpenRouter custam $).
vi.mock('../leads', () => ({
  LEADS_KEY: ['leads'],
  enriquecerLead: vi.fn(),
}))

import { runEnrichment, precisaEnriquecer, __resetEnrichRunnerState } from '../enrichRunner'
import { enriquecerLead } from '../leads'
import type { Lead } from '../types'

const qc = { invalidateQueries: vi.fn() } as never

const lead = (over: Partial<Lead> = {}): Lead =>
  ({ id: 'l1', status: 'qualificado', enrich_status: null, ...over }) as Lead

beforeEach(() => {
  vi.clearAllMocks()
  __resetEnrichRunnerState()
})

describe('precisaEnriquecer', () => {
  it('só leads qualificados com cnpj pendente/vazio', () => {
    expect(precisaEnriquecer(lead())).toBe(true)
    expect(precisaEnriquecer(lead({ enrich_status: { cnpj: 'pending' } }))).toBe(true)
    expect(precisaEnriquecer(lead({ status: 'descoberto' }))).toBe(false)
    expect(precisaEnriquecer(lead({ enrich_status: { cnpj: 'ok' } }))).toBe(false)
    expect(precisaEnriquecer(lead({ enrich_status: { cnpj: 'missing' } }))).toBe(false)
  })
})

describe('runEnrichment — não entra em loop infinito quando o lead falha (502)', () => {
  it('limita as retentativas por sessão mesmo com re-disparos do caller', async () => {
    // enriquecerLead sempre falha (ex.: pipeline estoura o tempo → 502).
    ;(enriquecerLead as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('502'))

    // O caller (useEffect) re-dispara a cada invalidate/refetch. Simulamos 6 ciclos.
    for (let ciclo = 0; ciclo < 6; ciclo++) {
      await runEnrichment(['l1'], qc)
    }

    // Sem cap, seriam 6 chamadas (uma por ciclo) e cresceria sem fim. Com cap, o
    // lead que falha persistentemente para de ser re-enfileirado.
    const chamadas = (enriquecerLead as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(chamadas).toBeLessThanOrEqual(2) // 1ª tentativa + no máx. 1 retry
  })

  it('um lead que tem sucesso é tentado uma única vez', async () => {
    ;(enriquecerLead as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    for (let ciclo = 0; ciclo < 4; ciclo++) {
      await runEnrichment(['l2'], qc)
    }
    expect((enriquecerLead as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})
