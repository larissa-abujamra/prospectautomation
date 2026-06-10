import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Sparkles,
  Search,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Ban,
  Database,
  RotateCcw,
} from 'lucide-react'
import { useBuscarNegocios, useLeads, type BuscarResult } from '../lib/leads'
import { SETORES, termoBusca } from '../lib/setores'
import {
  runOlivia,
  type OliviaEtapa,
  type OliviaProgresso,
  type OliviaResumo,
} from '../lib/oliviaRunner'
import { Checkbox } from '../components/Checkbox'
import { fmtText } from '../lib/format'

// Olivia (Fases 3–4): buscar → selecionar → processar → resumo, numa página só
// (máquina de estados local, sem rotas novas). O processamento em si vive em
// lib/oliviaRunner (contrato compartilhado do plano 2026-06-10). Cancelamento
// (Fase 4): AbortController por lote — quem está rodando termina a etapa atual;
// quem não começou sai como 'cancelado'.

type Passo = 1 | 2 | 3 | 4

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
  const [passo, setPasso] = useState<Passo>(1)

  // Passo 1 — busca (mesmo form do Buscar manual)
  const buscar = useBuscarNegocios()
  const [setor, setSetor] = useState('')
  const [bairro, setBairro] = useState('')
  const [max, setMax] = useState(40)
  const [busca, setBusca] = useState<BuscarResult | null>(null)

  // Passo 2 — seleção sobre os leads 'descoberto'
  const { data: leads = [], isLoading } = useLeads()
  const [sel, setSel] = useState<Set<string>>(new Set())

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

  // useLeads já vem ordenado por created_at desc.
  const descobertos = useMemo(() => leads.filter((l) => l.status === 'descoberto'), [leads])

  function buscarSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = setor.trim()
    const b = bairro.trim()
    if (!s || !b || buscar.isPending) return
    // Seguidores carregam em segundo plano (followersRunner) — não pedimos aqui.
    buscar.mutate(
      { setor: termoBusca(s), bairro: b, max, comSeguidores: false },
      {
        onSuccess: (r) => {
          setBusca(r)
          setPasso(2)
        },
      },
    )
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
    const itens = descobertos
      .filter((l) => sel.has(l.id))
      .map((l) => ({ id: l.id, nome: l.nome }))
    void executar(itens)
  }

  function novoLote() {
    setPasso(1)
    setBusca(null)
    setSel(new Set())
    setLote([])
    setProgresso({})
    setErroFatal(null)
    setResumo(null)
    setCancelando(false)
    abortRef.current = null
    buscar.reset()
  }

  const idsVisiveis = descobertos.map((l) => l.id)
  const todosSelecionados = idsVisiveis.length > 0 && idsVisiveis.every((id) => sel.has(id))
  const entradas = Object.values(progresso)

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">
          <Sparkles size={11} style={{ verticalAlign: -1 }} /> Olivia · automático
        </div>
        <h1>Prospecção automática</h1>
        <p className="page-sub">
          Busca → você escolhe → ela enriquece, salva na base e dispara o WhatsApp
          via HubSpot. Num fluxo só.
        </p>
      </header>

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

      {/* ---------- Passo 1 · Buscar ---------- */}
      {passo === 1 && (
        <div className="card search-card">
          <div className="eyebrow" style={{ marginBottom: 16 }}>Buscar negócios</div>

          <form className="search-row" onSubmit={buscarSubmit}>
            <div className="field">
              <label className="eyebrow" htmlFor="oli-setor">Setor</label>
              <select id="oli-setor" value={setor} onChange={(e) => setSetor(e.target.value)}>
                <option value="">Selecione o setor</option>
                {SETORES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="eyebrow" htmlFor="oli-bairro">Bairro</label>
              <input
                id="oli-bairro"
                placeholder="Ex.: Pinheiros"
                value={bairro}
                onChange={(e) => setBairro(e.target.value)}
              />
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
              disabled={buscar.isPending || !setor.trim() || !bairro.trim()}
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
      )}

      {/* ---------- Passo 2 · Selecionar ---------- */}
      {passo === 2 && (
        <>
          <div className="table-bar">
            <span className="table-count">
              {busca && (
                <>
                  <b>{busca.total}</b> {busca.total === 1 ? 'encontrado' : 'encontrados'}{' '}
                  ({busca.inserted} {busca.inserted === 1 ? 'novo' : 'novos'}) ·{' '}
                </>
              )}
              <b>{sel.size}</b> {sel.size === 1 ? 'selecionado' : 'selecionados'}
            </span>
          </div>

          {isLoading ? (
            <div className="search-status"><Loader2 size={15} className="spin" /> Carregando leads…</div>
          ) : descobertos.length === 0 ? (
            <div className="empty-state">
              <h3>Nenhum lead novo</h3>
              <p>A busca não trouxe negócios na etapa “descoberto”. Volte e busque outro setor ou bairro.</p>
            </div>
          ) : (
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
                    <th className="eyebrow">Instagram</th>
                  </tr>
                </thead>
                <tbody>
                  {descobertos.map((lead) => {
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
                          {lead.instagram_handle ? (
                            <span className="ig-link">@{lead.instagram_handle}</span>
                          ) : (
                            <span className="cell-dash">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="oli-actions">
            <button className="btn ghost" onClick={() => setPasso(1)}>
              <ArrowLeft size={15} /> Voltar
            </button>
            <button className="btn" onClick={processarSelecionados} disabled={sel.size === 0}>
              <ArrowRight size={15} /> Processar {sel.size} {sel.size === 1 ? 'lead' : 'leads'}
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
  )
}
