import { useMemo, useState } from 'react'
import { useLeads } from '../lib/leads'
import { SearchPanel } from '../components/leads/SearchPanel'
import { FilterSidebar } from '../components/leads/FilterSidebar'
import { EMPTY_FILTERS } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'
import { LeadsTable } from '../components/leads/LeadsTable'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { CsvImport } from '../components/leads/CsvImport'
import { BatchEnrich } from '../components/leads/BatchEnrich'

function SkeletonTable() {
  return (
    <div className="table-wrap">
      <table className="leads-table">
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="skeleton-row">
              <td colSpan={11}>
                <div className="skeleton-bar" style={{ width: `${90 - i * 6}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Leads() {
  const { data: leads = [], isLoading, isError, error } = useLeads()
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)

  const bairros = useMemo(
    () =>
      Array.from(new Set(leads.map((l) => l.bairro).filter((b): b is string => !!b))).sort(
        (a, b) => a.localeCompare(b, 'pt-BR'),
      ),
    [leads],
  )

  const filtered = useMemo(() => {
    return leads.filter((l) => {
      if (filters.bairro && l.bairro !== filters.bairro) return false
      if (filters.minRating > 0 && (l.rating == null || l.rating < filters.minRating)) return false
      if (filters.minReviews !== '' && (l.reviews_count == null || l.reviews_count < filters.minReviews))
        return false

      // Filtro de seguidores (ICP) + toggle de degradação graciosa.
      if (l.instagram_followers == null) {
        if (!filters.includeNoFollowers) return false
      } else if (filters.minFollowers !== '' && l.instagram_followers < filters.minFollowers) {
        return false
      }

      if (filters.statuses.length > 0 && !filters.statuses.includes(l.status)) return false
      return true
    })
  }, [leads, filters])

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(ids: string[], select: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (select) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Pipeline</div>
        <h1>Leads</h1>
      </header>

      <SearchPanel />

      <div className="leads-body">
        <FilterSidebar filters={filters} onChange={setFilters} bairros={bairros} />

        <div>
          <div className="table-bar">
            <span className="table-count">
              <b>{filtered.length}</b> {filtered.length === 1 ? 'doceria' : 'docerias'}
            </span>
            <div className="table-actions">
              <CsvImport leads={leads} />
              <BatchEnrich leads={leads} selectedIds={selectedIds} />
            </div>
          </div>

          {isLoading ? (
            <SkeletonTable />
          ) : isError ? (
            <div className="callout">Não foi possível carregar os leads: {(error as Error).message}</div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <h3>{leads.length === 0 ? 'Nenhum lead ainda' : 'Nada com esses filtros'}</h3>
              <p>
                {leads.length === 0
                  ? 'Busque um bairro acima para descobrir docerias no Google.'
                  : 'Ajuste ou limpe os filtros para ver mais docerias.'}
              </p>
            </div>
          ) : (
            <LeadsTable
              leads={filtered}
              selectedIds={selectedIds}
              onToggleOne={toggleOne}
              onToggleAll={toggleAll}
              onOpen={setOpenId}
            />
          )}
        </div>
      </div>

      {openLead && (
        <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />
      )}
    </>
  )
}
