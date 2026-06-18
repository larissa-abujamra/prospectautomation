import { describe, it, expect } from 'vitest'
import {
  UFS,
  ehUF,
  GRANDE_SP,
  GRANDE_RIO,
  parseMunicipiosIBGE,
  municipiosMetro,
  IBGE_MUNICIPIOS_URL,
} from '../../../supabase/functions/_shared/ibge'

describe('UFS / ehUF', () => {
  it('tem as 27 unidades federativas', () => {
    expect(UFS).toHaveLength(27)
    expect(UFS.find((u) => u.sigla === 'SP')?.nome).toBe('São Paulo')
  })
  it('ehUF reconhece sigla válida (case-insensitive) e rejeita o resto', () => {
    expect(ehUF('SP')).toBe(true)
    expect(ehUF('rj')).toBe(true)
    expect(ehUF('grande_sp')).toBe(false)
    expect(ehUF('XX')).toBe(false)
  })
})

describe('listas metropolitanas curadas', () => {
  it('Grande SP tem 39 municípios únicos, incluindo a capital', () => {
    expect(GRANDE_SP).toContain('São Paulo')
    expect(GRANDE_SP).toHaveLength(39)
    expect(new Set(GRANDE_SP).size).toBe(39)
  })
  it('Grande Rio tem 22 municípios únicos, incluindo a capital', () => {
    expect(GRANDE_RIO).toContain('Rio de Janeiro')
    expect(GRANDE_RIO).toHaveLength(22)
    expect(new Set(GRANDE_RIO).size).toBe(22)
  })
})

describe('municipiosMetro', () => {
  it('expande grande_sp/grande_rio com UF anexada', () => {
    const sp = municipiosMetro('grande_sp')
    expect(sp[0]).toEqual({ local: 'São Paulo, SP', uf: 'SP' })
    expect(sp).toHaveLength(39)
    const rio = municipiosMetro('grande_rio')
    expect(rio[0]).toEqual({ local: 'Rio de Janeiro, RJ', uf: 'RJ' })
    expect(municipiosMetro('inexistente')).toEqual([])
  })
})

describe('parseMunicipiosIBGE', () => {
  it('extrai nomes e anexa a UF, dedupando', () => {
    const data = [{ nome: 'Campinas' }, { nome: 'Santos' }, { nome: 'Campinas' }, { id: 1 }]
    const out = parseMunicipiosIBGE(data, 'SP')
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ local: 'Campinas, SP', uf: 'SP' })
  })
  it('entrada inválida → vazio (sem throw)', () => {
    expect(parseMunicipiosIBGE(null, 'SP')).toEqual([])
    expect(parseMunicipiosIBGE({}, 'SP')).toEqual([])
  })
})

describe('IBGE_MUNICIPIOS_URL', () => {
  it('monta a URL da API do IBGE por UF', () => {
    expect(IBGE_MUNICIPIOS_URL('SP')).toContain('/estados/SP/municipios')
  })
})
