import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useLeads, useDeleteLeads } from '../lib/leads'
import { applyFilters, distinctBairros, distinctSetores, EMPTY_FILTERS } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'
import { EnriquecerTable } from '../components/leads/EnriquecerTable'
import { LeadFilters } from '../components/leads/LeadFilters'
import { BatchEnrich } from '../components/leads/BatchEnrich'
import { BatchWhatsapp } from '../components/leads/BatchWhatsapp'
import { BatchHubspot } from '../components/leads/BatchHubspot'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { ConfirmDialog } from '../components/ConfirmDialog'

function SkeletonTable() {
  return (
    <div className="table-wrap">
      <table className="leads-table">
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="skeleton-row">
              <td colSpan={9}>
                <div className="skeleton-bar" style={{ width: `${90 - i * 6}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Enriquecer() {
  const { data: leads = [], isLoading, isError, error } = useLeads()
  const deleteLeads = useDeleteLeads()
  // Seleção e filtros locais (não compartilham com a Etapa 01 / mapa).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)

  // Pool desta etapa: qualificado (a enriquecer) + enriquecido (já feitos).
  const pool = useMemo(
    () => leads.filter((l) => l.status === 'qualificado' || l.status === 'enriquecido'),
    [leads],
  )
  const bairros = useMemo(() => distinctBairros(pool), [pool])
  const setores = useMemo(() => distinctSetores(pool), [pool])
  const visible = useMemo(() => applyFilters(pool, filters), [pool, filters])

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null
  const selectedVisible = useMemo<Set<string>>(
    () => new Set(visible.filter((l) => selectedIds.has(l.id)).map((l) => l.id)),
    [visible, selectedIds],
  )

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

  function confirmarDelete() {
    if (!confirmIds) return
    const ids = confirmIds
    deleteLeads.mutate(ids, {
      onSuccess: () => {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          ids.forEach((id) => next.delete(id))
          return next
        })
        if (openId && ids.includes(openId)) setOpenId(null)
        setConfirmIds(null)
      },
    })
  }

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">02 · Enriquecer</div>
        <h1>Enriquecer</h1>
      </header>

      <div className="leads-body">
        <LeadFilters
          filters={filters}
          onChange={setFilters}
          bairros={bairros}
          setores={setores}
          statusOptions={['qualificado', 'enriquecido']}
        />

        <div>
          <div className="table-bar">
            <span className="table-count">
              <b>{visible.length}</b> {visible.length === 1 ? 'lead' : 'leads'}
            </span>
            <div className="table-actions">
              <BatchEnrich leads={leads} selectedIds={selectedVisible} />
              <BatchWhatsapp leads={leads} selectedIds={selectedVisible} />
              <BatchHubspot leads={leads} selectedIds={selectedVisible} />
              <button
                className="btn ghost danger"
                disabled={selectedVisible.size === 0}
                onClick={() => setConfirmIds([...selectedVisible])}
              >
                <Trash2 size={15} /> Deletar
              </button>
            </div>
          </div>

          {isLoading ? (
            <SkeletonTable />
          ) : isError ? (
            <div className="callout">Não foi possível carregar os leads: {(error as Error).message}</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <h3>{pool.length === 0 ? 'Nada a enriquecer' : 'Nada com esses filtros'}</h3>
              <p>
                {pool.length === 0
                  ? 'Avance negócios na etapa 01 · Buscar para enriquecê-los aqui.'
                  : 'Ajuste ou limpe os filtros para ver mais.'}
              </p>
            </div>
          ) : (
            <EnriquecerTable
              leads={visible}
              selectedIds={selectedIds}
              onToggleOne={toggleOne}
              onToggleAll={toggleAll}
              onOpen={setOpenId}
              onDelete={(id) => setConfirmIds([id])}
            />
          )}
        </div>
      </div>

      {openLead && <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />}

      {confirmIds && (
        <ConfirmDialog
          title={`Deletar ${confirmIds.length} ${confirmIds.length === 1 ? 'lead' : 'leads'}?`}
          message="Esta ação não pode ser desfeita."
          confirmLabel="Deletar"
          destructive
          busy={deleteLeads.isPending}
          onConfirm={confirmarDelete}
          onCancel={() => setConfirmIds(null)}
        />
      )}
    </>
  )
}
