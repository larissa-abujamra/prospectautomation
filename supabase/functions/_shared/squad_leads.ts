import { normalizeBrazilPhone } from './phone.ts'

export const SQUAD_LEADS_ORIGIN = 'squad_leads_form' as const

export const SQUAD_REVENUE_RANGES = [
  'menos_10k',
  '10k_20k',
  '20k_50k',
  '50k_100k',
  'acima_100k',
] as const
export type SquadRevenueRange = (typeof SQUAD_REVENUE_RANGES)[number]

export const SQUAD_READY_VALUES = [
  'sim_certeza',
  'talvez',
  'nao_proximos_7dias',
] as const
export type SquadReadyToImplement = (typeof SQUAD_READY_VALUES)[number]

export const SQUAD_CLASSIFICATIONS = ['quente', 'nutrir', 'descartar'] as const
export type SquadClassification = (typeof SQUAD_CLASSIFICATIONS)[number]

type SimNao = 'sim' | 'nao'

export interface SquadLeadApi {
  id?: unknown
  companyName?: unknown
  hasInstagram?: unknown
  instagramHandle?: unknown
  hasWhatsapp?: unknown
  sellsOnWhatsapp?: unknown
  hasCnpj?: unknown
  revenueRange?: unknown
  readyToImplement?: unknown
  score?: unknown
  classification?: unknown
  contactName?: unknown
  contactPhone?: unknown
  utmSource?: unknown
  utmMedium?: unknown
  utmCampaign?: unknown
  createdAt?: unknown
}

export interface SquadLeadRow {
  squad_leads_id: number
  origem: typeof SQUAD_LEADS_ORIGIN
  nome: string
  dono_nome: string | null
  telefone: string | null
  instagram_handle: string | null
  cnpj: null
  inbound_score: number | null
  inbound_classification: SquadClassification | null
  inbound_revenue_range: SquadRevenueRange | null
  inbound_ready_to_implement: SquadReadyToImplement | null
  inbound_created_at: string | null
  inbound_utm_source: string | null
  inbound_utm_medium: string | null
  inbound_utm_campaign: string | null
  inbound_meta: Record<string, unknown>
}

export type SquadLeadSkipReason =
  | 'missing_source_id'
  | 'missing_company_name'

export type SquadLeadMapResult =
  | { ok: true; row: SquadLeadRow }
  | { ok: false; reason: SquadLeadSkipReason }

const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv'])

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

function cleanNullableText(value: unknown): string | null {
  return cleanText(value)
}

function inSet<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== 'string') return null
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : null
}

function simNao(value: unknown): SimNao | null {
  return value === 'sim' || value === 'nao' ? value : null
}

function sourceId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

function sourceScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 0 || value > 100) return null
  return value
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const timestamp = Date.parse(text)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString()
}

function instagramCandidate(raw: string): string {
  const trimmed = raw.trim()
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#\s]+)/i)
  if (urlMatch) return urlMatch[1]
  const bareMatch = trimmed.match(/(?:^|\s)instagram\.com\/([^/?#\s]+)/i)
  if (bareMatch) return bareMatch[1]
  return trimmed
}

export function normalizeSquadInstagramHandle(value: unknown): string | null {
  const text = cleanText(value)
  if (!text) return null

  const candidate = instagramCandidate(text)
    .replace(/^@+/, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase()

  if (!candidate || INSTAGRAM_RESERVED.has(candidate)) return null
  if (!/^[a-z0-9._]{1,30}$/.test(candidate)) return null
  return candidate
}

export function normalizeSquadContactPhone(value: unknown): string | null {
  const text = cleanText(value)
  if (!text) return null
  return normalizeBrazilPhone(text)?.e164 ?? null
}

export function mapSquadLeadToLeadRow(source: SquadLeadApi): SquadLeadMapResult {
  const id = sourceId(source.id)
  if (id == null) return { ok: false, reason: 'missing_source_id' }

  const nome = cleanText(source.companyName)
  if (!nome) return { ok: false, reason: 'missing_company_name' }

  const phoneRaw = cleanNullableText(source.contactPhone)
  const phone = normalizeSquadContactPhone(source.contactPhone)
  const createdAt = isoTimestamp(source.createdAt)

  const meta: Record<string, unknown> = {
    source: 'squad_leads',
    has_instagram_self_declared: simNao(source.hasInstagram),
    has_whatsapp_self_declared: simNao(source.hasWhatsapp),
    sells_on_whatsapp_self_declared: simNao(source.sellsOnWhatsapp),
    has_cnpj_self_declared: simNao(source.hasCnpj),
    created_at_raw: cleanNullableText(source.createdAt),
  }
  if (phoneRaw && !phone) meta.contact_phone_raw = phoneRaw

  return {
    ok: true,
    row: {
      squad_leads_id: id,
      origem: SQUAD_LEADS_ORIGIN,
      nome,
      dono_nome: cleanNullableText(source.contactName),
      telefone: phone,
      instagram_handle: normalizeSquadInstagramHandle(source.instagramHandle),
      cnpj: null,
      inbound_score: sourceScore(source.score),
      inbound_classification: inSet(source.classification, SQUAD_CLASSIFICATIONS),
      inbound_revenue_range: inSet(source.revenueRange, SQUAD_REVENUE_RANGES),
      inbound_ready_to_implement: inSet(source.readyToImplement, SQUAD_READY_VALUES),
      inbound_created_at: createdAt,
      inbound_utm_source: cleanNullableText(source.utmSource),
      inbound_utm_medium: cleanNullableText(source.utmMedium),
      inbound_utm_campaign: cleanNullableText(source.utmCampaign),
      inbound_meta: meta,
    },
  }
}
