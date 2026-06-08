import { describe, it, expect } from 'vitest'
import { parseGenero, generoPrompt } from '../../../supabase/functions/_shared/genero'

describe('parseGenero', () => {
  it('reconhece masculino', () => {
    expect(parseGenero('m')).toBe('m')
    expect(parseGenero('M')).toBe('m')
    expect(parseGenero('masculino')).toBe('m')
    expect(parseGenero('Masc')).toBe('m')
  })

  it('reconhece feminino', () => {
    expect(parseGenero('f')).toBe('f')
    expect(parseGenero('feminino')).toBe('f')
    expect(parseGenero('FEM')).toBe('f')
  })

  it('default feminino para vazio/nulo/ruído (degrada com segurança)', () => {
    expect(parseGenero('')).toBe('f')
    expect(parseGenero(null)).toBe('f')
    expect(parseGenero(undefined)).toBe('f')
    expect(parseGenero('não sei')).toBe('f')
    expect(parseGenero('???')).toBe('f')
  })

  it('prioriza feminino quando a resposta é ambígua mas cita os dois', () => {
    // resposta confusa → não arrisca masculino
    expect(parseGenero('pode ser feminino ou masculino')).toBe('f')
  })
})

describe('generoPrompt', () => {
  it('inclui o nome e pede uma única letra', () => {
    const { system, user } = generoPrompt('Empório dos Bichos')
    expect(user).toContain('Empório dos Bichos')
    expect(system.toLowerCase()).toContain('f')
    expect(system.toLowerCase()).toContain('m')
  })
})
