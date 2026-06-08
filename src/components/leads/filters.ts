import type { LeadStatus } from '../../lib/types'

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
