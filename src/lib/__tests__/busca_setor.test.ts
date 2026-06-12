import { describe, it, expect } from 'vitest'
import {
  classificarSetor,
  ehFamiliaRestaurante,
  expandirTermosBusca,
  googleTypeDe,
  montarQuery,
  resolverLocal,
} from '../../../supabase/functions/_shared/busca_setor.ts'

describe('expandirTermosBusca (busca inteligente por setor)', () => {
  it('confeitaria expande para sinônimos do segmento (não só o nome literal)', () => {
    const termos = expandirTermosBusca('Confeitaria')
    expect(termos[0]).toBe('confeitaria')
    expect(termos).toContain('doceria')
    expect(termos.length).toBeLessThanOrEqual(3) // teto de custo: 1 chamada/termo
  })

  it('casa por substring normalizada (acento/caixa não importam)', () => {
    expect(expandirTermosBusca('CONFEITARIA')).toEqual(expandirTermosBusca('confeitaria'))
    expect(expandirTermosBusca('Salão de beleza')).toContain('cabeleireiro')
  })

  it('termo do usuário entra primeiro (respeita a intenção)', () => {
    const termos = expandirTermosBusca('Doceria')
    expect(termos[0]).toBe('doceria')
    expect(termos).toContain('confeitaria')
    expect(termos.length).toBeLessThanOrEqual(3)
  })

  it('setor desconhecido → só o próprio termo (nunca inventa segmento)', () => {
    expect(expandirTermosBusca('Loja de discos')).toEqual(['Loja de discos'])
  })

  it('"petiscaria" NÃO cai na família pet shop (match inequívoco)', () => {
    expect(expandirTermosBusca('Petiscaria')).toEqual(['Petiscaria'])
    expect(googleTypeDe('Petiscaria')).toBeNull()
    expect(expandirTermosBusca('Pet shop')).toContain('pet shop')
  })

  it('vazio → lista vazia', () => {
    expect(expandirTermosBusca('   ')).toEqual([])
  })
})

describe('googleTypeDe (viés de categoria do Places)', () => {
  it('mapeia famílias conhecidas', () => {
    expect(googleTypeDe('Confeitaria')).toBe('confectionery')
    expect(googleTypeDe('cafeteria')).toBe('cafe')
    expect(googleTypeDe('Pet shop')).toBe('pet_store')
    expect(googleTypeDe('Academia')).toBe('gym')
    expect(googleTypeDe('Pizzaria')).toBe('pizza_restaurant')
  })
  it('setor desconhecido → null (sem viés, sem chute)', () => {
    expect(googleTypeDe('Loja de discos')).toBeNull()
  })
})

describe('resolverLocal + montarQuery (local desambiguado)', () => {
  it('local do autocomplete tem precedência (já desambiguado)', () => {
    const loc = resolverLocal({ local: 'Alta Floresta, MT, Brasil', bairro: 'x', cidade: 'y' })
    expect(loc).toBe('Alta Floresta, MT, Brasil')
    expect(montarQuery('pizzaria', loc)).toBe('pizzaria em Alta Floresta, MT, Brasil')
  })
  it('fallback bairro + cidade quando não há local', () => {
    expect(resolverLocal({ bairro: 'Cambuí', cidade: 'Campinas' })).toBe('Cambuí, Campinas')
  })
  it('sem bairro → cidade inteira', () => {
    expect(resolverLocal({ cidade: 'Curitiba' })).toBe('Curitiba')
  })
  it('tudo vazio → default São Paulo (compatibilidade)', () => {
    expect(resolverLocal({})).toBe('São Paulo')
    expect(resolverLocal({ bairro: 'Pinheiros' })).toBe('Pinheiros, São Paulo')
  })
})

describe('classificarSetor / ehFamiliaRestaurante (movidos do buscar-negocios)', () => {
  it('classifica por tipo do Places primeiro, depois por nome', () => {
    expect(classificarSetor('Cantina X', 'pizza_restaurant')).toBe('Pizzaria')
    expect(classificarSetor('Smash Bros Burguer')).toBe('Hamburgueria')
    expect(classificarSetor('Cantina da Nonna')).toBe('Restaurante')
  })
  it('família restaurante detectada por substring', () => {
    expect(ehFamiliaRestaurante('restaurante')).toBe(true)
    expect(ehFamiliaRestaurante('Pizzaria')).toBe(true)
    expect(ehFamiliaRestaurante('Confeitaria')).toBe(false)
  })
})
