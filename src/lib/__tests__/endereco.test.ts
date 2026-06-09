import { describe, it, expect } from 'vitest'
import { parseEnderecoFormatado } from '../../../supabase/functions/_shared/endereco'

// O bairro do lead vinha do TERMO DE BUSCA, não do endereço real (ISSUE-002):
// o Google devolve resultados de bairros vizinhos e todos ganhavam o rótulo
// pesquisado. O formatted_address legado tem o bairro de verdade:
//   "<rua>, <nº>[ - complemento] - <bairro>, <cidade> - <UF>, <CEP>, Brazil"

describe('parseEnderecoFormatado', () => {
  it('extrai bairro e cidade do formato padrão do Google', () => {
    expect(
      parseEnderecoFormatado('Alameda Tietê, 255 - Cerqueira César, São Paulo - SP, 01417-020, Brazil'),
    ).toEqual({ bairro: 'Cerqueira César', cidade: 'São Paulo' })
  })

  it('com complemento, o bairro é o ÚLTIMO segmento antes da cidade', () => {
    expect(
      parseEnderecoFormatado('Av. Brig. Faria Lima, 2232 - cj 12 - Itaim Bibi, São Paulo - SP, 01451-000, Brazil'),
    ).toEqual({ bairro: 'Itaim Bibi', cidade: 'São Paulo' })
  })

  it('funciona para outra cidade/UF', () => {
    expect(
      parseEnderecoFormatado('Rua XV de Novembro, 100 - Centro, Joinville - SC, 89201-000, Brazil'),
    ).toEqual({ bairro: 'Centro', cidade: 'Joinville' })
  })

  it('endereço sem bairro → bairro null, cidade preservada', () => {
    expect(
      parseEnderecoFormatado('Praça Charles Miller, São Paulo - SP, 01234-000, Brazil'),
    ).toEqual({ bairro: null, cidade: 'São Paulo' })
  })

  it('não confunde número solto com bairro', () => {
    expect(
      parseEnderecoFormatado('Rua Augusta - 255, São Paulo - SP, 01305-000, Brazil'),
    ).toEqual({ bairro: null, cidade: 'São Paulo' })
  })

  it('formato irreconhecível ou vazio → null (caller usa o fallback)', () => {
    expect(parseEnderecoFormatado('Rua Sem Cidade, 10, Brazil')).toBeNull()
    expect(parseEnderecoFormatado('')).toBeNull()
    expect(parseEnderecoFormatado(null)).toBeNull()
  })
})
