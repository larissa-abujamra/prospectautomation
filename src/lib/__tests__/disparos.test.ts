import { describe, it, expect } from 'vitest'
import { contarLeadsComResposta, leadsDisparados, statusDisparo } from '../disparos'
import type { Lead } from '../types'

const lead = (over: Partial<Lead>): Lead => ({ id: 'x', ...over }) as Lead

describe('statusDisparo (status honesto do disparo)', () => {
  it('sem status de entrega: acionado quando há sent_at, senão não disparado', () => {
    expect(statusDisparo(lead({ whatsapp_send_status: null, whatsapp_sent_at: '2026-06-11T12:00:00Z' })))
      .toEqual({ label: 'Acionado no HubSpot', dot: 'pending' })
    expect(statusDisparo(lead({ whatsapp_send_status: null, whatsapp_sent_at: null })))
      .toEqual({ label: 'Não disparado', dot: 'empty' })
  })

  it('mapeia cada status de entrega', () => {
    expect(statusDisparo(lead({ whatsapp_send_status: 'sent', whatsapp_sent_at: null })).label).toBe('Enviado')
    expect(statusDisparo(lead({ whatsapp_send_status: 'delivered', whatsapp_sent_at: null })).label).toBe('Entregue')
    expect(statusDisparo(lead({ whatsapp_send_status: 'read', whatsapp_sent_at: null })).label).toBe('Lido')
    expect(statusDisparo(lead({ whatsapp_send_status: 'replied', whatsapp_sent_at: null })))
      .toEqual({ label: 'Respondeu', dot: 'ok' })
  })

  it('falhas viram dot missing (visíveis, não escondidas)', () => {
    expect(statusDisparo(lead({ whatsapp_send_status: 'failed', whatsapp_sent_at: null })).dot).toBe('missing')
    expect(statusDisparo(lead({ whatsapp_send_status: 'invalid', whatsapp_sent_at: null })).dot).toBe('missing')
  })
})

describe('leadsDisparados', () => {
  it('inclui quem tem sent_at OU status, ordenado do mais recente', () => {
    const r = leadsDisparados([
      lead({ id: 'antigo', whatsapp_sent_at: '2026-06-10T10:00:00Z' }),
      lead({ id: 'nunca', whatsapp_sent_at: null, whatsapp_send_status: null }),
      lead({ id: 'novo', whatsapp_sent_at: '2026-06-11T10:00:00Z' }),
      lead({ id: 'so-status', whatsapp_sent_at: null, whatsapp_send_status: 'replied' }),
    ])
    expect(r.map((l) => l.id)).toEqual(['novo', 'antigo', 'so-status'])
  })
})

describe('contarLeadsComResposta', () => {
  it('conta leads distintos e ignora mensagens sem lead', () => {
    expect(
      contarLeadsComResposta([
        { lead_id: 'a', enviada_em: '2026-06-11T10:00:00Z' },
        { lead_id: 'a', enviada_em: '2026-06-11T11:00:00Z' },
        { lead_id: 'b', enviada_em: '2026-06-11T12:00:00Z' },
        { lead_id: null, enviada_em: '2026-06-11T13:00:00Z' },
      ]),
    ).toBe(2)
    expect(contarLeadsComResposta([])).toBe(0)
  })
})
