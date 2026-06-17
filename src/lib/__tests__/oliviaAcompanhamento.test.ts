import { describe, expect, it } from 'vitest'
import {
  aguardandoRespostaOlivia,
  leadsEmAcompanhamentoOlivia,
} from '../oliviaAcompanhamento'
import type { Lead } from '../types'

const lead = (over: Partial<Lead>): Lead =>
  ({
    id: 'lead-1',
    olivia_estado: null,
    whatsapp_send_status: null,
    whatsapp_sent_at: null,
    ...over,
  }) as Lead

describe('aguardandoRespostaOlivia', () => {
  it('inclui disparos acionados no HubSpot mesmo sem olivia_estado backfilled', () => {
    expect(aguardandoRespostaOlivia(lead({ whatsapp_sent_at: '2026-06-16T21:21:30Z' }))).toBe(true)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_send_status: 'sent' }))).toBe(true)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_send_status: 'delivered' }))).toBe(true)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_send_status: 'read' }))).toBe(true)
  })

  it('mantem conversas ativas por olivia_estado', () => {
    expect(aguardandoRespostaOlivia(lead({ olivia_estado: 'aguardando' }))).toBe(true)
    expect(aguardandoRespostaOlivia(lead({ olivia_estado: 'conversando' }))).toBe(true)
    expect(aguardandoRespostaOlivia(lead({ olivia_estado: 'agendando' }))).toBe(true)
  })

  it('exclui respostas, falhas e estados terminais', () => {
    expect(aguardandoRespostaOlivia(lead({ whatsapp_sent_at: '2026-06-16T21:21:30Z', whatsapp_send_status: 'replied' }))).toBe(false)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_sent_at: '2026-06-16T21:21:30Z', whatsapp_send_status: 'failed' }))).toBe(false)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_sent_at: '2026-06-16T21:21:30Z', whatsapp_send_status: 'invalid' }))).toBe(false)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_sent_at: '2026-06-16T21:21:30Z', olivia_estado: 'handoff' }))).toBe(false)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_sent_at: '2026-06-16T21:21:30Z', olivia_estado: 'agendado' }))).toBe(false)
    expect(aguardandoRespostaOlivia(lead({ whatsapp_sent_at: '2026-06-16T21:21:30Z', olivia_estado: 'optout' }))).toBe(false)
  })

  it('nao deixa falha stale em aguardando voltar para o cockpit', () => {
    expect(aguardandoRespostaOlivia(lead({ olivia_estado: 'aguardando', whatsapp_send_status: 'failed' }))).toBe(false)
    expect(aguardandoRespostaOlivia(lead({ olivia_estado: 'aguardando', whatsapp_send_status: 'invalid' }))).toBe(false)
  })

  it('mantem resposta em conversa quando Olivia ja esta atuando', () => {
    expect(aguardandoRespostaOlivia(lead({ olivia_estado: 'conversando', whatsapp_send_status: 'replied' }))).toBe(true)
  })
})

describe('leadsEmAcompanhamentoOlivia', () => {
  it('filtra e ordena por disparo mais recente', () => {
    const leads = leadsEmAcompanhamentoOlivia([
      lead({ id: 'antigo', whatsapp_sent_at: '2026-06-15T19:00:00Z' }),
      lead({ id: 'respondido', whatsapp_sent_at: '2026-06-16T19:00:00Z', whatsapp_send_status: 'replied' }),
      lead({ id: 'novo', whatsapp_sent_at: '2026-06-16T21:00:00Z' }),
      lead({ id: 'conversa', olivia_estado: 'conversando' }),
    ])

    expect(leads.map((l) => l.id)).toEqual(['novo', 'antigo', 'conversa'])
  })
})
