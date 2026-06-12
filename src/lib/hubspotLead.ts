import type { Lead } from './types'

export type HubspotFilter = 'ready' | 'missing' | 'exported'

export const HUBSPOT_FILTERS: HubspotFilter[] = ['ready', 'missing', 'exported']

export function hubspotDedupValue(
  lead: Pick<Lead, 'google_place_id' | 'squad_leads_id'>,
): string | null {
  if (lead.google_place_id) return lead.google_place_id
  return null
}

export function podeExportar(lead: Pick<Lead, 'nome' | 'google_place_id' | 'squad_leads_id'>): boolean {
  return !!lead.nome && !!lead.google_place_id
}

export function isHubspotExported(
  lead: Pick<Lead, 'hubspot_exported_at' | 'hubspot_contact_id' | 'hubspot_deal_id'>,
): boolean {
  return !!lead.hubspot_exported_at || !!lead.hubspot_contact_id || !!lead.hubspot_deal_id
}

export function hubspotFilterMatches(lead: Lead, filter: HubspotFilter): boolean {
  const exported = isHubspotExported(lead)

  if (filter === 'exported') return exported
  if (exported) return false

  const ready = podeExportar(lead)
  return filter === 'ready' ? ready : !ready
}

export function hubspotFilterLabel(filter: HubspotFilter): string {
  switch (filter) {
    case 'ready':
      return 'Pronto para HubSpot'
    case 'missing':
      return 'Faltando dados'
    case 'exported':
      return 'Já exportado'
  }
}
