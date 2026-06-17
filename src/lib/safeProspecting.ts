import type { BuscarParams } from './leads'
import { SETORES, termoBusca } from './setores'

export const META_SAFE_DEFAULT_DAILY_CAP = 40
export const META_SAFE_HARD_DAILY_CAP = 80
export const META_SAFE_BATCH_SIZE = 10
export const META_SAFE_BATCH_DELAY_MS = 45_000

export const GRANDE_SP_SAFE_PRESET = {
  label: 'Grande SP + todos os setores + disparo seguro',
  description:
    'Busca sequencial em todos os setores suportados na Grande SP e prepara disparos com cap diario; e modo seguro, não é garantia anti-ban.',
  locations: [
    'São Paulo, SP, Brasil',
    'Guarulhos, SP, Brasil',
    'Osasco, SP, Brasil',
    'Santo André, SP, Brasil',
    'São Bernardo do Campo, SP, Brasil',
    'São Caetano do Sul, SP, Brasil',
    'Diadema, SP, Brasil',
    'Barueri, SP, Brasil',
    'Carapicuíba, SP, Brasil',
    'Taboão da Serra, SP, Brasil',
    'Mauá, SP, Brasil',
  ],
  maxPerSearch: 20,
} as const

export const SAFE_PROSPECTING_UI_PLACEMENT = {
  page: 'Buscar',
  after: 'SearchPanel',
} as const

export interface SafeProspectingQueueItem {
  key: string
  setorLabel: (typeof SETORES)[number]
  local: (typeof GRANDE_SP_SAFE_PRESET.locations)[number]
  params: BuscarParams
}

export interface ResolvedMetaSafeDailyCap {
  dailyCap: number
  hardCap: number
  source: 'configured' | 'default'
}

export interface SafeDisparoLeadState {
  id: string
  whatsapp_sent_at: string | null
}

export interface SafeDisparoPlanInput {
  allLeads: SafeDisparoLeadState[]
  selectedIds: string[]
  now?: Date
  configuredDailyCap?: number
  hardCap?: number
  maxBatchSize?: number
  batchDelayMs?: number
}

export interface SafeDisparoPlan extends ResolvedMetaSafeDailyCap {
  sentToday: number
  remainingToday: number
  batchIds: string[]
  deferredIds: string[]
  maxBatchSize: number
  batchDelayMs: number
}

export function buildSafeProspectingQueue(): SafeProspectingQueueItem[] {
  const items: SafeProspectingQueueItem[] = []
  for (const setor of SETORES) {
    for (const local of GRANDE_SP_SAFE_PRESET.locations) {
      items.push({
        key: `${setor}::${local}`,
        setorLabel: setor,
        local,
        params: {
          setor: termoBusca(setor),
          local,
          max: GRANDE_SP_SAFE_PRESET.maxPerSearch,
          comSeguidores: false,
        },
      })
    }
  }
  return items
}

export function readMetaSafeDailyCapFromEnv(): number | undefined {
  const raw = import.meta.env.VITE_WHATSAPP_DAILY_CAP
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function resolveMetaSafeDailyCap(opts: {
  configuredDailyCap?: number
  hardCap?: number
} = {}): ResolvedMetaSafeDailyCap {
  const hardCap = Math.max(1, Math.floor(opts.hardCap ?? META_SAFE_HARD_DAILY_CAP))
  const configured = opts.configuredDailyCap
  if (configured != null && Number.isFinite(configured) && configured > 0) {
    return {
      dailyCap: Math.min(Math.floor(configured), hardCap),
      hardCap,
      source: 'configured',
    }
  }
  return {
    dailyCap: Math.min(META_SAFE_DEFAULT_DAILY_CAP, hardCap),
    hardCap,
    source: 'default',
  }
}

function isSameLocalDay(iso: string | null, now: Date): boolean {
  if (!iso) return false
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return false
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

export function computeSafeDisparoPlan(input: SafeDisparoPlanInput): SafeDisparoPlan {
  const now = input.now ?? new Date()
  const cap = resolveMetaSafeDailyCap({
    configuredDailyCap: input.configuredDailyCap,
    hardCap: input.hardCap,
  })
  const sentToday = input.allLeads.filter((lead) => isSameLocalDay(lead.whatsapp_sent_at, now)).length
  const remainingToday = Math.max(0, cap.dailyCap - sentToday)
  const maxBatchSize = Math.max(1, Math.floor(input.maxBatchSize ?? META_SAFE_BATCH_SIZE))
  const maxNow = Math.min(remainingToday, maxBatchSize)
  const batchIds = input.selectedIds.slice(0, maxNow)

  return {
    ...cap,
    sentToday,
    remainingToday,
    batchIds,
    deferredIds: input.selectedIds.slice(maxNow),
    maxBatchSize,
    batchDelayMs: Math.max(0, Math.floor(input.batchDelayMs ?? META_SAFE_BATCH_DELAY_MS)),
  }
}
