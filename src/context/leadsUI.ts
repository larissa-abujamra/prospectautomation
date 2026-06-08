import { createContext, useContext } from 'react'
import type { Filters } from '../components/leads/filters'

// Estado de UI compartilhado entre a tabela de Leads (/) e o Mapa (/mapa):
// os MESMOS filtros valem nas duas telas, e a seleção feita na tabela vira
// input de rota no mapa.
export interface LeadsUI {
  filters: Filters
  setFilters: (f: Filters) => void
  selectedIds: Set<string>
  toggleOne: (id: string) => void
  toggleAll: (ids: string[], select: boolean) => void
  clearSelection: () => void
}

export const LeadsUICtx = createContext<LeadsUI | null>(null)

export function useLeadsUI(): LeadsUI {
  const ctx = useContext(LeadsUICtx)
  if (!ctx) throw new Error('useLeadsUI deve ser usado dentro de <LeadsUIProvider>')
  return ctx
}
