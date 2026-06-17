import { describe, it, expect } from 'vitest'
import {
  classificarSetor,
  ehFamiliaRestaurante,
  expandirPlanosBusca,
  expandirTermosBusca,
  googleTypeDe,
  MAX_PLANOS_BUSCA,
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

describe('expandirPlanosBusca (fanout efetivo do backend)', () => {
  it('doceria/confeitaria amplia recall além do termo literal sem usar includedType fraco', () => {
    const planos = expandirPlanosBusca('Doceria', 'Pinheiros, São Paulo, SP, Brasil')

    expect(planos.map((p) => p.termo)).toEqual(
      expect.arrayContaining(['doceria', 'confeitaria', 'loja de doces', 'bolos artesanais']),
    )
    expect(planos.length).toBeGreaterThan(3)
    expect(planos.length).toBeLessThanOrEqual(MAX_PLANOS_BUSCA)
    expect(planos.every((p) => p.includedType === null)).toBe(true)
    expect(planos.some((p) => p.modoLocalizacao === 'perto_de')).toBe(true)
  })

  it('setor conhecido com tipo confiável mantém fallback amplo para não depender só da taxonomia', () => {
    const planos = expandirPlanosBusca('Pet shop', 'Moema, São Paulo')

    expect(planos.some((p) => p.includedType === 'pet_store')).toBe(true)
    expect(planos.some((p) => p.includedType === null)).toBe(true)
  })

  it('setor desconhecido continua literal e não inventa categoria', () => {
    const planos = expandirPlanosBusca('Loja de discos', 'Vila Madalena, São Paulo')

    expect(planos.length).toBeGreaterThan(1)
    expect(planos.length).toBeLessThanOrEqual(MAX_PLANOS_BUSCA)
    expect(planos.every((p) => p.termo === 'Loja de discos')).toBe(true)
    expect(planos.every((p) => p.includedType === null)).toBe(true)
    expect(planos.some((p) => p.textQuery === 'Loja de discos perto de Vila Madalena, São Paulo')).toBe(true)
  })

  it('gera planos bounded e dedupados para vários setores sem depender de Pinheiros/doceria', () => {
    for (const setor of ['Pizzaria', 'Pet shop', 'Barbearia', 'Academia', 'Restaurante', 'Loja de discos']) {
      const planos = expandirPlanosBusca(setor, 'Savassi, Belo Horizonte, MG, Brasil')
      const keys = new Set(planos.map((p) => `${p.termo}|${p.includedType ?? ''}|${p.textQuery ?? ''}`))

      expect(planos.length).toBeGreaterThan(0)
      expect(planos.length).toBeLessThanOrEqual(MAX_PLANOS_BUSCA)
      expect(keys.size).toBe(planos.length)
      expect(planos.every((p) => p.textQuery?.includes('Belo Horizonte') || p.textQuery?.includes('Savassi'))).toBe(true)
    }
  })

  it('inclui termos não literais por família, mas mantém setor desconhecido sem chute', () => {
    expect(expandirPlanosBusca('Academia', 'Água Verde, Curitiba').map((p) => p.termo)).toEqual(
      expect.arrayContaining(['estudio fitness', 'centro de treinamento']),
    )
    expect(expandirPlanosBusca('Barbearia', 'Asa Norte, Brasília').map((p) => p.termo)).toContain('barber shop')
    expect(expandirPlanosBusca('Loja de discos', 'Centro, Porto Alegre').every((p) => p.termo === 'Loja de discos')).toBe(true)
  })

  it('não aplica includedType cegamente em famílias fracas ou amplas', () => {
    expect(expandirPlanosBusca('Doceria', 'Itaim Bibi, São Paulo').every((p) => p.includedType === null)).toBe(true)
    expect(expandirPlanosBusca('Restaurante', 'Leblon, Rio de Janeiro').every((p) => p.includedType === null)).toBe(true)
  })

  it('aplica includedType forte só no local principal e mantém fallback textual', () => {
    const planos = expandirPlanosBusca('Pizzaria', 'Botafogo, Rio de Janeiro, RJ, Brasil')

    expect(planos.some((p) => p.includedType === 'pizza_restaurant')).toBe(true)
    expect(planos.some((p) => p.includedType === null)).toBe(true)
    expect(planos.filter((p) => p.includedType === 'pizza_restaurant').every((p) => p.modoLocalizacao === 'em')).toBe(true)
  })
})

describe('googleTypeDe (viés de categoria do Places)', () => {
  it('mapeia famílias conhecidas', () => {
    expect(googleTypeDe('Confeitaria')).toBe('confectionery')
    expect(googleTypeDe('cafeteria')).toBe('cafe')
    expect(googleTypeDe('Pet shop')).toBe('pet_store')
    expect(googleTypeDe('Academia')).toBe('gym')
    expect(googleTypeDe('Pizzaria')).toBe('pizza_restaurant')
    expect(googleTypeDe('Barbearia')).toBe('barber_shop')
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
    expect(montarQuery('pizzaria', loc, 'perto_de')).toBe('pizzaria perto de Alta Floresta, MT, Brasil')
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
