import { describe, it, expect } from 'vitest'
import {
  nomeSimilaridade,
  telefonesBatem,
  cnaeImplausivel,
  scoreCandidato,
} from '../../../supabase/functions/_shared/cnpj_match.ts'

describe('nomeSimilaridade', () => {
  it('nome forte → ~1 (ignora termos genéricos/jurídicos)', () => {
    expect(nomeSimilaridade('Padoca do Gael', 'PADOCA DO GAEL LTDA', null)).toBeGreaterThanOrEqual(0.9)
    expect(nomeSimilaridade('Selvvva', 'SELVVVA - PLANTAS E OBJETOS PARA DECORACAO LTDA', null)).toBeGreaterThanOrEqual(0.4)
  })
  it('nome sem nada em comum → ~0 (o caso Lellis→Banana Boat)', () => {
    expect(nomeSimilaridade('Lellis Trattoria', 'BANANA BOAT BAR E LANCHES LTDA', null)).toBeLessThan(0.2)
  })
  it('usa o melhor entre razão e fantasia', () => {
    expect(nomeSimilaridade('Chocolat du Jour', 'DU JOUR CHOCOLATE S.A.', 'Chocolat du Jour')).toBeGreaterThanOrEqual(0.9)
  })
})

describe('telefonesBatem', () => {
  it('mesmo número, formatações diferentes → true', () => {
    expect(telefonesBatem('(11) 3064-2727', '1130642727')).toBe(true)
    expect(telefonesBatem('+55 11 3064-2727', '551130642727')).toBe(true)
  })
  it('números diferentes → false', () => {
    expect(telefonesBatem('(11) 3064-2727', '1126597165')).toBe(false)
  })
  it('faltando → false', () => {
    expect(telefonesBatem(null, '1130642727')).toBe(false)
    expect(telefonesBatem('(11) 3064-2727', null)).toBe(false)
  })
})

describe('cnaeImplausivel', () => {
  it('detecta empresa de fachada/holding/assessoria', () => {
    expect(cnaeImplausivel('Apoio administrativo a empresas')).toBe(true)
    expect(cnaeImplausivel('Holdings de instituições não-financeiras')).toBe(true)
  })
  it('CNAE de varejo/alimentação é plausível', () => {
    expect(cnaeImplausivel('Comércio varejista de doces, balas, bombons e semelhantes')).toBe(false)
    expect(cnaeImplausivel('Restaurantes e similares')).toBe(false)
  })
})

describe('scoreCandidato (casos reais)', () => {
  const lead = (nome: string, telefone: string | null) => ({ nome, telefone })

  it('AUTO-ACEITE quando o telefone do Google bate com o da Receita', () => {
    const s = scoreCandidato(lead('Algum Nome Diferente', '(11) 3064-2727'), {
      razao_social: 'RAZAO SOCIAL QUALQUER LTDA', nome_fantasia: null, telefone: '1130642727', cnae: 'Restaurantes',
    })
    expect(s.phoneMatch).toBe(true)
    expect(s.decision).toBe('accept')
  })

  it('REJEITA "Lellis Trattoria" → "Banana Boat" (nome ~0, telefone não bate)', () => {
    const s = scoreCandidato(lead('Lellis Trattoria', '(11) 3064-2727'), {
      razao_social: 'BANANA BOAT BAR E LANCHES LTDA', nome_fantasia: null, telefone: '1199999999', cnae: 'Restaurantes',
    })
    expect(s.phoneMatch).toBe(false)
    expect(s.decision).toBe('reject')
  })

  it('REJEITA "Criminal Burguer" → assessoria/apoio administrativo', () => {
    const s = scoreCandidato(lead('Criminal Burguer', '(11) 2659-7165'), {
      razao_social: 'DONA HAMBURGUESAS ASSESSORIA E APOIO ADMINISTRATIVO LTDA', nome_fantasia: null,
      telefone: '1100000000', cnae: 'Apoio administrativo a empresas',
    })
    expect(s.cnaeBad).toBe(true)
    expect(s.decision).toBe('reject')
  })

  it('AUTO-ACEITE quando o nome é forte (Padoca do Gael)', () => {
    const s = scoreCandidato(lead('Padoca do Gael', null), {
      razao_social: 'PADOCA DO GAEL LTDA', nome_fantasia: null, telefone: null, cnae: 'Padaria e confeitaria',
    })
    expect(s.decision).toBe('accept')
  })

  it('mesma marca/grupo (Le Jazz) → aceita por cobertura de nome', () => {
    const s = scoreCandidato(lead('Le Jazz Brasserie', '(11) 2359-8141'), {
      razao_social: 'LE JAZZ BOULANGERIE BAR E RESTAURANTE LTDA', nome_fantasia: null,
      telefone: '1130000000', cnae: 'Restaurantes',
    })
    expect(s.decision).toBe('accept')
  })

  it('marca com matriz em outra cidade ainda aceita por nome forte (Padoca do Gael / Dourados)', () => {
    const s = scoreCandidato(
      { nome: 'Padoca do Gael', telefone: '(11) 4305-0320', cidade: 'São Paulo' },
      { razao_social: 'PADOCA DO GAEL LTDA', nome_fantasia: null, telefone: '6799915267', cnae: 'Fabricação de produtos de padaria', municipio: 'DOURADOS' },
    )
    expect(s.decision).toBe('accept')
  })

  it('1 token genérico + outra cidade NÃO auto-aceita homônimo (vai pro juiz, não accept)', () => {
    const s = scoreCandidato(
      { nome: 'Padaria Central', telefone: null, cidade: 'São Paulo' },
      { razao_social: 'CENTRAL COMERCIO DE PAES LTDA', nome_fantasia: null, telefone: null, cnae: 'Padaria', municipio: 'Fortaleza' },
    )
    expect(s.decision).not.toBe('accept')
  })

  it('zona ambígua (cobertura parcial, sem telefone) → judge', () => {
    const s = scoreCandidato(lead('Original Pinheiros', null), {
      razao_social: 'ORIGINAL COMERCIO DE BEBIDAS LTDA', nome_fantasia: null,
      telefone: null, cnae: 'Comércio de bebidas',
    })
    expect(s.decision).toBe('judge')
    expect(s.nameSim).toBeGreaterThanOrEqual(0.3)
    expect(s.nameSim).toBeLessThan(0.8)
  })
})
