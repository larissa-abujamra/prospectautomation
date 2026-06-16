import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loader2, Route, Send, Square, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useLeads,
  useDeleteLeads,
  useSetStatusBulk,
  LEADS_KEY,
} from '../lib/leads'
import { runEnrichment, precisaEnriquecer } from '../lib/enrichRunner'
import { dispararLote, type DisparoResumo } from '../lib/disparoRunner'
import { isClienteOcultoPendente } from '../lib/clienteOculto'
import { useLeadsUI } from '../context/leadsUI'
import { applyFilters, distinctBairros, distinctSetores, EMPTY_FILTERS, isBaseLead } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'
import { EnriquecerTable } from '../components/leads/EnriquecerTable'
import { LeadFilters } from '../components/leads/LeadFilters'
import { Bandeja } from '../components/leads/Bandeja'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { ClienteOcultoTab } from '../components/leads/ClienteOcultoTab'
import { ConfirmDialog } from '../components/ConfirmDialog'

// Aba ativa da Base. Vive na URL (?tab=) para refresh/compartilhar/voltar não
// perderem a aba e para o redirect antigo /cliente-oculto cair direto nela.
type Tab = 'leads' | 'cliente-oculto'

function SkeletonTable() {
  return (
    <div className="table-wrap">
      <table className="leads-table">
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="skeleton-row">
              <td colSpan={10}>
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
  const qc = useQueryClient()
  const { data: leads = [], isLoading, isError, error } = useLeads()
  const deleteLeads = useDeleteLeads()
  const setStatus = useSetStatusBulk()
  // Seleção compartilhada no context (re-layout Fase 2): a Bandeja limpa a
  // seleção pelo mesmo lugar, e trocar de tela preserva o que foi marcado.
  const { selectedIds, toggleOne, toggleAll } = useLeadsUI()
  // Aba ativa lida da URL (fonte da verdade): ?tab=cliente-oculto ou Todos (default).
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: Tab = searchParams.get('tab') === 'cliente-oculto' ? 'cliente-oculto' : 'leads'
  function setTab(t: Tab) {
    // Default ('leads') sai como URL limpa /base; replace pra não empilhar histórico.
    setSearchParams(t === 'cliente-oculto' ? { tab: 'cliente-oculto' } : {}, { replace: true })
  }
  // Filtros locais da página (o pool desta etapa é outro: qualificado/enriquecido).
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  // Progresso e resultado do "Enviar disparo" (lote via lib/disparoRunner).
  const [disparo, setDisparo] = useState<{ done: number; total: number } | null>(null)
  const [disparoResumo, setDisparoResumo] = useState<DisparoResumo | null>(null)
  const stopRef = useRef(false)

  // Desmontou com o lote rodando → sinaliza parada (loop é fire-and-forget).
  useEffect(() => () => { stopRef.current = true }, [])

  // Pool desta etapa: qualificado (a enriquecer) + enriquecido (já feitos).
  // isBaseLead é a MESMA regra do badge no menu (Sidebar) — não podem divergir.
  const pool = useMemo(() => leads.filter((l) => isBaseLead(l.status)), [leads])
  // Contador do badge da aba "Cliente oculto" (mesma régua do antigo badge do menu).
  const ocultoPendentes = useMemo(() => leads.filter(isClienteOcultoPendente).length, [leads])
  const bairros = useMemo(() => distinctBairros(pool), [pool])
  const setores = useMemo(() => distinctSetores(pool), [pool])
  const visible = useMemo(() => applyFilters(pool, filters), [pool, filters])

  // Auto-retomada: leads avançados que chegaram aqui ainda pendentes (lote do
  // Buscar não terminou, ou a aba foi reaberta) retomam o enriquecimento sozinhos.
  // runEnrichment dedup por sessão e não toca quem já está 'enriquecido'.
  useEffect(() => {
    const pendentes = pool.filter(precisaEnriquecer).map((l) => l.id)
    if (pendentes.length > 0) runEnrichment(pendentes, qc)
  }, [pool, qc])

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null
  // Seleção restrita ao que está visível nesta etapa.
  const selectedVisible = useMemo(
    () => visible.filter((l) => selectedIds.has(l.id)),
    [visible, selectedIds],
  )

  // Disparo em lote via lib/disparoRunner (átomo testado, compartilhado com a Olivia).
  // Ao fim mostra o RESUMO (disparados / sem nº / erros) — antes este loop engolia
  // falha com catch {} e dizia "N/N concluído" mesmo sem nada ter saído (auditoria).
  async function enviarDisparo() {
    const fila = selectedVisible
    if (fila.length === 0 || disparo) return
    stopRef.current = false
    setDisparoResumo(null)
    setDisparo({ done: 0, total: fila.length })
    const resumo = await dispararLote(
      fila,
      (_r, i) => {
        setDisparo({ done: i + 1, total: fila.length })
        void qc.invalidateQueries({ queryKey: LEADS_KEY })
      },
      { sinalParar: () => stopRef.current },
    )
    setDisparo(null)
    setDisparoResumo(resumo)
  }

  async function mandarRota() {
    const ids = selectedVisible.map((l) => l.id)
    if (ids.length === 0) return
    await setStatus.mutateAsync({ ids, status: 'em_rota' })
    toggleAll(ids, false)
  }

  async function descartar() {
    const ids = selectedVisible.map((l) => l.id)
    if (ids.length === 0) return
    await setStatus.mutateAsync({ ids, status: 'descartado' })
    toggleAll(ids, false)
  }

  function confirmarDelete() {
    if (!confirmIds) return
    const ids = confirmIds
    deleteLeads.mutate(ids, {
      onSuccess: () => {
        toggleAll(ids, false)
        if (openId && ids.includes(openId)) setOpenId(null)
        setConfirmIds(null)
      },
    })
  }

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Base de Dados</div>
        <h1>Base de Dados</h1>
      </header>

      <div className="view-toggle" role="tablist" aria-label="Vista da Base">
        <button
          role="tab"
          aria-selected={tab === 'leads'}
          className={`vt-btn${tab === 'leads' ? ' active' : ''}`}
          onClick={() => setTab('leads')}
        >
          Todos
        </button>
        <button
          role="tab"
          aria-selected={tab === 'cliente-oculto'}
          className={`vt-btn${tab === 'cliente-oculto' ? ' active' : ''}`}
          onClick={() => setTab('cliente-oculto')}
        >
          Cliente oculto
          {ocultoPendentes > 0 && tab !== 'cliente-oculto' && (
            <span className="badge" style={{ marginLeft: 6 }}>{ocultoPendentes}</span>
          )}
        </button>
      </div>

      {tab === 'cliente-oculto' ? (
        <ClienteOcultoTab onOpenLead={setOpenId} />
      ) : (
      <>
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
          <b>{visible.length}</b> {visible.length === 1 ? 'lead' : 'leads'}
        </span>
        {disparoResumo && (
          <span
            className={`disparo-resumo${disparoResumo.erros > 0 ? ' tem-erro' : ''}`}
            role="status"
            onClick={() => setDisparoResumo(null)}
            title="Clique para dispensar"
          >
            <b>{disparoResumo.disparados}</b> disparado(s)
            {disparoResumo.semNumero > 0 && <> · {disparoResumo.semNumero} sem nº</>}
            {disparoResumo.erros > 0 && <> · <b>{disparoResumo.erros} com erro</b></>}
          </span>
        )}
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
              ? 'Busque negócios em /buscar e avance-os para enriquecê-los aqui.'
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
        />
      )}

      {/* Bandeja: única casa de ações em lote desta página (re-layout Fase 2). */}
      <Bandeja count={selectedVisible.length}>
        {disparo ? (
          <>
            <Loader2 size={15} className="spin" />
            <div className="progress">
              <span style={{ width: `${disparo.total ? (disparo.done / disparo.total) * 100 : 0}%` }} />
            </div>
            <span className="batch-label">
              {disparo.done}/{disparo.total}
            </span>
            <button
              className="bandeja-btn ghost"
              onClick={() => (stopRef.current = true)}
              title="Para após o lead atual terminar (não cancela o que já está em andamento)."
            >
              <Square size={13} /> Parar
            </button>
          </>
        ) : (
          <>
            <button
              className="bandeja-btn"
              onClick={enviarDisparo}
              title="Acha o número de quem não tem e aciona o workflow do template no HubSpot."
            >
              <Send size={15} /> Enviar disparo
            </button>
            <button className="bandeja-btn" onClick={mandarRota} disabled={setStatus.isPending}>
              <Route size={15} /> Mandar pra rota
            </button>
            <button className="bandeja-btn ghost" onClick={descartar} disabled={setStatus.isPending}>
              <Trash2 size={15} /> Descartar
            </button>
            {/* Hard-delete mora aqui (Bandeja = única casa de ações): abre o
              ConfirmDialog antes de apagar de verdade. */}
            <button
              className="bandeja-btn ghost danger"
              onClick={() => setConfirmIds(selectedVisible.map((l) => l.id))}
              disabled={deleteLeads.isPending}
              title="Apaga os leads selecionados da base. Pede confirmação — a ação não pode ser desfeita."
            >
              <Trash2 size={15} /> Deletar
            </button>
          </>
        )}
      </Bandeja>
      </>
      )}

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
