import { describe, it, expect } from 'vitest'
import { ehTransitorio } from '../buscaMassa'

// ehTransitorio decide se uma falha de invoke deve ser RE-TENTADA (cold start /
// timeout) ou propagada na hora (erro funcional/validação). Esse contrato é o que
// protege a busca em massa do "Failed to send a request" intermitente.
describe('ehTransitorio (decisão de retry da busca em massa)', () => {
  it('re-tenta FunctionsFetchError (cold start / fetch falhou)', () => {
    expect(ehTransitorio({ name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' })).toBe(true)
  })
  it('re-tenta FunctionsRelayError', () => {
    expect(ehTransitorio({ name: 'FunctionsRelayError', message: 'relay error' })).toBe(true)
  })
  it('re-tenta por mensagem de timeout / 5xx / boot mesmo sem name', () => {
    expect(ehTransitorio({ message: 'network timeout' })).toBe(true)
    expect(ehTransitorio({ message: 'gateway 504' })).toBe(true)
    expect(ehTransitorio({ message: 'BOOT_ERROR' })).toBe(true)
  })
  it('NÃO re-tenta erro funcional/validação (4xx)', () => {
    expect(ehTransitorio({ name: 'FunctionsHttpError', message: 'Escopo inválido (tipo: uf|metro|cidade, valor).' })).toBe(false)
    expect(ehTransitorio({ name: 'FunctionsHttpError', message: 'Autenticação obrigatória.' })).toBe(false)
  })
  it('null/sem erro → false', () => {
    expect(ehTransitorio(null)).toBe(false)
    expect(ehTransitorio({})).toBe(false)
  })
})
