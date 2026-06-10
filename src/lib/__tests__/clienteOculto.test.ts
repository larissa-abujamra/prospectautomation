import { describe, it, expect } from 'vitest'
import { isClienteOcultoPendente } from '../clienteOculto'
import type { Lead } from '../types'

const lead = (over: Partial<Lead>): Lead =>
  ({ id: 'x', status: 'qualificado', whatsapp_send_status: 'sent', cliente_oculto_at: null, ...over }) as Lead

describe('isClienteOcultoPendente', () => {
  it('pendente: na base + disparo enviado + sem visita', () => {
    expect(isClienteOcultoPendente(lead({}))).toBe(true)
    expect(isClienteOcultoPendente(lead({ whatsapp_send_status: 'read' }))).toBe(true)
  })

  it('NÃO pendente: visita já registrada', () => {
    expect(isClienteOcultoPendente(lead({ cliente_oculto_at: '2026-06-10T00:00:00Z' }))).toBe(false)
  })

  it('NÃO pendente: disparo não saiu (sem status, failed, invalid)', () => {
    expect(isClienteOcultoPendente(lead({ whatsapp_send_status: null }))).toBe(false)
    expect(isClienteOcultoPendente(lead({ whatsapp_send_status: 'failed' }))).toBe(false)
  })

  it('NÃO pendente: fora da base (descoberto/descartado)', () => {
    expect(isClienteOcultoPendente(lead({ status: 'descoberto' }))).toBe(false)
    expect(isClienteOcultoPendente(lead({ status: 'descartado' }))).toBe(false)
  })
})
