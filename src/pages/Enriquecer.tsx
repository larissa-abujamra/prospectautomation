import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Database, Download, Loader2, Route, Search, Send, SlidersHorizontal, Square, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useLeads,
  useDeleteLeads,
  useSetStatusBulk,
  LEADS_KEY,
} from '../lib/leads'
import { runEnrichment, precisaEnriquecer } from '../lib/enrichRunner'
import { dispararLote, type DisparoResumo } from '../lib/disparoRunner'
import { useLeadsUI } from '../context/leadsUI'
import { applyFilters, distinctBairros, distinctSetores, EMPTY_FILTERS, isBaseLead } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'
import { EnriquecerTable } from '../components/leads/EnriquecerTable'
import { LeadFilters } from '../components/leads/LeadFilters'
import { Bandeja } from '../components/leads/Bandeja'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { ClienteOcultoTab } from '../components/leads/ClienteOcultoTab'
import { STATUS_META } from '../lib/types'
import { toCsv, downloadCsv } from '../lib/csv'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { computeSafeDisparoPlan, readMetaSafeDailyCapFromEnv } from '../lib/safeProspecting'

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
  // Filtros agora moram num popover (botão "Filters"); busca textual no header.
  const [filtrosAbertos, setFiltrosAbertos] = useState(false)
  const [busca, setBusca] = useState('')
  const filtrosRef = useRef<HTMLDivElement | null>(null)

  // Fecha o popover de filtros ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!filtrosAbertos) return
    function onDown(e: MouseEvent) {
      if (filtrosRef.current && !filtrosRef.current.contains(e.target as Node)) setFiltrosAbertos(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFiltrosAbertos(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [filtrosAbertos])
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  // Progresso e resultado do "Enviar disparo" (lote via lib/disparoRunner).
  const [disparo, setDisparo] = useState<{ done: number; total: number } | null>(null)
  const [disparoResumo, setDisparoResumo] = useState<DisparoResumo | null>(null)
  const stopRef = useRef(false)

  // Desmontou com o lote rodando → sinaliza parada (loop é fire-and-forget).
  useEffect(() => () => { stopRef.current = true }, [])

  // Pinta o painel de conteúdo com o gradiente (mesma regra de Prospecção),
  // só nesta rota. Sai da página → remove.
  useEffect(() => {
    document.body.classList.add('base-dados')
    return () => document.body.classList.remove('base-dados')
  }, [])

  // Pool desta etapa: qualificado (a enriquecer) + enriquecido (já feitos).
  // isBaseLead é a MESMA regra do badge no menu (Sidebar) — não podem divergir.
  const pool = useMemo(() => leads.filter((l) => isBaseLead(l.status)), [leads])
  const bairros = useMemo(() => distinctBairros(pool), [pool])
  const setores = useMemo(() => distinctSetores(pool), [pool])
  // Filtros do popover + busca textual (aditiva): nome/bairro/setor contendo o texto.
  const visible = useMemo(() => {
    const base = applyFilters(pool, filters)
    const q = busca.trim().toLowerCase()
    if (q === '') return base
    return base.filter(
      (l) =>
        l.nome.toLowerCase().includes(q) ||
        (l.bairro?.toLowerCase().includes(q) ?? false) ||
        (l.setor?.toLowerCase().includes(q) ?? false),
    )
  }, [pool, filters, busca])

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
  const safeDisparoPlan = useMemo(
    () =>
      computeSafeDisparoPlan({
        allLeads: leads.map((l) => ({ id: l.id, whatsapp_sent_at: l.whatsapp_sent_at })),
        selectedIds: selectedVisible.map((l) => l.id),
        configuredDailyCap: readMetaSafeDailyCapFromEnv(),
      }),
    [leads, selectedVisible],
  )

  // Disparo em lote via lib/disparoRunner (átomo testado, compartilhado com a Olivia).
  // Ao fim mostra o RESUMO (disparados / sem nº / erros) — antes este loop engolia
  // falha com catch {} e dizia "N/N concluído" mesmo sem nada ter saído (auditoria).
  async function enviarDisparo() {
    if (selectedVisible.length === 0 || disparo) return
    const batchIds = new Set(safeDisparoPlan.batchIds)
    const fila = selectedVisible.filter((l) => batchIds.has(l.id))
    if (fila.length === 0) {
      setDisparoResumo({
        total: selectedVisible.length,
        disparados: 0,
        semNumero: 0,
        erros: 0,
        pausados: selectedVisible.length,
      })
      return
    }
    stopRef.current = false
    setDisparoResumo(null)
    setDisparo({ done: 0, total: fila.length })
    const resumo = await dispararLote(
      fila,
      (_r, i) => {
        setDisparo({ done: i + 1, total: fila.length })
        void qc.invalidateQueries({ queryKey: LEADS_KEY })
      },
      {
        sinalParar: () => stopRef.current,
        maxDisparos: safeDisparoPlan.batchIds.length,
        delayMs: safeDisparoPlan.batchDelayMs,
      },
    )
    setDisparo(null)
    setDisparoResumo({
      ...resumo,
      total: selectedVisible.length,
      pausados: (resumo.pausados ?? 0) + safeDisparoPlan.deferredIds.length,
    })
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

  // Exporta os leads visíveis (respeita os filtros atuais) como CSV pro Excel.
  function exportarBase() {
    const headers = ['Nome', 'Bairro', 'Setor', 'Score', 'Seguidores', 'Instagram', 'WhatsApp', 'Status', 'Cidade']
    const rows = visible.map((l) => [
      l.nome,
      l.bairro ?? '',
      l.setor ?? '',
      l.lead_score ?? '',
      l.instagram_followers ?? '',
      l.instagram_handle ? '@' + l.instagram_handle : '',
      l.whatsapp_dono?.trim() || l.whatsapp_phone || '',
      STATUS_META[l.status]?.label ?? l.status,
      l.cidade ?? '',
    ])
    downloadCsv(`base-de-dados-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows))
  }

  return (
    <>
      <div className="bd-header">
        <h1 className="bd-page-title"><Database size={26} /> Base de Dados</h1>
        {tab === 'leads' && (
          <div className="bd-tools">
            <div className="bd-filters" ref={filtrosRef}>
              <button
                type="button"
                className="bd-filters-btn"
                onClick={() => setFiltrosAbertos((v) => !v)}
                aria-expanded={filtrosAbertos}
              >
                <SlidersHorizontal size={16} /> Filters
              </button>
              {filtrosAbertos && (
                <div className="bd-filters-pop">
                  <LeadFilters
                    filters={filters}
                    onChange={setFilters}
                    bairros={bairros}
                    setores={setores}
                  />
                </div>
              )}
            </div>
            <div className="bd-search-col">
              <div className="bd-search">
                <Search size={16} className="bd-search-icon" />
                <input
                  type="text"
                  placeholder="Search"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                />
              </div>
              <button
                className="btn ghost sm bd-export"
                onClick={exportarBase}
                disabled={visible.length === 0}
                title="Baixa os leads visíveis (com os filtros atuais) em CSV para abrir no Excel."
              >
                <Download size={14} /> Exportar CSV
              </button>
            </div>
          </div>
        )}
      </div>

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
        </button>
      </div>

      {tab === 'cliente-oculto' ? (
        <ClienteOcultoTab onOpenLead={setOpenId} />
      ) : (
      <>
      <div className="table-bar">
        {disparoResumo && (
          <span
            className={`disparo-resumo${disparoResumo.erros > 0 ? ' tem-erro' : ''}`}
            role="status"
            onClick={() => setDisparoResumo(null)}
            title="Clique para dispensar"
          >
            <b>{disparoResumo.disparados}</b> disparado(s)
            {disparoResumo.semNumero > 0 && <> · {disparoResumo.semNumero} sem nº</>}
            {(disparoResumo.jaContatados ?? 0) > 0 && <> · {disparoResumo.jaContatados} já contatado(s)</>}
            {disparoResumo.erros > 0 && <> · <b>{disparoResumo.erros} com erro</b></>}
            {(disparoResumo.pausados ?? 0) > 0 && <> · {disparoResumo.pausados} pausado(s) pelo cap seguro</>}
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
              title="Acha o número de quem não tem e aciona o workflow do template no HubSpot respeitando cap diário e lote seguro."
            >
              <Send size={15} /> Enviar disparo seguro
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
