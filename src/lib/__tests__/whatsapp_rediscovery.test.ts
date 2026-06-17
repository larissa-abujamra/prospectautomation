import { describe, expect, it } from 'vitest'
import {
  isWhatsappDiscoveryStale,
  shouldResetWhatsappDiscovery,
} from '../../../supabase/functions/_shared/whatsapp_rediscovery.ts'

const now = new Date('2026-06-15T12:00:00Z')

describe('isWhatsappDiscoveryStale', () => {
  it('treats missing legacy timestamps as stale', () => {
    expect(isWhatsappDiscoveryStale(null, now)).toBe(true)
    expect(isWhatsappDiscoveryStale('not-a-date', now)).toBe(true)
  })

  it('respects the rediscovery TTL', () => {
    expect(isWhatsappDiscoveryStale('2026-06-14T12:00:00Z', now)).toBe(false)
    expect(isWhatsappDiscoveryStale('2026-05-20T12:00:00Z', now)).toBe(true)
  })
})

describe('shouldResetWhatsappDiscovery', () => {
  it('requeues stale missing/invalid WhatsApp results', () => {
    expect(
      shouldResetWhatsappDiscovery({
        status: 'missing',
        checkedAt: '2026-05-20T12:00:00Z',
        now,
      }),
    ).toBe(true)
    expect(
      shouldResetWhatsappDiscovery({
        status: 'invalid',
        checkedAt: '2026-05-20T12:00:00Z',
        now,
      }),
    ).toBe(true)
  })

  it('does not requeue recent misses without new source evidence', () => {
    expect(
      shouldResetWhatsappDiscovery({
        status: 'missing',
        checkedAt: '2026-06-14T12:00:00Z',
        current: { telefone: null, website: 'https://old.example', instagramHandle: 'doces' },
        fresh: { telefone: null, website: 'https://old.example', instagramHandle: '@doces' },
        now,
      }),
    ).toBe(false)
  })

  it('requeues a recent miss when a new search finds better source data', () => {
    expect(
      shouldResetWhatsappDiscovery({
        status: 'missing',
        checkedAt: '2026-06-14T12:00:00Z',
        current: { telefone: null, website: null, instagramHandle: null },
        fresh: { telefone: '(11) 99999-0000', website: null, instagramHandle: null },
        now,
      }),
    ).toBe(true)
  })

  it('never resets found or pending leads', () => {
    expect(
      shouldResetWhatsappDiscovery({
        status: 'found',
        checkedAt: '2026-05-20T12:00:00Z',
        fresh: { telefone: '(11) 99999-0000' },
        now,
      }),
    ).toBe(false)
    expect(
      shouldResetWhatsappDiscovery({
        status: 'pending',
        checkedAt: '2026-05-20T12:00:00Z',
        fresh: { telefone: '(11) 99999-0000' },
        now,
      }),
    ).toBe(false)
  })
})
