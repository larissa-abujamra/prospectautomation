import { describe, it, expect } from 'vitest'
import {
  situacaoAtiva,
  cidadeCompativel,
  gateCandidato,
  cnpjValido,
  extrairCnpjsDeHtml,
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

describe('cnpjValido', () => {
  it('aceita CNPJ real com e sem máscara (dígito verificador mod-11)', () => {
    expect(cnpjValido('11199919000172')).toBe(true) // Empório dos Bichos (verificado)
    expect(cnpjValido('11.199.919/0001-72')).toBe(true)
  })

  it('rejeita dígito verificador errado, repetição e tamanho inválido', () => {
    expect(cnpjValido('11199919000173')).toBe(false)
    expect(cnpjValido('11111111111111')).toBe(false)
    expect(cnpjValido('123')).toBe(false)
  })
})

describe('extrairCnpjsDeHtml', () => {
  // Fonte de MAIOR precisão (P1): site brasileiro costuma publicar o próprio
  // CNPJ no rodapé. Só texto visível conta — script/style ficam de fora.
  it('acha o CNPJ mascarado no rodapé', () => {
    const html = `<footer><p>Razão Social Ltda · CNPJ: 11.199.919/0001-72 ·
      Todos os direitos reservados</p></footer>`
    expect(extrairCnpjsDeHtml(html)).toEqual(['11199919000172'])
  })

  it('ignora CNPJ dentro de <script> (não é texto visível)', () => {
    const html = `<script>var cnpj = "11.199.919/0001-72";</script>`
    expect(extrairCnpjsDeHtml(html)).toEqual([])
  })

  it('descarta sequência de 14 dígitos com verificador inválido', () => {
    expect(extrairCnpjsDeHtml('<p>id do pedido: 11199919000173</p>')).toEqual([])
  })

  it('dedupe quando o site repete o CNPJ', () => {
    const html = `<p>CNPJ 11.199.919/0001-72</p><p>cnpj: 11199919000172</p>`
    expect(extrairCnpjsDeHtml(html)).toEqual(['11199919000172'])
  })

  it('HTML sem CNPJ / vazio → []', () => {
    expect(extrairCnpjsDeHtml('<p>sem nada</p>')).toEqual([])
    expect(extrairCnpjsDeHtml('')).toEqual([])
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
