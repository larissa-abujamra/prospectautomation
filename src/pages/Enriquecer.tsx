import { useMemo, useState } from 'react'
import { useLeads } from '../lib/leads'
import type { Lead } from '../lib/types'
import { EnriquecerTable } from '../components/leads/EnriquecerTable'
import { BatchEnrich } from '../components/leads/BatchEnrich'
import { BatchHubspot } from '../components/leads/BatchHubspot'
import { LeadDrawer } from '../components/leads/LeadDrawer'

type View = 'qualificado' | 'enriquecido'

function SkeletonTable() {
  return (
    <div className="table-wrap">
      <table className="leads-table">
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="skeleton-row">
              <td colSpan={8}>
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
  // Seleção local (a desta etapa) — não compartilha com a Etapa 01 / mapa.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View>('qualificado')
  const [openId, setOpenId] = useState<string | null>(null)

  const aEnriquecer = useMemo(() => leads.filter((l) => l.status === 'qualificado'), [leads])
  const enriquecidos = useMemo(() => leads.filter((l) => l.status === 'enriquecido'), [leads])
  const visible = view === 'qualificado' ? aEnriquecer : enriquecidos

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null
  // Restringe a seleção ao que está visível (para os botões de lote).
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

  const Pills = (
    <div className="seg">
      <button className={view === 'qualificado' ? 'active' : ''} onClick={() => setView('qualificado')}>
        A enriquecer · {aEnriquecer.length}
      </button>
      <button className={view === 'enriquecido' ? 'active' : ''} onClick={() => setView('enriquecido')}>
        Enriquecidos · {enriquecidos.length}
      </button>
    </div>
  )

  const selectedLeads: Lead[] = leads.filter((l) => selectedVisible.has(l.id))

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">02 · Enriquecer</div>
        <h1>Enriquecer</h1>
      </header>

      <div className="table-bar">
        {Pills}
        <div className="table-actions">
          {view === 'qualificado' ? (
            <BatchEnrich leads={leads} selectedIds={selectedVisible} />
          ) : (
            <BatchHubspot leads={selectedLeads} selectedIds={selectedVisible} />
          )}
        </div>
      </div>

      {isLoading ? (
        <SkeletonTable />
      ) : isError ? (
        <div className="callout">Não foi possível carregar os leads: {(error as Error).message}</div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <h3>{view === 'qualificado' ? 'Nada a enriquecer' : 'Nenhum enriquecido ainda'}</h3>
          <p>
            {view === 'qualificado'
              ? 'Avance negócios na etapa 01 · Buscar para enriquecê-los aqui.'
              : 'Enriqueça os leads qualificados para vê-los aqui.'}
          </p>
        </div>
      ) : (
        <EnriquecerTable
          leads={visible}
          selectedIds={selectedIds}
          onToggleOne={toggleOne}
          onToggleAll={toggleAll}
          onOpen={setOpenId}
        />
      )}

      {openLead && <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />}
    </>
  )
}
