import { describe, expect, it } from 'vitest'
import {
  buildManualOliviaLeadPayload,
  canRetryManualOliviaOutreach,
  manualOliviaDedupKey,
  normalizeManualOliviaInput,
} from '../manualOlivia'
import type { Lead } from '../types'

const lead = (overrides: Partial<Lead>): Pick<Lead, 'whatsapp_sent_at' | 'whatsapp_send_status'> =>
  ({
    whatsapp_sent_at: null,
    whatsapp_send_status: null,
    ...overrides,
  }) as Lead

describe('normalizeManualOliviaInput', () => {
  it('normalizes required name and Brazilian WhatsApp number', () => {
    expect(
      normalizeManualOliviaInput({
        nome: '  Bia Doces  ',
        whatsapp: '(11) 99999-8888',
        cidade: '  São Paulo  ',
        notas: '  indicação feira  ',
      }),
    ).toEqual({
      ok: true,
      value: {
        nome: 'Bia Doces',
        whatsapp: '+5511999998888',
        cidade: 'São Paulo',
        notas: 'indicação feira',
      },
    })
  })

  it('rejects missing name, city, and non-Brazilian numbers', () => {
    expect(normalizeManualOliviaInput({ nome: '', whatsapp: '11 99999-8888', cidade: 'São Paulo' })).toEqual({
      ok: false,
      error: 'Informe o nome do contato ou negócio.',
    })
    expect(normalizeManualOliviaInput({ nome: 'Ana', whatsapp: '+1 415 555 2671', cidade: 'São Paulo' })).toEqual({
      ok: false,
      error: 'Informe um WhatsApp brasileiro com DDD.',
    })
    expect(normalizeManualOliviaInput({ nome: 'Ana', whatsapp: '11 99999-8888', cidade: '' })).toEqual({
      ok: false,
      error: 'Informe a cidade.',
    })
  })

  it('caps fields before they reach Supabase or HubSpot', () => {
    expect(
      normalizeManualOliviaInput({
        nome: 'A'.repeat(121),
        whatsapp: '11 99999-8888',
        cidade: 'São Paulo',
      }),
    ).toEqual({ ok: false, error: 'Nome deve ter até 120 caracteres.' })
    expect(
      normalizeManualOliviaInput({
        nome: 'Ana',
        whatsapp: '11 99999-8888',
        cidade: 'S'.repeat(121),
      }),
    ).toEqual({ ok: false, error: 'Cidade deve ter até 120 caracteres.' })
    expect(
      normalizeManualOliviaInput({
        nome: 'Ana',
        whatsapp: '11 99999-8888',
        cidade: 'São Paulo',
        notas: 'x'.repeat(1001),
      }),
    ).toEqual({ ok: false, error: 'Notas devem ter até 1000 caracteres.' })
  })
})

describe('manual Olivia lead mapping', () => {
  it('uses a stable synthetic dedupe key from the normalized phone', () => {
    expect(manualOliviaDedupKey('+55 11 99999-8888')).toBe('manual_olivia:5511999998888')
  })

  it('builds a lead payload compatible with the HubSpot workflow mapper', () => {
    const payload = buildManualOliviaLeadPayload(
      {
        nome: 'Bia Doces',
        whatsapp: '+5511999998888',
        cidade: 'São Paulo',
        notas: 'indicação feira',
      },
      '2026-06-17T10:00:00.000Z',
    )

    expect(payload).toMatchObject({
      nome: 'Bia Doces',
      origem: 'manual_olivia',
      google_place_id: 'manual_olivia:5511999998888',
      setor: 'Geral',
      cidade: 'São Paulo',
      whatsapp_phone: '+5511999998888',
      whatsapp_source: 'manual',
      whatsapp_status: 'found',
      whatsapp_checked_at: '2026-06-17T10:00:00.000Z',
      nome_genero: null,
      status: 'qualificado',
      notas: 'Manual Olivia: indicação feira',
    })
  })
})

describe('canRetryManualOliviaOutreach', () => {
  it('blocks contacts with an existing non-retryable outreach', () => {
    expect(canRetryManualOliviaOutreach(lead({ whatsapp_sent_at: '2026-06-17T10:00:00Z' }))).toBe(false)
    expect(canRetryManualOliviaOutreach(lead({ whatsapp_send_status: 'sent' }))).toBe(false)
    expect(canRetryManualOliviaOutreach(lead({ whatsapp_send_status: 'replied' }))).toBe(false)
  })

  it('allows never-sent contacts and retryable failed/invalid statuses', () => {
    expect(canRetryManualOliviaOutreach(lead({}))).toBe(true)
    expect(
      canRetryManualOliviaOutreach(lead({ whatsapp_sent_at: '2026-06-17T10:00:00Z', whatsapp_send_status: 'failed' })),
    ).toBe(true)
    expect(canRetryManualOliviaOutreach(lead({ whatsapp_send_status: 'invalid' }))).toBe(true)
  })
})
