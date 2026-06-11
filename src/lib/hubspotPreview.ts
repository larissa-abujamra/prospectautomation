import type { Lead } from './types'

export interface HubspotPreviewRow {
  label: string
  value: string
}

const EMPTY = '—'

function text(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : EMPTY
}

function instagram(handle: string | null): string {
  const trimmed = handle?.trim().replace(/^@/, '')
  return trimmed ? `@${trimmed}` : EMPTY
}

function whatsapp(lead: Lead): string {
  return text(lead.whatsapp_dono || lead.whatsapp_phone)
}

export function buildHubspotPreview(lead: Lead): HubspotPreviewRow[] {
  return [
    { label: 'Nome', value: text(lead.nome) },
    { label: 'Website', value: text(lead.website) },
    { label: 'Instagram', value: instagram(lead.instagram_handle) },
    { label: 'CNPJ', value: text(lead.cnpj) },
    { label: 'Dono', value: text(lead.dono_nome) },
    { label: 'WhatsApp', value: whatsapp(lead) },
  ]
}

function normalizedKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export function websiteInstagramMismatchWarning(lead: Lead): string | null {
  const website = lead.website?.trim()
  const handle = lead.instagram_handle?.trim().replace(/^@/, '')
  if (!website || !handle) return null

  let url: URL
  try {
    url = new URL(website)
  } catch {
    return null
  }

  const handleKey = normalizedKey(handle)
  if (!handleKey) return null

  const hostKey = normalizedKey(url.hostname.replace(/^www\./, ''))
  if (hostKey.includes('instagramcom')) {
    const profile = url.pathname.split('/').filter(Boolean)[0]
    if (!profile) return null
    return normalizedKey(profile) === handleKey
      ? null
      : 'Website e Instagram parecem apontar para marcas diferentes. Confira antes de criar no HubSpot.'
  }

  return hostKey.includes(handleKey)
    ? null
    : 'Website e Instagram parecem apontar para marcas diferentes. Confira antes de criar no HubSpot.'
}
