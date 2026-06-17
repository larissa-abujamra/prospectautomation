import { describe, expect, it } from 'vitest'
import { getOliviaTypingState } from '../oliviaTyping'
import type { Lead, WhatsappMensagem } from '../types'

const baseLead = {
  id: 'lead-1',
  nome: 'Padaria Sol',
  olivia_estado: 'conversando',
  olivia_reply_apos: null,
  olivia_lock: null,
} as Lead

function msg(direcao: 'in' | 'out', enviada_em: string): WhatsappMensagem {
  return {
    id: `${direcao}-${enviada_em}`,
    lead_id: 'lead-1',
    direcao,
    wamid: null,
    tipo: 'text',
    corpo: direcao === 'in' ? 'Oi' : 'Claro!',
    enviada_em,
    created_at: enviada_em,
  }
}

describe('getOliviaTypingState', () => {
  it('mostra digitando quando a última mensagem recente é inbound e Olivia está ativa', () => {
    const state = getOliviaTypingState(
      baseLead,
      [msg('in', '2026-06-14T03:00:00.000Z')],
      Date.parse('2026-06-14T03:02:00.000Z'),
    )

    expect(state?.kind).toBe('typing')
  })

  it('não mostra digitando quando Olivia já respondeu', () => {
    const state = getOliviaTypingState(
      baseLead,
      [
        msg('in', '2026-06-14T03:00:00.000Z'),
        msg('out', '2026-06-14T03:01:00.000Z'),
      ],
      Date.parse('2026-06-14T03:02:00.000Z'),
    )

    expect(state).toBeNull()
  })

  it('mostra resposta agendada quando há reply_apos futuro', () => {
    const state = getOliviaTypingState(
      { ...baseLead, olivia_reply_apos: '2026-06-14T12:00:00.000Z' },
      [msg('in', '2026-06-14T03:00:00.000Z')],
      Date.parse('2026-06-14T03:02:00.000Z'),
    )

    expect(state).toEqual({
      kind: 'scheduled',
      label: 'Olivia vai responder no próximo horário',
    })
  })

  it('usa lock recente como sinal de processamento mesmo quando o inbound é antigo', () => {
    const state = getOliviaTypingState(
      { ...baseLead, olivia_lock: '2026-06-14T03:19:30.000Z' },
      [msg('in', '2026-06-14T03:00:00.000Z')],
      Date.parse('2026-06-14T03:20:00.000Z'),
    )

    expect(state?.kind).toBe('typing')
  })
})
