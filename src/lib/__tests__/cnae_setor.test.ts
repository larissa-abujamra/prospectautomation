import { describe, it, expect } from 'vitest'
import { setorParaCnae, sanitizarCnaePrefixos } from '../../../supabase/functions/_shared/cnae_setor'

describe('setorParaCnae', () => {
  it('mapeia famílias de alimentação/doces', () => {
    expect(setorParaCnae('doceria')).toEqual(['4721', '1091'])
    expect(setorParaCnae('Confeitaria')).toEqual(['4721', '1091'])
    expect(setorParaCnae('padaria artesanal')).toEqual(['4721', '1091'])
    expect(setorParaCnae('cafeteria')).toEqual(['5611'])
    expect(setorParaCnae('pizzaria')).toEqual(['5611', '5620'])
    expect(setorParaCnae('hamburgueria')).toEqual(['5611', '5620'])
  })
  it('mapeia outros setores', () => {
    expect(setorParaCnae('pet shop')).toEqual(['4789'])
    expect(setorParaCnae('academia')).toEqual(['9313'])
    expect(setorParaCnae('barbearia')).toEqual(['9602'])
    expect(setorParaCnae('salão de beleza')).toEqual(['9602'])
  })
  it('setor desconhecido ou vazio → [] (nunca varre tudo por engano)', () => {
    expect(setorParaCnae('consultoria jurídica')).toEqual([])
    expect(setorParaCnae('')).toEqual([])
    expect(setorParaCnae(null)).toEqual([])
  })
})

describe('sanitizarCnaePrefixos', () => {
  it('aceita array ou string, só dígitos, 2–7 chars, dedup', () => {
    expect(sanitizarCnaePrefixos(['4721', '10-91', 'x'])).toEqual(['4721', '1091'])
    expect(sanitizarCnaePrefixos('4721,5611,4721')).toEqual(['4721', '5611'])
    expect(sanitizarCnaePrefixos('1')).toEqual([]) // curto demais
    expect(sanitizarCnaePrefixos(null)).toEqual([])
  })
})
