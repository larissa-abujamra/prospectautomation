import { describe, it, expect } from 'vitest'
import { toE164Br, ehTelefoneBrValido } from '../phoneBr'

describe('toE164Br', () => {
  it('mantém E.164 móvel já completo (+55 + DDD + 9 dígitos)', () => {
    expect(toE164Br('+55 11 99999-8888')).toBe('+5511999998888')
    expect(toE164Br('5511999998888')).toBe('+5511999998888')
  })

  it('mantém E.164 fixo já completo (12 dígitos)', () => {
    expect(toE164Br('+55 11 3068-0778')).toBe('+551130680778')
  })

  it('adiciona +55 a número local com DDD (móvel 11 dígitos)', () => {
    expect(toE164Br('11 99999-8888')).toBe('+5511999998888')
    expect(toE164Br('(11) 99999-8888')).toBe('+5511999998888')
  })

  it('adiciona +55 a número local fixo (10 dígitos)', () => {
    expect(toE164Br('11 3068-0778')).toBe('+551130680778')
  })

  it('recusa número curto demais', () => {
    expect(toE164Br('99999-8888')).toBeNull() // sem DDD
    expect(toE164Br('123')).toBeNull()
  })

  it('recusa lixo e país != 55', () => {
    expect(toE164Br('wa.me/abc')).toBeNull()
    expect(toE164Br('+1 415 555 2671')).toBeNull() // não é BR
    expect(toE164Br('')).toBeNull()
  })

  it('ehTelefoneBrValido espelha toE164Br', () => {
    expect(ehTelefoneBrValido('11 99999-8888')).toBe(true)
    expect(ehTelefoneBrValido('abc')).toBe(false)
  })
})
