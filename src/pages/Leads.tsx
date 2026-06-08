import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapPinned } from 'lucide-react'
import { useLeads } from '../lib/leads'
import { useLeadsUI } from '../context/LeadsUIContext'
import { applyFilters, distinctBairros } from '../components/leads/filters'
import { SearchPanel } from '../components/leads/SearchPanel'
import { FilterSidebar } from '../components/leads/FilterSidebar'
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
  const navigate = useNavigate()
  const { data: leads = [], isLoading, isError, error } = useLeads()
  const { filters, setFilters, selectedIds, toggleOne, toggleAll } = useLeadsUI()
  const [openId, setOpenId] = useState<string | null>(null)

  const bairros = useMemo(() => distinctBairros(leads), [leads])
  const filtered = useMemo(() => applyFilters(leads, filters), [leads, filters])
  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null

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
              {selectedIds.size > 0 && (
                <button
                  className="btn ghost"
                  onClick={() => navigate('/mapa', { state: { routeIds: [...selectedIds] } })}
                  title="Levar a seleção para o mapa e montar uma rota"
                >
                  <MapPinned size={15} /> Rotear {selectedIds.size}
                </button>
              )}
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
