import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Ban,
  Sparkles,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  MapPin,
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
  selecionadosVisiveis,
  temWhatsapp,
  type FiltrosSelecao,
} from '../lib/oliviaSelecao'
import { runWhatsappCheck } from '../lib/whatsappCheckRunner'
import { precisaSeguidores, runFollowers } from '../lib/followersRunner'
import { Checkbox } from '../components/Checkbox'
import { LocalAutocomplete } from '../components/LocalAutocomplete'
import { BuscaMassaPanel } from '../components/BuscaMassaPanel'
import { EnriquecerMassaPanel } from '../components/EnriquecerMassaPanel'
import { DisparoMassaPanel } from '../components/DisparoMassaPanel'
import { JobMassaPanel } from '../components/JobMassaPanel'
import { ScoreChip } from '../components/leads/ScoreChip'
import { fmtText, fmtInt } from '../lib/format'
import { LEAD_ORIGEM_LABEL } from '../lib/types'

type Passo = 1 | 2 | 3 | 4

const PASSOS: { n: Passo; t: string }[] = [
  { n: 1, t: 'Buscar' },
  { n: 2, t: 'Selecionar' },
  { n: 3, t: 'Processar' },
  { n: 4, t: 'Resumo' },
]

// Quantidade fixa puxada por busca (antes era um seletor 20/40/60).
const MAX_BUSCA = 60

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

export default function Prospeccao() {
  const [passo, setPasso] = useState<Passo>(1)

  // Passo 1 — busca
  const buscar = useBuscarNegocios()
  const [setor, setSetor] = useState('')
  const [local, setLocal] = useState('')
  const [massaAberta, setMassaAberta] = useState(false)
  const [busca, setBusca] = useState<BuscarResult | null>(null)

  // Passo 2 — seleção sobre os leads 'descoberto'
  const { data: leads = [], isLoading } = useLeads()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [filtros, setFiltros] = useState<FiltrosSelecao>(FILTROS_VAZIOS)
  const qc = useQueryClient()

  // Passo 3 — progresso ao vivo do lote
  const [lote, setLote] = useState<{ id: string; nome: string }[]>([])
  const [progresso, setProgresso] = useState<Record<string, OliviaProgresso>>({})
  const [rodando, setRodando] = useState(false)
  const [erroFatal, setErroFatal] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [cancelando, setCancelando] = useState(false)

  // Passo 4 — resumo do runner
  const [resumo, setResumo] = useState<OliviaResumo | null>(null)

  // Passo 2 — lista expansível/colável
  const [listaAberta, setListaAberta] = useState(true)

  const descobertos = useMemo(
    () => leadsDaBusca(leads, busca?.place_ids ?? []),
    [leads, busca],
  )

  const comWhatsapp = useMemo(() => descobertos.filter(temWhatsapp), [descobertos])
  const verificando = useMemo(() => descobertos.filter(aguardandoWhatsapp), [descobertos])
  const semWhatsapp = descobertos.length - comWhatsapp.length - verificando.length

  const visiveis = useMemo(() => filtrarLeads(comWhatsapp, filtros), [comWhatsapp, filtros])
  const selecionados = useMemo(() => selecionadosVisiveis(visiveis, sel), [visiveis, sel])

  // Passo 1 (busca): pinta o painel de conteúdo inteiro com o gradiente do hero
  // (via classe no body). Sai da página/passo → remove.
  useEffect(() => {
    if (passo !== 1) return
    document.body.classList.add('prospeccao-busca')
    return () => document.body.classList.remove('prospeccao-busca')
  }, [passo])

  // Runners de fundo do passo 2: verificação de WhatsApp e seguidores.
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
    buscar.mutate(
      { setor: termoBusca(s), local: l, max: MAX_BUSCA, comSeguidores: false },
      {
        onSuccess: (r) => {
          setBusca(r)
          setSel(new Set())
          setFiltros(FILTROS_VAZIOS)
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

  function cancelarRestante() {
    if (cancelando) return
    abortRef.current?.abort()
    setCancelando(true)
  }

  function processarSelecionados() {
    const itens = selecionados.map((l) => ({ id: l.id, nome: l.nome }))
    void executar(itens)
  }

  function novoLote() {
    setPasso(1)
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

  function voltarUmPasso() {
    if (rodando) return
    if (passo === 2) setPasso(1)
    else if (passo === 3) setPasso(2)
    else if (passo === 4) setPasso(2)
  }

  const idsVisiveis = visiveis.map((l) => l.id)
  const todosSelecionados = idsVisiveis.length > 0 && idsVisiveis.every((id) => sel.has(id))
  const entradas = Object.values(progresso)

  return (
    <>
      {/* Header + stepper + controles só nos passos 2-4; o passo 1 é o hero. */}
      {passo > 1 && (
        <>
          <header className="page-head">
            <div className="eyebrow">Prospecção</div>
            <h1>Prospecção</h1>
            <p className="page-sub">
              Busque negócios no Google, selecione, processe e dispare mensagens em lote.
            </p>
          </header>

          {/* Stepper — variante compacta dos .olivia-steps do shell */}
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

          <div className="wizard-controls">
            <button className="btn ghost sm" onClick={voltarUmPasso} disabled={rodando}>
              <ArrowLeft size={13} /> Voltar um passo
            </button>
            <button className="btn ghost sm" onClick={novoLote} disabled={rodando}>
              <RotateCcw size={13} /> Recomeçar do zero
            </button>
          </div>
        </>
      )}

      {/* ---------- Passo 1 · Buscar (hero) ---------- */}
      {passo === 1 && (
        <>
          <section className="prospeccao-hero">
            <h1 className="prospeccao-hero-title"><Search size={26} /> Buscar</h1>

            <form className="prospeccao-hero-form" onSubmit={buscarSubmit}>
              <div className="search-field">
                <label className="eyebrow" htmlFor="oli-setor">Setor</label>
                <div className="search-input">
                  <Search size={18} className="search-input-icon" />
                  <input
                    id="oli-setor"
                    list="oli-setores"
                    placeholder="Ex.: Confeitaria"
                    value={setor}
                    onChange={(e) => setSetor(e.target.value)}
                  />
                  <datalist id="oli-setores">
                    {SETORES.map((s) => (<option key={s} value={s} />))}
                  </datalist>
                </div>
              </div>

              <div className="search-field">
                <label className="eyebrow" htmlFor="oli-local">Local (bairro, cidade ou região)</label>
                <div className="search-input">
                  <MapPin size={18} className="search-input-icon" />
                  <LocalAutocomplete id="oli-local" value={local} onChange={setLocal} />
                </div>
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

            <div className="massa-toggle-row">
              <button
                type="button"
                className="massa-toggle"
                onClick={() => setMassaAberta((v) => !v)}
                aria-expanded={massaAberta}
              >
                Prospectar em massa
                <span className={`massa-caret${massaAberta ? ' aberto' : ''}`} aria-hidden="true" />
              </button>
            </div>
          </section>

          {massaAberta && (
            <div className="massa-panels">
              <BuscaMassaPanel setor={setor} local={local} />
              <JobMassaPanel setor={setor} local={local} />
              <EnriquecerMassaPanel setor={setor} />
              <DisparoMassaPanel setor={setor} />
            </div>
          )}
        </>
      )}

      {/* ---------- Passo 2 · Selecionar ---------- */}
      {passo === 2 && (
        <>
          <div className="table-bar">
            <span className="table-count">
              <b>{visiveis.length}</b> com WhatsApp
              {busca && <> de {busca.total} encontrados</>}
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
                        <th className="eyebrow" style={{ textAlign: 'right' }}>Score</th>
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
                              <ScoreChip score={lead.lead_score} />
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
            <Link to="/olivia" className="btn">
              <Sparkles size={15} /> Ver na Olivia
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
