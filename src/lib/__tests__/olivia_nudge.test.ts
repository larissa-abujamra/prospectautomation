import { describe, it, expect } from 'vitest'
import {
  elegivelParaNudge,
  podeMensagemLivre,
  NUDGE_JANELA_MS,
  WHATSAPP_JANELA_MS,
  type NudgeLead,
} from '../../../supabase/functions/_shared/olivia_nudge'

const agora = Date.parse('2026-06-18T18:00:00Z')
const hAtras = (h: number) => agora - h * 60 * 60 * 1000

const base = (over: Partial<NudgeLead> = {}): NudgeLead => ({
  olivia_estado: 'conversando',
  lastInMs: hAtras(24), // cliente falou há 24h
  lastDir: 'out', // Olivia respondeu por último
  nudgeEmMs: null,
  ...over,
})

describe('elegivelParaNudge', () => {
  it('chat vivo + Olivia falou por último + 23h+ de silêncio → elegível', () => {
    expect(elegivelParaNudge(base(), agora).elegivel).toBe(true)
  })
  it('estado terminal (agendado/handoff/optout/pausada) → não', () => {
    for (const e of ['agendado', 'handoff', 'optout', 'pausada', 'aguardando', null]) {
      expect(elegivelParaNudge(base({ olivia_estado: e }), agora).elegivel, String(e)).toBe(false)
    }
  })
  it('cliente nunca mandou mensagem (lastInMs null) → não é chat → não', () => {
    expect(elegivelParaNudge(base({ lastInMs: null }), agora).elegivel).toBe(false)
  })
  it('última mensagem é do cliente (lastDir=in) → ainda é a vez da Olivia, não cutuca', () => {
    expect(elegivelParaNudge(base({ lastDir: 'in' }), agora).elegivel).toBe(false)
  })
  it('silêncio menor que 23h → cedo demais', () => {
    expect(elegivelParaNudge(base({ lastInMs: hAtras(22) }), agora).elegivel).toBe(false)
    expect(elegivelParaNudge(base({ lastInMs: hAtras(23) }), agora).elegivel).toBe(true)
  })
  it('já cutucado neste silêncio (nudgeEmMs >= lastInMs) → não re-cutuca', () => {
    const lastIn = hAtras(24)
    expect(elegivelParaNudge(base({ lastInMs: lastIn, nudgeEmMs: hAtras(2) }), agora).elegivel).toBe(false)
  })
  it('re-armado: cliente respondeu DEPOIS do último nudge → elegível de novo', () => {
    // nudge antigo (há 40h), cliente respondeu há 24h (depois do nudge), e sumiu
    expect(elegivelParaNudge(base({ lastInMs: hAtras(24), nudgeEmMs: hAtras(40) }), agora).elegivel).toBe(true)
  })
})

describe('podeMensagemLivre (janela de 24h do WhatsApp)', () => {
  it('inbound há <24h → pode mensagem livre (natural)', () => {
    expect(podeMensagemLivre(hAtras(23), agora)).toBe(true)
  })
  it('inbound há >=24h → fora da janela → só template', () => {
    expect(podeMensagemLivre(hAtras(25), agora)).toBe(false)
  })
  it('sem inbound → false', () => {
    expect(podeMensagemLivre(null, agora)).toBe(false)
  })
  it('constantes coerentes (23h < 24h)', () => {
    expect(NUDGE_JANELA_MS).toBeLessThan(WHATSAPP_JANELA_MS)
  })
})
