import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Route, Send, Square, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useLeads,
  useDeleteLeads,
  useSetStatusBulk,
  encontrarWhatsapp,
  syncHubspot,
  LEADS_KEY,
} from '../lib/leads'
import { runEnrichment, precisaEnriquecer } from '../lib/enrichRunner'
import { useLeadsUI } from '../context/leadsUI'
import { applyFilters, distinctBairros, distinctSetores, EMPTY_FILTERS } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'
import { EnriquecerTable } from '../components/leads/EnriquecerTable'
import { LeadFilters } from '../components/leads/LeadFilters'
import { Bandeja } from '../components/leads/Bandeja'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { ConfirmDialog } from '../components/ConfirmDialog'

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
  // Filtros locais da página (o pool desta etapa é outro: qualificado/enriquecido).
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  // Progresso do "Enviar disparo" (lote sequencial, lógica do antigo BatchWhatsapp).
  const [disparo, setDisparo] = useState<{ done: number; total: number } | null>(null)
  const stopRef = useRef(false)

  // Desmontou com o lote rodando → sinaliza parada (loop é fire-and-forget).
  useEffect(() => () => { stopRef.current = true }, [])

  // Pool desta etapa: qualificado (a enriquecer) + enriquecido (já feitos).
  const pool = useMemo(
    () => leads.filter((l) => l.status === 'qualificado' || l.status === 'enriquecido'),
    [leads],
  )
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

  // Disparo em lote (concorrência 1, mesma cadência do antigo BatchWhatsapp):
  // por lead, acha o número se faltar e sincroniza no HubSpot com trigger=true —
  // o workflow F/M dispara o template em ~5 min.
  async function enviarDisparo() {
    const fila = selectedVisible
    if (fila.length === 0 || disparo) return
    stopRef.current = false
    setDisparo({ done: 0, total: fila.length })
    for (let i = 0; i < fila.length; i++) {
      if (stopRef.current) break
      const lead = fila[i]
      try {
        // O nº manual da dona(o) também conta como conhecido — quando presente,
        // o disparo prefere ele ao número da loja.
        let numero = lead.whatsapp_phone ?? lead.whatsapp_dono
        if (!numero) {
          const res = await encontrarWhatsapp(lead.id, false)
          numero = res.lead.whatsapp_phone
        }
        // Anti-invenção: sem número não há disparo — o lead fica na base como está.
        if (numero) await syncHubspot(lead.id, true)
      } catch {
        // um lead que falha não derruba o lote
      }
      await qc.invalidateQueries({ queryKey: LEADS_KEY })
      setDisparo({ done: i + 1, total: fila.length })
    }
    setDisparo(null)
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
        <div className="eyebrow">02 · Base de Dados</div>
        <h1>Base de Dados</h1>
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
            />
          )}
        </div>
      </div>

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
              title="Acha o número de quem não tem e prepara o disparo do template no HubSpot (~5 min)."
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
