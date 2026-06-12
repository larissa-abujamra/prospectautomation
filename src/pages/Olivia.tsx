import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Sparkles,
  Search,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Ban,
  Database,
  RotateCcw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { useBuscarNegocios, useLeads, type BuscarResult } from '../lib/leads'
import { SETORES, termoBusca } from '../lib/setores'
import {
  runOlivia,
  type OliviaEtapa,
  type OliviaProgresso,
  type OliviaResumo,
} from '../lib/oliviaRunner'
import {
  aguardandoWhatsapp,
  filtrarLeads,
  FILTROS_VAZIOS,
  leadsDaBusca,
  leadsInboundDisponiveis,
  selecionadosVisiveis,
  temWhatsapp,
  type FiltrosSelecao,
} from '../lib/oliviaSelecao'
import { runWhatsappCheck } from '../lib/whatsappCheckRunner'
import { precisaSeguidores, runFollowers } from '../lib/followersRunner'
import { Checkbox } from '../components/Checkbox'
import { LocalAutocomplete } from '../components/LocalAutocomplete'
import { InboundSquadLeadsPanel } from '../components/leads/InboundSquadLeadsPanel'
import { OliviaCockpit } from '../components/leads/OliviaCockpit'
import { OliviaDisparos } from '../components/leads/OliviaDisparos'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { fmtText, fmtInt, fmtRating } from '../lib/format'
import { contarLeadsComResposta, lerVistoEm, useRespostasDesde } from '../lib/disparos'
import { INBOUND_CLASSIFICATIONS, INBOUND_CLASSIFICATION_LABEL, LEAD_ORIGEM_LABEL } from '../lib/types'

type Vista = 'acompanhar' | 'prospectar' | 'disparos'

// Olivia (Fases 3–4): buscar → selecionar → processar → resumo, numa página só
// (máquina de estados local, sem rotas novas). O processamento em si vive em
// lib/oliviaRunner (contrato compartilhado do plano 2026-06-10). Cancelamento
// (Fase 4): AbortController por lote — quem está rodando termina a etapa atual;
// quem não começou sai como 'cancelado'.

type Passo = 1 | 2 | 3 | 4
type FonteLote = 'google' | 'inbound'

const PASSOS: { n: Passo; t: string }[] = [
  { n: 1, t: 'Buscar' },
  { n: 2, t: 'Selecionar' },
  { n: 3, t: 'Processar' },
  { n: 4, t: 'Resumo' },
]


// Ordem das etapas do runner — usada para agregar o progresso por etapa.
const ORDEM: Record<OliviaEtapa, number> = {
  enriquecer: 0,
  whatsapp: 1,
  hubspot: 2,
  disparo: 3,
  fim: 4,
}

const ETAPAS: { key: Exclude<OliviaEtapa, 'fim'>; label: string }[] = [
  { key: 'enriquecer', label: 'Enriquecer' },
  { key: 'whatsapp', label: 'Achar WhatsApp' },
  { key: 'hubspot', label: 'HubSpot' },
  { key: 'disparo', label: 'Disparo' },
]

const RODANDO_LABEL: Record<OliviaEtapa, string> = {
  enriquecer: 'Enriquecendo',
  whatsapp: 'Achando WhatsApp',
  hubspot: 'Enviando ao HubSpot',
  disparo: 'Disparando',
  fim: 'Finalizando',
}

// Dot semântico do design system: pending=rodando, ok, missing=sem nº/erro.
// Cancelado fica 'empty' (não rodou — não é sucesso nem falha).
function dotDe(p: OliviaProgresso | undefined): 'empty' | 'pending' | 'ok' | 'missing' {
  if (!p || p.status === 'pendente' || p.status === 'cancelado') return 'empty'
  if (p.status === 'rodando') return 'pending'
  if (p.status === 'ok') return 'ok'
  return 'missing'
}

function rotuloDe(p: OliviaProgresso | undefined): string {
  if (!p || p.status === 'pendente') return 'Na fila'
  if (p.status === 'cancelado') return 'Cancelado'
  if (p.status === 'rodando') return `${RODANDO_LABEL[p.etapa]}…`
  if (p.status === 'sem_numero') return 'Sem nº — completar manual'
  if (p.status === 'erro') return p.erro ?? 'Erro'
  return p.etapa === 'fim' ? 'Concluído' : `${RODANDO_LABEL[p.etapa]} ok`
}

export default function Olivia() {
  // Duas vistas: Acompanhamento (cockpit — o que a Olivia está fazendo) e
  // Prospecção (o assistente de lote). Acompanhar é o padrão: é o "como vão as
  // conversas" do dia a dia; prospectar é uma ação deliberada.
  const [vista, setVista] = useState<Vista>('acompanhar')
  const [openId, setOpenId] = useState<string | null>(null)
  const [passo, setPasso] = useState<Passo>(1)

  // Passo 1 — busca (mesmo form do Buscar manual). Setor é texto livre com
  // sugestões (a expansão por sinônimos acontece no backend); o Local usa o
  // autocomplete do Places para desambiguar bairro/cidade/região homônimos
  // (ex.: "Alta Floresta" cidade no MT vs. bairro em outro estado).
  const buscar = useBuscarNegocios()
  const [setor, setSetor] = useState('')
  const [local, setLocal] = useState('')
  const [max, setMax] = useState(40)
  const [busca, setBusca] = useState<BuscarResult | null>(null)
  const [fonteLote, setFonteLote] = useState<FonteLote>('google')

  // Passo 2 — seleção sobre os leads 'descoberto'
  const { data: leads = [], isLoading } = useLeads()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [filtros, setFiltros] = useState<FiltrosSelecao>(FILTROS_VAZIOS)
  const qc = useQueryClient()

  // Badge de respostas novas (desde a última visita à aba Disparos). Visitar a
  // aba atualiza a régua local — o badge não "re-acende" com respostas já vistas.
  const [vistoEm, setVistoEm] = useState(() => lerVistoEm())
  const respostas = useRespostasDesde(vistoEm)
  const respostasNovas = contarLeadsComResposta(respostas.data ?? [])

  // Passo 3 — progresso ao vivo do lote
  const [lote, setLote] = useState<{ id: string; nome: string }[]>([])
  const [progresso, setProgresso] = useState<Record<string, OliviaProgresso>>({})
  const [rodando, setRodando] = useState(false)
  const [erroFatal, setErroFatal] = useState<string | null>(null)
  // Cancelamento (Fase 4): um AbortController por lote. Abortar NÃO derruba
  // quem está no meio do pipeline — só impede leads novos de começarem.
  const abortRef = useRef<AbortController | null>(null)
  const [cancelando, setCancelando] = useState(false)

  // Passo 4 — resumo do runner
  const [resumo, setResumo] = useState<OliviaResumo | null>(null)

  // Passo 2 — lista de seleção expansível/colável (a busca pode trazer dezenas).
  const [listaAberta, setListaAberta] = useState(true)

  // Passo 2 mostra EXATAMENTE a fonte escolhida:
  // - Google: leads frescos retornados pela última busca (place_ids).
  // - Inbound: leads frescos importados do Squad Leads (sem google_place_id).
  const descobertos = useMemo(
    () =>
      fonteLote === 'inbound'
        ? leadsInboundDisponiveis(leads)
        : leadsDaBusca(leads, busca?.place_ids ?? []),
    [leads, busca, fonteLote],
  )

  // Gate de WhatsApp: sem número confirmado, o lead não aparece pra disparo
  // (não há por que selecionar quem não dá pra mensagear). A verificação roda em
  // segundo plano (runner abaixo); enquanto roda, mostramos o progresso.
  const comWhatsapp = useMemo(() => descobertos.filter(temWhatsapp), [descobertos])
  const verificando = useMemo(() => descobertos.filter(aguardandoWhatsapp), [descobertos])
  const semWhatsapp = descobertos.length - comWhatsapp.length - verificando.length

  // Filtros da seleção (seguidores, nota, avaliações, Instagram) sobre quem
  // passou no gate de WhatsApp.
  const visiveis = useMemo(() => filtrarLeads(comWhatsapp, filtros), [comWhatsapp, filtros])

  // Selecionados que estão REALMENTE na lista visível — o que o botão conta e processa.
  const selecionados = useMemo(() => selecionadosVisiveis(visiveis, sel), [visiveis, sel])

  // Runners de fundo do passo 2: verificação de WhatsApp (alimenta o gate) e
  // seguidores (alimenta o filtro de seguidores). Ambos com dedup por sessão.
  useEffect(() => {
    if (passo !== 2 || descobertos.length === 0) return
    runWhatsappCheck(descobertos, qc)
    runFollowers(
      descobertos
        .filter(precisaSeguidores)
        .map((l) => ({ id: l.id, handle: l.instagram_handle, nome: l.nome, cidade: l.cidade })),
      qc,
    )
  }, [passo, descobertos, qc])

  function buscarSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = setor.trim()
    const l = local.trim()
    if (!s || !l || buscar.isPending) return
    // Seguidores carregam em segundo plano (followersRunner) — não pedimos aqui.
    buscar.mutate(
      { setor: termoBusca(s), local: l, max, comSeguidores: false },
      {
        onSuccess: (r) => {
          setFonteLote('google')
          setBusca(r)
          setSel(new Set())
          setFiltros(FILTROS_VAZIOS)
          setPasso(2)
        },
      },
    )
  }

  function usarInbound() {
    setFonteLote('inbound')
    setBusca(null)
    setSel(new Set())
    setFiltros({ ...FILTROS_VAZIOS, origem: 'squad_leads_form' })
    setListaAberta(true)
    setPasso(2)
  }

  function toggleOne(id: string) {
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(ids: string[], select: boolean) {
    setSel((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (select) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  // Roda o lote pelo runner compartilhado, com signal de cancelamento.
  async function executar(itens: { id: string; nome: string }[]) {
    if (itens.length === 0 || rodando) return
    const controller = new AbortController()
    abortRef.current = controller
    setCancelando(false)
    setLote(itens)
    setProgresso({})
    setErroFatal(null)
    setResumo(null)
    setPasso(3)
    setRodando(true)
    try {
      const r = await runOlivia(
        itens,
        (p) => {
          setProgresso((prev) => ({ ...prev, [p.leadId]: p }))
        },
        { signal: controller.signal },
      )
      setResumo(r)
      setPasso(4)
    } catch (e) {
      setErroFatal(e instanceof Error ? e.message : 'Falha ao processar o lote.')
    } finally {
      setRodando(false)
    }
  }

  // Cancela o RESTANTE do lote: leads em andamento terminam a etapa atual;
  // os que não começaram saem como 'cancelado' no resumo.
  function cancelarRestante() {
    if (cancelando) return
    abortRef.current?.abort()
    setCancelando(true)
  }

  function processarSelecionados() {
    // Exatamente os selecionados visíveis — o mesmo número que o botão mostra.
    const itens = selecionados.map((l) => ({ id: l.id, nome: l.nome }))
    void executar(itens)
  }

  // Recomeçar do zero: limpa TUDO (inclusive o formulário de busca).
  function novoLote() {
    setPasso(1)
    setFonteLote('google')
    setSetor('')
    setLocal('')
    setBusca(null)
    setSel(new Set())
    setFiltros(FILTROS_VAZIOS)
    setLote([])
    setProgresso({})
    setErroFatal(null)
    setResumo(null)
    setCancelando(false)
    abortRef.current = null
    buscar.reset()
  }

  // Voltar UM passo (pra ajustar algo sem perder o resto): 2→1 mantém a busca
  // preenchida; 3→2 só quando o lote não está rodando; 4→2 permite selecionar
  // e processar os leads que sobraram da mesma busca.
  function voltarUmPasso() {
    if (rodando) return
    if (passo === 2) setPasso(1)
    else if (passo === 3) setPasso(2)
    else if (passo === 4) setPasso(2)
  }

  const idsVisiveis = visiveis.map((l) => l.id)
  const todosSelecionados = idsVisiveis.length > 0 && idsVisiveis.every((id) => sel.has(id))
  const entradas = Object.values(progresso)
  // Lead aberto pelo cockpit (ficha lateral na aba Conversa).
  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">
          <Sparkles size={11} style={{ verticalAlign: -1 }} /> Olivia
        </div>
        <h1>Olivia</h1>
        <p className="page-sub">
          Acompanhe as conversas da Olivia e dispare novas prospecções.
        </p>
      </header>

      {/* Alterna entre o cockpit (acompanhar) e o assistente de lote (prospectar). */}
      <div className="view-toggle" role="tablist" aria-label="Vista da Olivia">
        <button
          role="tab"
          aria-selected={vista === 'acompanhar'}
          className={`vt-btn${vista === 'acompanhar' ? ' active' : ''}`}
          onClick={() => setVista('acompanhar')}
        >
          Acompanhamento
        </button>
        <button
          role="tab"
          aria-selected={vista === 'prospectar'}
          className={`vt-btn${vista === 'prospectar' ? ' active' : ''}`}
          onClick={() => setVista('prospectar')}
        >
          Prospecção automática
        </button>
        <button
          role="tab"
          aria-selected={vista === 'disparos'}
          className={`vt-btn${vista === 'disparos' ? ' active' : ''}`}
          onClick={() => {
            setVista('disparos')
            setVistoEm(new Date().toISOString())
          }}
        >
          Disparos
          {/* Badge de respostas novas desde a última visita à aba. */}
          {respostasNovas > 0 && vista !== 'disparos' && (
            <span className="badge" style={{ marginLeft: 6 }}>{respostasNovas}</span>
          )}
        </button>
      </div>

      {vista === 'acompanhar' && <OliviaCockpit onOpenLead={setOpenId} />}

      {vista === 'disparos' && <OliviaDisparos onOpenLead={setOpenId} />}

      {vista === 'prospectar' && (
      <>
      {/* Stepper — variante compacta dos .olivia-steps do shell da Fase 1 */}
      <ol className="olivia-steps wizard">
        {PASSOS.map((p) => (
          <li
            key={p.n}
            className={`olivia-step${p.n === passo ? ' ativo' : p.n < passo ? ' feito' : ''}`}
            aria-current={p.n === passo ? 'step' : undefined}
          >
            <span className="olivia-step-n">{p.n}</span>
            <div className="olivia-step-t">{p.t}</div>
          </li>
        ))}
      </ol>

      {/* Controles do assistente: voltar um passo (ajustar algo) ou recomeçar
          do zero. Indisponíveis enquanto o lote roda (use "Cancelar restante"). */}
      {passo > 1 && (
        <div className="wizard-controls">
          <button className="btn ghost sm" onClick={voltarUmPasso} disabled={rodando}>
            <ArrowLeft size={13} /> Voltar um passo
          </button>
          <button className="btn ghost sm" onClick={novoLote} disabled={rodando}>
            <RotateCcw size={13} /> Recomeçar do zero
          </button>
        </div>
      )}

      {/* ---------- Passo 1 · Buscar ---------- */}
      {passo === 1 && (
        <>
        <InboundSquadLeadsPanel leads={leads} onUseInbound={usarInbound} />

        <div className="card search-card">
          <div className="eyebrow" style={{ marginBottom: 16 }}>Buscar novos negócios no Google</div>

          <form className="search-row" onSubmit={buscarSubmit}>
            <div className="field">
              <label className="eyebrow" htmlFor="oli-setor">Setor</label>
              {/* Texto livre com sugestões: a busca expande sinônimos do segmento
                  no backend (confeitaria também acha docerias etc.). */}
              <input
                id="oli-setor"
                list="oli-setores"
                placeholder="Ex.: Confeitaria"
                value={setor}
                onChange={(e) => setSetor(e.target.value)}
              />
              <datalist id="oli-setores">
                {SETORES.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>

            <div className="field" style={{ flex: 1.4 }}>
              <label className="eyebrow" htmlFor="oli-local">Local (bairro, cidade ou região)</label>
              {/* Autocomplete do Places: escolher a sugestão desambigua lugares
                  homônimos (Alta Floresta-MT vs. bairro homônimo em outro estado). */}
              <LocalAutocomplete id="oli-local" value={local} onChange={setLocal} />
            </div>

            <div className="field narrow">
              <label className="eyebrow" htmlFor="oli-qtd">Quantidade</label>
              <select id="oli-qtd" value={max} onChange={(e) => setMax(Number(e.target.value))}>
                <option value={20}>20</option>
                <option value={40}>40</option>
                <option value={60}>60</option>
              </select>
            </div>

            <button
              type="submit"
              className="btn-glow"
              disabled={buscar.isPending || !setor.trim() || !local.trim()}
            >
              <span className="btn-glow-bg" />
              <span className="btn-glow-content">
                {buscar.isPending ? (
                  <><Loader2 size={16} className="spin" /> Buscando…</>
                ) : (
                  <><Search size={16} /> Buscar</>
                )}
              </span>
            </button>
          </form>

          {buscar.isError && (
            <div className="search-status err">
              {(buscar.error as Error)?.message ?? 'Falha na busca.'}
            </div>
          )}
        </div>
        </>
      )}

      {/* ---------- Passo 2 · Selecionar ---------- */}
      {passo === 2 && (
        <>
          <div className="table-bar">
            <span className="table-count">
              {/* Contagem EXATA e honesta: só quem tem WhatsApp confirmado entra
                  na lista (sem número não há disparo possível). */}
              <b>{visiveis.length}</b> com WhatsApp
              {fonteLote === 'inbound' ? <> de {descobertos.length} inbound</> : busca && <> de {busca.total} encontrados</>}
              {verificando.length > 0 && (
                <>
                  {' · '}
                  <Loader2 size={12} className="spin" style={{ verticalAlign: -2 }} />{' '}
                  verificando {verificando.length}
                </>
              )}
              {semWhatsapp > 0 && <> · {semWhatsapp} sem número (ocultos)</>}
              {' · '}
              <b>{selecionados.length}</b> {selecionados.length === 1 ? 'selecionado' : 'selecionados'}
            </span>
          </div>

          {/* Progresso da verificação de WhatsApp: completude > pressa. Nenhum
              lead é descartado por demora — a lista preenche conforme cada
              verificação termina, e a barra mostra exatamente onde estamos. */}
          {verificando.length > 0 && (
            <div className="oli-etapas" style={{ marginBottom: 14 }}>
              <div className="oli-etapa">
                <span className="oli-etapa-label">Verificando WhatsApp</span>
                <div
                  className="oli-bar"
                  role="progressbar"
                  aria-label="Verificação de WhatsApp"
                  aria-valuemin={0}
                  aria-valuemax={descobertos.length}
                  aria-valuenow={descobertos.length - verificando.length}
                >
                  <span
                    className="rodando"
                    style={{
                      width: `${descobertos.length === 0 ? 0 : Math.round(((descobertos.length - verificando.length) / descobertos.length) * 100)}%`,
                    }}
                  />
                </div>
                <span className="oli-etapa-count">
                  {descobertos.length - verificando.length}/{descobertos.length}
                </span>
              </div>
              <p className="muted-line" style={{ marginTop: 6 }}>
                Procurando o número de cada negócio (Google → Instagram → site → busca web).
                Pode levar alguns segundos por lead; nada é descartado — quem for confirmado
                entra na lista sozinho, com a contagem acima acompanhando o progresso.
              </p>
            </div>
          )}

          {/* Filtros da seleção: refinam quem já passou no gate de WhatsApp. */}
          <div className="search-row" style={{ marginBottom: 14 }}>
            <div className="field narrow">
              <label className="eyebrow" htmlFor="f-seg">Seguidores mín.</label>
              <input
                id="f-seg"
                type="number"
                min={0}
                placeholder="—"
                value={filtros.minSeguidores ?? ''}
                onChange={(e) =>
                  setFiltros({ ...filtros, minSeguidores: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })
                }
              />
            </div>
            <div className="field narrow">
              <label className="eyebrow" htmlFor="f-nota">Nota mín.</label>
              <select
                id="f-nota"
                value={filtros.minRating ?? ''}
                onChange={(e) =>
                  setFiltros({ ...filtros, minRating: e.target.value === '' ? null : Number(e.target.value) })
                }
              >
                <option value="">Qualquer</option>
                <option value={4}>4.0+</option>
                <option value={4.5}>4.5+</option>
              </select>
            </div>
            <div className="field narrow">
              <label className="eyebrow" htmlFor="f-rev">Avaliações mín.</label>
              <input
                id="f-rev"
                type="number"
                min={0}
                placeholder="—"
                value={filtros.minReviews ?? ''}
                onChange={(e) =>
                  setFiltros({ ...filtros, minReviews: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })
                }
              />
            </div>
            <div className="field narrow">
              <label className="eyebrow" htmlFor="f-ig">Instagram</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6 }}>
                <Checkbox
                  checked={filtros.comInstagram}
                  onChange={(v) => setFiltros({ ...filtros, comInstagram: v })}
                  ariaLabel="Só com Instagram"
                />
                <span style={{ fontSize: 13 }}>Só com Instagram</span>
              </label>
            </div>
            <div className="field narrow">
              <label className="eyebrow" htmlFor="f-origem">Origem</label>
              <select
                id="f-origem"
                value={filtros.origem}
                onChange={(e) => setFiltros({ ...filtros, origem: e.target.value as FiltrosSelecao['origem'] })}
              >
                <option value="">Todas</option>
                <option value="google_places">{LEAD_ORIGEM_LABEL.google_places}</option>
                <option value="squad_leads_form">{LEAD_ORIGEM_LABEL.squad_leads_form}</option>
              </select>
            </div>
            <div className="field narrow">
              <label className="eyebrow" htmlFor="f-inbound">Inbound</label>
              <select
                id="f-inbound"
                value={filtros.inboundClassifications[0] ?? ''}
                onChange={(e) =>
                  setFiltros({
                    ...filtros,
                    inboundClassifications: e.target.value
                      ? [e.target.value as FiltrosSelecao['inboundClassifications'][number]]
                      : [],
                  })
                }
              >
                <option value="">Qualquer</option>
                {INBOUND_CLASSIFICATIONS.map((classification) => (
                  <option key={classification} value={classification}>
                    {INBOUND_CLASSIFICATION_LABEL[classification]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {isLoading ? (
            <div className="search-status"><Loader2 size={15} className="spin" /> Carregando leads…</div>
          ) : visiveis.length === 0 ? (
            <div className="empty-state">
              <h3>{verificando.length > 0 ? 'Verificando WhatsApp…' : 'Nenhum lead com WhatsApp'}</h3>
              <p>
                {verificando.length > 0
                  ? `Procurando o número de ${verificando.length} ${verificando.length === 1 ? 'negócio' : 'negócios'} (Google → Instagram → site → busca web). A lista preenche sozinha.`
                  : fonteLote === 'inbound'
                    ? 'Nenhum lead inbound importado tem número de WhatsApp confirmado com os filtros atuais. Ajuste os filtros ou sincronize novos leads.'
                    : 'Nenhum negócio desta busca tem número de WhatsApp confirmado com os filtros atuais. Ajuste os filtros ou busque outra região.'}
              </p>
            </div>
          ) : (
            <div className="oli-lista">
              <button
                type="button"
                className="oli-lista-toggle"
                onClick={() => setListaAberta((v) => !v)}
                aria-expanded={listaAberta}
              >
                {listaAberta ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                {listaAberta ? 'Ocultar lista' : `Mostrar lista (${visiveis.length})`}
              </button>
              {listaAberta && (
              <div className="table-wrap">
              <table className="leads-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <Checkbox
                        checked={todosSelecionados}
                        onChange={(v) => toggleAll(idsVisiveis, v)}
                        title="Selecionar todos"
                      />
                    </th>
                    <th className="eyebrow">Nome</th>
                    <th className="eyebrow">Bairro</th>
                    <th className="eyebrow">Setor</th>
                    <th className="eyebrow">WhatsApp</th>
                    <th className="eyebrow">Instagram</th>
                    <th className="eyebrow" style={{ textAlign: 'right' }}>Seguidores</th>
                    <th className="eyebrow" style={{ textAlign: 'right' }}>Nota</th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((lead) => {
                    const selected = sel.has(lead.id)
                    return (
                      <tr
                        key={lead.id}
                        className={selected ? 'selected' : undefined}
                        onClick={() => toggleOne(lead.id)}
                      >
                        <td className="col-check">
                          <Checkbox
                            checked={selected}
                            onChange={() => toggleOne(lead.id)}
                            ariaLabel={`Selecionar ${lead.nome}`}
                          />
                        </td>
                        <td className="cell-nome">{lead.nome}</td>
                        <td className={lead.bairro ? undefined : 'cell-dash'}>{fmtText(lead.bairro)}</td>
                        <td className={lead.setor ? undefined : 'cell-dash'}>{fmtText(lead.setor)}</td>
                        <td>
                          <span className="status-dot" data-status="ok" />{' '}
                          {lead.whatsapp_dono?.trim() || lead.whatsapp_phone}
                        </td>
                        <td>
                          {lead.instagram_handle ? (
                            <span className="ig-link">@{lead.instagram_handle}</span>
                          ) : (
                            <span className="cell-dash">—</span>
                          )}
                        </td>
                        <td className="cell-num" style={{ textAlign: 'right' }}>
                          {lead.instagram_followers == null ? <span className="cell-dash">—</span> : fmtInt(lead.instagram_followers)}
                        </td>
                        <td className="cell-num" style={{ textAlign: 'right' }}>
                          {lead.rating == null ? <span className="cell-dash">—</span> : fmtRating(lead.rating)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              )}
            </div>
          )}

          <div className="oli-actions">
            <button className="btn ghost" onClick={() => setPasso(1)}>
              <ArrowLeft size={15} /> Voltar
            </button>
            <button className="btn" onClick={processarSelecionados} disabled={selecionados.length === 0}>
              <ArrowRight size={15} /> Processar {selecionados.length} {selecionados.length === 1 ? 'lead' : 'leads'}
            </button>
          </div>
        </>
      )}

      {/* ---------- Passo 3 · Processar (progresso ao vivo) ---------- */}
      {passo === 3 && (
        <>
          <div className="oli-etapas">
            {ETAPAS.map((et, i) => {
              // Concluídos nesta etapa: já passaram dela, ou pararam nela com
              // status terminal (ok / sem nº / erro). Leads sem nº não chegam às
              // etapas seguintes — a barra delas não fecha, de propósito.
              // Cancelados nunca rodaram etapa nenhuma: ficam fora da contagem.
              const concluidos = entradas.filter(
                (p) =>
                  p.status !== 'cancelado' &&
                  (ORDEM[p.etapa] > i ||
                    (ORDEM[p.etapa] === i && p.status !== 'rodando' && p.status !== 'pendente')),
              ).length
              const ativa = entradas.some((p) => p.etapa === et.key && p.status === 'rodando')
              const pct = lote.length === 0 ? 0 : Math.round((concluidos / lote.length) * 100)
              return (
                <div key={et.key} className="oli-etapa">
                  <span className="oli-etapa-label">{et.label}</span>
                  <div
                    className="oli-bar"
                    role="progressbar"
                    aria-label={et.label}
                    aria-valuemin={0}
                    aria-valuemax={lote.length}
                    aria-valuenow={concluidos}
                  >
                    <span className={ativa ? 'rodando' : undefined} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="oli-etapa-count">{concluidos}/{lote.length}</span>
                </div>
              )
            })}
          </div>

          <ul className="oli-leads">
            {lote.map((item) => {
              const p = progresso[item.id]
              return (
                <li key={item.id} className="oli-lead">
                  <span className="status-dot" data-status={dotDe(p)} />
                  <span className="nome">{item.nome}</span>
                  <span className="et">{rotuloDe(p)}</span>
                </li>
              )
            })}
          </ul>

          {erroFatal && (
            <div className="callout" style={{ marginTop: 20 }}>
              Falha ao processar o lote: {erroFatal}
            </div>
          )}

          <div className="oli-actions">
            {erroFatal ? (
              <>
                <button className="btn ghost" onClick={() => setPasso(2)}>
                  <ArrowLeft size={15} /> Voltar
                </button>
                <button className="btn" onClick={() => void executar(lote)}>
                  <RotateCcw size={15} /> Tentar novamente
                </button>
              </>
            ) : (
              <>
                <button className="btn" disabled>
                  <Loader2 size={15} className="spin" /> Processando…
                </button>
                {/* Cancela só o restante: quem está rodando termina o lead atual. */}
                <button
                  className="btn ghost"
                  onClick={cancelarRestante}
                  disabled={cancelando}
                >
                  {cancelando ? (
                    <>
                      <Loader2 size={15} className="spin" /> Cancelando…
                    </>
                  ) : (
                    <>
                      <Ban size={15} /> Cancelar restante
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* ---------- Passo 4 · Resumo ---------- */}
      {passo === 4 && resumo && (
        <>
          <div className="oli-resumo">
            {([
              ['Total', resumo.total],
              ['Enriquecidos', resumo.enriquecidos],
              ['Com nº', resumo.comNumero],
              ['Sem nº', resumo.semNumero],
              ['Disparados', resumo.disparados],
              ['Erros', resumo.erros],
              // Linha extra só quando o lote foi cancelado no meio.
              ...(resumo.cancelados > 0 ? [['Cancelados', resumo.cancelados]] : []),
            ] as [string, number][]).map(([label, valor]) => (
              <div key={label} className="oli-resumo-card">
                <span className="eyebrow">{label}</span>
                <b>{valor}</b>
              </div>
            ))}
          </div>

          <div className="callout waz">
            Leads sem nº entram na Base de Dados marcados para completar o WhatsApp
            manualmente — nada é inventado.
          </div>

          <div className="oli-actions">
            <Link to="/base" className="btn">
              <Database size={15} /> Ver na Base de Dados
            </Link>
            <button className="btn ghost" onClick={novoLote}>
              <RotateCcw size={15} /> Novo lote
            </button>
          </div>
        </>
      )}
      </>
      )}

      {/* Abre a ficha já na aba Conversa (cockpit → ler/assumir a conversa). */}
      {openLead && (
        <LeadDrawer lead={openLead} initialTab="conversa" onClose={() => setOpenId(null)} key={openLead.id} />
      )}
    </>
  )
}
