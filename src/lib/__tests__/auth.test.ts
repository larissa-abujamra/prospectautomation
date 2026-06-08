import { describe, it, expect } from 'vitest'
import { bearerToken } from '../../../supabase/functions/_shared/auth'

describe('bearerToken', () => {
  it('extrai o token de "Bearer <token>"', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerToken('bearer xyz')).toBe('xyz') // case-insensitive
  })

  it('null para header ausente, vazio ou sem Bearer', () => {
    expect(bearerToken(null)).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('')).toBeNull()
    expect(bearerToken('Token abc')).toBeNull()
    expect(bearerToken('Bearer   ')).toBeNull()
  })
})
