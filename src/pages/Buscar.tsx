import { useMemo, useState } from 'react'
import { ArrowRight, Trash2 } from 'lucide-react'
import { useLeads, useSetStatusBulk } from '../lib/leads'
import { useLeadsUI } from '../context/leadsUI'
import { distinctBairros, distinctSetores } from '../components/leads/filters'
import { SearchPanel } from '../components/leads/SearchPanel'
import { LeadFilters } from '../components/leads/LeadFilters'
import { BuscarTable } from '../components/leads/BuscarTable'
import { LeadDrawer } from '../components/leads/LeadDrawer'

function SkeletonTable() {
  return (
    <div className="table-wrap">
      <table className="leads-table">
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="skeleton-row">
              <td colSpan={6}>
                <div className="skeleton-bar" style={{ width: `${90 - i * 6}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Buscar() {
  const { data: leads = [], isLoading, isError, error } = useLeads()
  const { filters, setFilters, selectedIds, toggleOne, toggleAll, clearSelection } = useLeadsUI()
  const setStatus = useSetStatusBulk()
  const [openId, setOpenId] = useState<string | null>(null)

  const bairros = useMemo(() => distinctBairros(leads), [leads])
  const setores = useMemo(() => distinctSetores(leads), [leads])

  // Etapa 01 mostra só o pool cru (descoberto), filtrado por bairro/setor/seguidores.
  const visible = useMemo(() => {
    return leads.filter((l) => {
      if (l.status !== 'descoberto') return false
      if (filters.bairro && l.bairro !== filters.bairro) return false
      if (filters.setor && l.setor !== filters.setor) return false
      if (l.instagram_followers == null) {
        if (!filters.includeNoFollowers) return false
      } else if (filters.minFollowers !== '' && l.instagram_followers < filters.minFollowers) {
        return false
      }
      return true
    })
  }, [leads, filters])

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null
  // Seleção restrita ao que está visível nesta etapa.
  const selectedVisible = visible.filter((l) => selectedIds.has(l.id)).map((l) => l.id)

  async function avancar() {
    if (selectedVisible.length === 0) return
    await setStatus.mutateAsync({ ids: selectedVisible, status: 'qualificado' })
    clearSelection()
  }
  async function descartar() {
    if (selectedVisible.length === 0) return
    await setStatus.mutateAsync({ ids: selectedVisible, status: 'descartado' })
    clearSelection()
  }

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">01 · Buscar</div>
        <h1>Buscar negócios</h1>
      </header>

      <SearchPanel />

      <div className="leads-body">
        <LeadFilters filters={filters} onChange={setFilters} bairros={bairros} setores={setores} />

        <div>
          <div className="table-bar">
            <span className="table-count">
              <b>{visible.length}</b> {visible.length === 1 ? 'negócio' : 'negócios'}
            </span>
            <div className="table-actions">
              <button
                className="btn"
                onClick={avancar}
                disabled={selectedVisible.length === 0 || setStatus.isPending}
              >
                <ArrowRight size={15} /> Avançar {selectedVisible.length} selecionado
                {selectedVisible.length === 1 ? '' : 's'}
              </button>
              <button
                className="btn ghost"
                onClick={descartar}
                disabled={selectedVisible.length === 0 || setStatus.isPending}
              >
                <Trash2 size={15} /> Descartar
              </button>
            </div>
          </div>

          {isLoading ? (
            <SkeletonTable />
          ) : isError ? (
            <div className="callout">Não foi possível carregar os leads: {(error as Error).message}</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <h3>{leads.some((l) => l.status === 'descoberto') ? 'Nada com esses filtros' : 'Nenhum negócio novo'}</h3>
              <p>
                {leads.some((l) => l.status === 'descoberto')
                  ? 'Ajuste ou limpe os filtros para ver mais.'
                  : 'Busque um setor e um bairro acima para descobrir negócios no Google.'}
              </p>
            </div>
          ) : (
            <BuscarTable
              leads={visible}
              selectedIds={selectedIds}
              onToggleOne={toggleOne}
              onToggleAll={toggleAll}
              onOpen={setOpenId}
            />
          )}
        </div>
      </div>

      {openLead && <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />}
    </>
  )
}
