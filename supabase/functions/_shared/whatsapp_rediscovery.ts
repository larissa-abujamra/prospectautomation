export type RediscoveryWhatsappStatus = 'pending' | 'found' | 'missing' | 'invalid' | null

export const WHATSAPP_REDISCOVERY_TTL_MS = 14 * 24 * 60 * 60 * 1000

interface RediscoverySourceSnapshot {
  telefone?: string | null
  website?: string | null
  instagramHandle?: string | null
}

export interface ShouldResetWhatsappDiscoveryInput {
  status: RediscoveryWhatsappStatus
  checkedAt?: string | null
  current?: RediscoverySourceSnapshot
  fresh?: RediscoverySourceSnapshot
  now?: Date
  ttlMs?: number
}

export function isTerminalWhatsappMiss(status: RediscoveryWhatsappStatus): boolean {
  return status === 'missing' || status === 'invalid'
}

export function isWhatsappDiscoveryStale(
  checkedAt: string | null | undefined,
  now = new Date(),
  ttlMs = WHATSAPP_REDISCOVERY_TTL_MS,
): boolean {
  if (!checkedAt) return true
  const checkedMs = Date.parse(checkedAt)
  if (Number.isNaN(checkedMs)) return true
  return now.getTime() - checkedMs >= ttlMs
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function cleanPhone(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function hasNewSignal(current: RediscoverySourceSnapshot, fresh: RediscoverySourceSnapshot): boolean {
  const freshPhone = cleanPhone(fresh.telefone)
  if (freshPhone && freshPhone !== cleanPhone(current.telefone)) return true

  const freshWebsite = cleanText(fresh.website)
  if (freshWebsite && freshWebsite !== cleanText(current.website)) return true

  const freshInstagram = cleanText(fresh.instagramHandle).replace(/^@/, '')
  const currentInstagram = cleanText(current.instagramHandle).replace(/^@/, '')
  return !!freshInstagram && freshInstagram !== currentInstagram
}

export function shouldResetWhatsappDiscovery(input: ShouldResetWhatsappDiscoveryInput): boolean {
  if (!isTerminalWhatsappMiss(input.status)) return false
  if (hasNewSignal(input.current ?? {}, input.fresh ?? {})) return true
  return isWhatsappDiscoveryStale(input.checkedAt, input.now, input.ttlMs)
}
