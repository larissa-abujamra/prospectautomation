import { describe, it, expect } from 'vitest'
import { leadsDaBusca, selecionadosVisiveis } from '../oliviaSelecao'
import type { Lead } from '../types'

const lead = (over: Partial<Lead>): Lead =>
  ({ id: 'x', status: 'descoberto', google_place_id: null, ...over }) as Lead

describe('leadsDaBusca', () => {
  const leads = [
    lead({ id: 'a', status: 'descoberto', google_place_id: 'P1' }), // desta busca, fresco
    lead({ id: 'b', status: 'descoberto', google_place_id: 'P2' }), // desta busca, fresco
    lead({ id: 'c', status: 'descoberto', google_place_id: 'PX' }), // descoberto MAS de outra busca
    lead({ id: 'd', status: 'qualificado', google_place_id: 'P3' }), // desta busca, mas já processado
    lead({ id: 'e', status: 'descoberto', google_place_id: null }), // sem place_id
  ]

  it('mostra só os descoberto desta busca (nem todos do banco, nem os já processados)', () => {
    const r = leadsDaBusca(leads, ['P1', 'P2', 'P3'])
    expect(r.map((l) => l.id)).toEqual(['a', 'b']) // c (outra busca), d (qualificado), e (sem id) ficam de fora
  })

  it('busca sem resultados → lista vazia', () => {
    expect(leadsDaBusca(leads, [])).toEqual([])
  })

  it('aceita Set ou array de place_ids', () => {
    expect(leadsDaBusca(leads, new Set(['P1'])).map((l) => l.id)).toEqual(['a'])
  })
})

describe('selecionadosVisiveis', () => {
  const visiveis = [lead({ id: 'a' }), lead({ id: 'b' })]

  it('conta só os selecionados que estão na lista visível (nem mais, nem menos)', () => {
    // 'z' foi selecionado numa busca anterior e não está visível → não conta
    const sel = new Set(['a', 'z'])
    const r = selecionadosVisiveis(visiveis, sel)
    expect(r.map((l) => l.id)).toEqual(['a'])
    expect(r.length).toBe(1) // o botão "Processar N" mostraria 1, e processa 1
  })

  it('nada selecionado → vazio', () => {
    expect(selecionadosVisiveis(visiveis, new Set())).toEqual([])
  })
})
