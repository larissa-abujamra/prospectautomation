import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Trash2, Sparkles } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useLeads, useSetStatusBulk, useAdvanceToEnrich } from '../lib/leads'
import { runEnrichment } from '../lib/enrichRunner'
import { runFollowers, precisaSeguidores } from '../lib/followersRunner'
import { useLeadsUI } from '../context/leadsUI'
import { applyFilters, distinctBairros, distinctSetores } from '../components/leads/filters'
import { SearchPanel } from '../components/leads/SearchPanel'
import { LeadFilters } from '../components/leads/LeadFilters'
import { BuscarTable } from '../components/leads/BuscarTable'
import { Bandeja } from '../components/leads/Bandeja'
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
  const qc = useQueryClient()
  const { data: leads = [], isLoading, isError, error } = useLeads()
  const { filters, setFilters, selectedIds, toggleOne, toggleAll, clearSelection } = useLeadsUI()
  const setStatus = useSetStatusBulk()
  const advance = useAdvanceToEnrich()
  const [openId, setOpenId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Toast some sozinho.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const bairros = useMemo(() => distinctBairros(leads), [leads])
  const setores = useMemo(() => distinctSetores(leads), [leads])

  // Instagram automático em segundo plano: após a busca, os leads 'descoberto'
  // sem nº de seguidores têm o @handle descoberto (se faltar) e os seguidores
  // buscados sozinhos — concorrência limitada, sem travar a tabela; as colunas
  // preenchem conforme cada perfil volta.
  useEffect(() => {
    const elegiveis = leads
      .filter((l) => l.status === 'descoberto' && precisaSeguidores(l))
      .map((l) => ({ id: l.id, handle: l.instagram_handle, nome: l.nome, cidade: l.cidade }))
    if (elegiveis.length > 0) runFollowers(elegiveis, qc)
  }, [leads, qc])

  // Etapa 01 mostra só o pool cru (descoberto), filtrado por bairro/setor/seguidores.
  const visible = useMemo(() => {
    return applyFilters(leads.filter((l) => l.status === 'descoberto'), filters)
  }, [leads, filters])

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null
  // Seleção restrita ao que está visível nesta etapa.
  const selectedVisible = visible.filter((l) => selectedIds.has(l.id)).map((l) => l.id)

  async function avancar() {
    if (selectedVisible.length === 0) return
    const ids = selectedVisible
    // 1) marca qualificado + enrich pendente (UI já mostra "enriquecendo")
    await advance.mutateAsync(ids)
    // 2) dispara o enriquecimento em segundo plano (não bloqueia a navegação)
    runEnrichment(ids, qc)
    setToast(`Enriquecendo ${ids.length} ${ids.length === 1 ? 'lead' : 'leads'} em segundo plano…`)
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

      <div className="buscar-filter-bar">
        <span className="eyebrow buscar-filter-label">Filtros</span>
        <LeadFilters
          filters={filters}
          onChange={setFilters}
          bairros={bairros}
          setores={setores}
        />
      </div>

      <div className="table-bar">
        <span className="table-count">
          <b>{visible.length}</b> {visible.length === 1 ? 'negócio' : 'negócios'}
        </span>
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

      {/* Bandeja: única casa de ações em lote desta página (re-layout Fase 2). */}
      <Bandeja count={selectedVisible.length}>
        <button className="bandeja-btn" onClick={avancar} disabled={advance.isPending}>
          <ArrowRight size={15} /> Avançar p/ Base
        </button>
        <button className="bandeja-btn ghost" onClick={descartar} disabled={setStatus.isPending}>
          <Trash2 size={15} /> Descartar
        </button>
      </Bandeja>

      {openLead && <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />}

      {toast && (
        <div className="toast">
          <Sparkles size={15} /> {toast}
        </div>
      )}
    </>
  )
}
