import type { Lead, LeadStatus } from '../../lib/types'

export interface Filters {
  bairro: string // '' = todos
  minRating: number // 0..5
  minReviews: number | '' // '' = sem filtro
  minFollowers: number | '' // '' = sem filtro (filtro do ICP)
  includeNoFollowers: boolean // mostra leads com seguidores = null
  statuses: LeadStatus[] // [] = todos
}

export const EMPTY_FILTERS: Filters = {
  bairro: '',
  minRating: 0,
  minReviews: '',
  minFollowers: '',
  includeNoFollowers: true,
  statuses: [],
}

export function isFiltering(f: Filters): boolean {
  return (
    f.bairro !== '' ||
    f.minRating > 0 ||
    f.minReviews !== '' ||
    f.minFollowers !== '' ||
    !f.includeNoFollowers ||
    f.statuses.length > 0
  )
}

// Lógica única de filtragem — usada pela tabela de Leads E pelo mapa.
export function applyFilters(leads: Lead[], f: Filters): Lead[] {
  return leads.filter((l) => {
    if (f.bairro && l.bairro !== f.bairro) return false
    if (f.minRating > 0 && (l.rating == null || l.rating < f.minRating)) return false
    if (f.minReviews !== '' && (l.reviews_count == null || l.reviews_count < f.minReviews))
      return false
    // Filtro de seguidores (ICP) + toggle de degradação graciosa.
    if (l.instagram_followers == null) {
      if (!f.includeNoFollowers) return false
    } else if (f.minFollowers !== '' && l.instagram_followers < f.minFollowers) {
      return false
    }
    if (f.statuses.length > 0 && !f.statuses.includes(l.status)) return false
    return true
  })
}

export function distinctBairros(leads: Lead[]): string[] {
  return Array.from(
    new Set(leads.map((l) => l.bairro).filter((b): b is string => !!b)),
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'))
}
