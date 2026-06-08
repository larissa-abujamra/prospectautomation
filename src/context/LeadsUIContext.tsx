import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { EMPTY_FILTERS } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'

// Estado de UI compartilhado entre a tabela de Leads (/) e o Mapa (/mapa):
// os MESMOS filtros valem nas duas telas, e a seleção feita na tabela vira
// input de rota no mapa.
interface LeadsUI {
  filters: Filters
  setFilters: (f: Filters) => void
  selectedIds: Set<string>
  toggleOne: (id: string) => void
  toggleAll: (ids: string[], select: boolean) => void
  clearSelection: () => void
}

const Ctx = createContext<LeadsUI | null>(null)

export function LeadsUIProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback((ids: string[], select: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (select) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const value = useMemo(
    () => ({ filters, setFilters, selectedIds, toggleOne, toggleAll, clearSelection }),
    [filters, selectedIds, toggleOne, toggleAll, clearSelection],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useLeadsUI(): LeadsUI {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useLeadsUI deve ser usado dentro de <LeadsUIProvider>')
  return ctx
}
