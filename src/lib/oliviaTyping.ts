import type { Lead, WhatsappMensagem } from './types'

export type OliviaTypingState =
  | { kind: 'typing'; label: string }
  | { kind: 'scheduled'; label: string }

const ACTIVE_STATES = new Set(['conversando', 'agendando'])
const RECENT_INBOUND_WINDOW_MS = 10 * 60 * 1000
const ACTIVE_LOCK_WINDOW_MS = 90 * 1000

export function getOliviaTypingState(
  lead: Pick<Lead, 'olivia_estado' | 'olivia_reply_apos' | 'olivia_lock'>,
  mensagens: WhatsappMensagem[],
  nowMs = Date.now(),
): OliviaTypingState | null {
  const latest = mensagens[mensagens.length - 1]
  if (!latest || latest.direcao !== 'in') return null
  if (!lead.olivia_estado || !ACTIVE_STATES.has(lead.olivia_estado)) return null

  const replyAposMs = lead.olivia_reply_apos ? Date.parse(lead.olivia_reply_apos) : NaN
  if (Number.isFinite(replyAposMs) && replyAposMs > nowMs) {
    return { kind: 'scheduled', label: 'Olivia vai responder no próximo horário' }
  }

  const lockMs = lead.olivia_lock ? Date.parse(lead.olivia_lock) : NaN
  if (Number.isFinite(lockMs) && nowMs - lockMs <= ACTIVE_LOCK_WINDOW_MS) {
    return { kind: 'typing', label: 'Olivia está digitando' }
  }

  const inboundMs = Date.parse(latest.enviada_em)
  if (!Number.isFinite(inboundMs) || nowMs - inboundMs > RECENT_INBOUND_WINDOW_MS) return null

  return { kind: 'typing', label: 'Olivia está digitando' }
}
