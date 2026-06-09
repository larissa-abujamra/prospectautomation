import { describe, it, expect } from 'vitest'
import {
  situacaoAtiva,
  cidadeCompativel,
  gateCandidato,
} from '../../../supabase/functions/_shared/cnpj_match'

// Gates determinísticos ANTES do juiz (ISSUE P0-A). Provado em produção:
// os 3 matches de candidato único (conf=1, sem juiz) estavam TODOS errados —
// um deles era uma empresa BAIXADA. Esses sinais já vinham na resposta das
// fontes oficiais; agora são bloqueio explícito.

describe('situacaoAtiva', () => {
  it('reconhece ATIVA (qualquer caixa)', () => {
    expect(situacaoAtiva('ATIVA')).toBe(true)
    expect(situacaoAtiva('Ativa')).toBe(true)
  })

  it('reprova BAIXADA / SUSPENSA / INAPTA / NULA', () => {
    expect(situacaoAtiva('BAIXADA')).toBe(false)
    expect(situacaoAtiva('SUSPENSA')).toBe(false)
    expect(situacaoAtiva('INAPTA')).toBe(false)
    expect(situacaoAtiva('NULA')).toBe(false)
  })

  it('desconhecido (null/vazio) → null, não decide', () => {
    expect(situacaoAtiva(null)).toBeNull()
    expect(situacaoAtiva('')).toBeNull()
  })
})

describe('cidadeCompativel', () => {
  it('compara ignorando acento e caixa', () => {
    expect(cidadeCompativel('São Paulo', 'SAO PAULO')).toBe(true)
    expect(cidadeCompativel('SÃO PAULO', 'são paulo')).toBe(true)
  })

  it('cidade diferente → false', () => {
    expect(cidadeCompativel('São Paulo', 'Joinville')).toBe(false)
  })

  it('faltando um dos lados → null (deixa pro juiz)', () => {
    expect(cidadeCompativel(null, 'São Paulo')).toBeNull()
    expect(cidadeCompativel('São Paulo', null)).toBeNull()
  })
})

describe('gateCandidato', () => {
  const lead = { cidade: 'São Paulo' }

  it('reprova empresa não-ATIVA (caso real: MEI BAIXADA virou match da Margherita)', () => {
    const motivo = gateCandidato(lead, { situacao: 'BAIXADA', municipio: 'SAO PAULO' })
    expect(motivo).toMatch(/situa/i)
  })

  it('reprova município divergente', () => {
    const motivo = gateCandidato(lead, { situacao: 'ATIVA', municipio: 'JOINVILLE' })
    expect(motivo).toMatch(/munic/i)
  })

  it('aprova ATIVA na mesma cidade', () => {
    expect(gateCandidato(lead, { situacao: 'ATIVA', municipio: 'SAO PAULO' })).toBeNull()
  })

  it('dados desconhecidos passam (quem decide é o juiz)', () => {
    expect(gateCandidato(lead, { situacao: null, municipio: null })).toBeNull()
    expect(gateCandidato({ cidade: null }, { situacao: 'ATIVA', municipio: 'SAO PAULO' })).toBeNull()
  })
})
