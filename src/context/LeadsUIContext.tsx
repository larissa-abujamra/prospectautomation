import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { EMPTY_FILTERS } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'
import { LeadsUICtx } from './leadsUI'

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

  return <LeadsUICtx.Provider value={value}>{children}</LeadsUICtx.Provider>
}
