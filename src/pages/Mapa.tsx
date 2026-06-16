// Página 03 · Rotas — v3 (fluxo de 3 passos)
// Passo 1: Origem (Da Base primário, Buscar secundário).
// Passo 2: Escolher no mapa — lista + mapa lado a lado, filtro por bairro, sync bidirecional.
// Passo 3: Rota pronta — mapa sempre visível + lista de paradas + ações (Maps/Waze/PDF).
// Remoções vs. v2: centro do raio, slider de raio, card "Importar" como bloco,
//   clique-no-mapa-redefine-centro-silenciosamente. PDF agora captura mapa corretamente
//   (o <div id="route-map"> está montado no Passo 3 quando o botão é clicado).

import { useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileDown,
  Loader2,
  MapPin,
  Navigation,
  RotateCcw,
  Route as RouteIcon,
  Search,
} from 'lucide-react'
import {
  useBuscarNegocios,
  useLeads,
  useSetStatusBulk,
  useUpdateLead,
  type BuscarResult,
} from '../lib/leads'
import { leadsDaBusca } from '../lib/oliviaSelecao'
import { isClienteOcultoPendente } from '../lib/clienteOculto'
import { SETORES, termoBusca } from '../lib/setores'
import { LocalAutocomplete } from '../components/LocalAutocomplete'
import { Checkbox } from '../components/Checkbox'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { haversineKm, nearestNeighbor, googleMapsDirUrl, wazeUrl, temCoord } from '../lib/route'
import type { LatLng, LeadComCoord } from '../lib/route'
import { gerarRotaPdf } from '../lib/routePdf'
import { LeadsMap } from '../components/mapa/LeadsMap'
import { fmtText } from '../lib/format'
import { STATUS_META } from '../lib/types'

type Passo = 1 | 2 | 3
type Origem = 'buscar' | 'base'

const PASSOS: { n: Passo; t: string }[] = [
  { n: 1, t: 'Origem' },
  { n: 2, t: 'Escolher no mapa' },
  { n: 3, t: 'Rota pronta' },
]

export default function Mapa() {
  const location = useLocation()
  const { data: leads = [], isLoading } = useLeads()
  const update = useUpdateLead()
  const setStatusBulk = useSetStatusBulk()

  // ── Compatibilidade ClienteOculto → Rotas ─────────────────────────────────
  // ClienteOculto.tsx faz navigate('/rotas', { state: { routeIds } }).
  const navSeed = (location.state as { routeIds?: string[] } | null)?.routeIds ?? null

  // ── Navegação ──────────────────────────────────────────────────────────────
  const [passo, setPasso] = useState<Passo>(navSeed ? 2 : 1)
  const [origem, setOrigem] = useState<Origem | null>(navSeed ? 'base' : null)

  // ── Passo 1 · Buscar agora ─────────────────────────────────────────────────
  const buscar = useBuscarNegocios()
  const [setorInput, setSetorInput] = useState('')
  const [localInput, setLocalInput] = useState('')
  const [maxInput, setMaxInput] = useState(40)
  const [busca, setBusca] = useState<BuscarResult | null>(null)

  // ── Passo 2 · Seleção LOCAL (NÃO herda selectedIds do LeadsUIProvider) ─────
  const [sel, setSel] = useState<Set<string>>(new Set(navSeed ?? []))
  const [bairroFilter, setBairroFilter] = useState('')

  // ── Passo 3 · Rota pronta ─────────────────────────────────────────────────
  const [startPoint, setStartPoint] = useState<LatLng | null>(null)
  const [pickMode, setPickMode] = useState<'start' | null>(null)
  const [geoMsg, setGeoMsg] = useState('')
  const [routeMsg, setRouteMsg] = useState('')
  // Otimismo local: visitados marcados no Passo 3 sem esperar refetch.
  const [localVisitados, setLocalVisitados] = useState<Set<string>>(new Set())

  // ── LeadDrawer ─────────────────────────────────────────────────────────────
  const [openId, setOpenId] = useState<string | null>(null)
  const leadsById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads])

  // ── Pools por origem ───────────────────────────────────────────────────────
  const baseLeads = useMemo(
    () => leads.filter((l) => l.status !== 'descoberto' && l.status !== 'descartado'),
    [leads],
  )
  const buscarLeads = useMemo(
    () => (busca ? leadsDaBusca(leads, busca.place_ids) : []),
    [leads, busca],
  )
  const pendentesOculto = useMemo(() => leads.filter(isClienteOcultoPendente), [leads])

  const poolAtivo = useMemo(
    () => (origem === 'buscar' ? buscarLeads : origem === 'base' ? baseLeads : []),
    [origem, buscarLeads, baseLeads],
  )

  const comCoord = useMemo(
    () => poolAtivo.filter(temCoord) as LeadComCoord[],
    [poolAtivo],
  )
  const semCoord = useMemo(() => poolAtivo.filter((l) => !temCoord(l)), [poolAtivo])

  // ── Filtro de bairro (Passo 2) ─────────────────────────────────────────────
  const bairrosDisponiveis = useMemo(
    () =>
      Array.from(new Set(comCoord.map((l) => l.bairro).filter(Boolean) as string[])).sort((a, b) =>
        a.localeCompare(b, 'pt-BR'),
      ),
    [comCoord],
  )

  // Lista filtrada — afeta só o que aparece no Passo 2; a seleção persiste além do filtro.
  const comCoordFiltrado = useMemo(
    () => (bairroFilter ? comCoord.filter((l) => l.bairro === bairroFilter) : comCoord),
    [comCoord, bairroFilter],
  )

  // Ordem estável: alfabética por nome (não reordena por seleção para evitar saltos visuais).
  const comCoordOrdenado = useMemo(
    () => [...comCoordFiltrado].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    [comCoordFiltrado],
  )

  // Todos os selecionados COM coordenada — o que entra na rota (ignora filtro de bairro).
  const selLeads = useMemo(() => comCoord.filter((l) => sel.has(l.id)), [comCoord, sel])

  // ── Rota otimizada ─────────────────────────────────────────────────────────
  const { stops: routeStops, start: routeStart } = useMemo(() => {
    const stops = selLeads
    if (stops.length === 0) return { stops: [] as LeadComCoord[], start: null as LatLng | null }
    const start: LatLng = startPoint ?? { lat: stops[0].lat, lng: stops[0].lng }
    return { stops: nearestNeighbor(start, stops), start }
  }, [selLeads, startPoint])

  const routeOrder = useMemo(
    () => new Map(routeStops.map((l, i) => [l.id, i + 1])),
    [routeStops],
  )

  // Área para nome do PDF — derivada dos bairros reais das paradas.
  const pdfArea = useMemo(() => {
    const bairros = Array.from(new Set(routeStops.map((s) => s.bairro).filter(Boolean)))
    if (bairros.length === 0) return 'Rota'
    if (bairros.length === 1) return bairros[0]!
    return bairros.slice(0, 2).join(' / ') + (bairros.length > 2 ? '…' : '')
  }, [routeStops])

  // ── Helpers de seleção ─────────────────────────────────────────────────────
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

  // ── Passo 1 handlers ───────────────────────────────────────────────────────
  function handleBuscarSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = setorInput.trim()
    const l = localInput.trim()
    if (!s || !l || buscar.isPending) return
    buscar.mutate(
      { setor: termoBusca(s), local: l, max: maxInput, comSeguidores: false },
      {
        onSuccess: (r) => {
          setBusca(r)
          setSel(new Set())
          setBairroFilter('')
          setOrigem('buscar')
          setPasso(2)
        },
      },
    )
  }

  function selecionarDaBase() {
    setSel(new Set(pendentesOculto.map((l) => l.id)))
    setBairroFilter('')
    setOrigem('base')
    setPasso(2)
  }

  // ── Passo 3 handlers ───────────────────────────────────────────────────────
  function handleMapClickP3(p: LatLng) {
    if (pickMode === 'start') {
      setStartPoint(p)
      setPickMode(null)
    }
  }

  function usarMinhaLocalizacao() {
    setGeoMsg('')
    if (!navigator.geolocation) {
      setGeoMsg('Geolocalização indisponível — clique no mapa para definir o início.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setStartPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () =>
        setGeoMsg('Não foi possível obter localização — clique no mapa para definir o início.'),
    )
  }

  async function marcarEmRota() {
    const ids = routeStops
      .filter(
        (s) =>
          s.status === 'descoberto' || s.status === 'qualificado' || s.status === 'enriquecido',
      )
      .map((s) => s.id)
    if (ids.length === 0) {
      setRouteMsg('Nenhuma parada elegível (já estão em rota ou visitadas).')
      return
    }
    setRouteMsg('')
    try {
      await setStatusBulk.mutateAsync({ ids, status: 'em_rota' })
      setRouteMsg(
        `${ids.length} ${ids.length === 1 ? 'parada marcada' : 'paradas marcadas'} como "em rota".`,
      )
    } catch (e) {
      setRouteMsg(`Erro: ${(e as Error).message}`)
    }
  }

  function marcarVisitado(id: string) {
    setLocalVisitados((prev) => new Set([...prev, id]))
    update.mutate({ id, patch: { status: 'visitado' } })
  }

  function recomecar() {
    setPasso(1)
    setOrigem(null)
    setBusca(null)
    setSel(new Set())
    setBairroFilter('')
    setStartPoint(null)
    setPickMode(null)
    setRouteMsg('')
    setGeoMsg('')
    setLocalVisitados(new Set())
    buscar.reset()
  }

  const idsComCoordFiltrado = useMemo(() => comCoordFiltrado.map((l) => l.id), [comCoordFiltrado])
  const todosSelecionadosNoFiltro =
    idsComCoordFiltrado.length > 0 && idsComCoordFiltrado.every((id) => sel.has(id))
  const openLead = openId ? (leadsById.get(openId) ?? null) : null

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">03 · Rotas</div>
        <h1>Roteiro de visitas</h1>
      </header>

      {/* Stepper horizontal — mesmo padrão da Olivia */}
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

      {passo > 1 && (
        <div className="wizard-controls">
          <button
            className="btn ghost sm"
            onClick={() => setPasso((p) => (p - 1) as Passo)}
          >
            <ArrowLeft size={13} /> Voltar um passo
          </button>
          <button className="btn ghost sm" onClick={recomecar}>
            <RotateCcw size={13} /> Recomeçar
          </button>
        </div>
      )}

      {/* ─── PASSO 1 · ORIGEM ───────────────────────────────────────────────── */}
      {passo === 1 && (
        <div className="rota-p1-wrap">

          {/* PRIMÁRIO — Da Base de Dados */}
          <div className="card rota-p1-primario">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Da Base de Dados</div>
            <p className="muted-line" style={{ marginBottom: 16 }}>
              {isLoading
                ? 'Carregando…'
                : baseLeads.length === 0
                  ? 'Nenhum lead na base ainda.'
                  : pendentesOculto.length > 0
                    ? `${baseLeads.length} leads disponíveis — ${pendentesOculto.length} ${pendentesOculto.length === 1 ? 'com visita de cliente oculto pendente' : 'com visitas de cliente oculto pendentes'} já pré-selecionados.`
                    : `${baseLeads.length} leads disponíveis para rotear.`}
            </p>
            <button
              className="btn"
              onClick={selecionarDaBase}
              disabled={isLoading || baseLeads.length === 0}
            >
              <ArrowRight size={15} /> Escolher no mapa
            </button>
          </div>

          {/* SECUNDÁRIO — Buscar agora */}
          <div className="rota-p1-secundario">
            <div className="eyebrow rota-p1-sec-label">Ou buscar agora no Google</div>
            <div className="card">
              <form className="search-row" onSubmit={handleBuscarSubmit}>
                <div className="field">
                  <label className="eyebrow" htmlFor="rota-setor">Setor</label>
                  <input
                    id="rota-setor"
                    list="rota-setores"
                    placeholder="Ex.: Confeitaria"
                    value={setorInput}
                    onChange={(e) => setSetorInput(e.target.value)}
                  />
                  <datalist id="rota-setores">
                    {SETORES.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                <div className="field" style={{ flex: 1.4 }}>
                  <label className="eyebrow" htmlFor="rota-local">Local</label>
                  <LocalAutocomplete
                    id="rota-local"
                    value={localInput}
                    onChange={setLocalInput}
                  />
                </div>
                <div className="field narrow">
                  <label className="eyebrow" htmlFor="rota-qtd">Qtd.</label>
                  <select
                    id="rota-qtd"
                    value={maxInput}
                    onChange={(e) => setMaxInput(Number(e.target.value))}
                  >
                    <option value={20}>20</option>
                    <option value={40}>40</option>
                    <option value={60}>60</option>
                  </select>
                </div>
                <button
                  type="submit"
                  className="btn-glow"
                  disabled={buscar.isPending || !setorInput.trim() || !localInput.trim()}
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
          </div>

          {/* Importar — stub discreto, sem ocupar peso visual */}
          <p className="rota-p1-importar muted-line">Importar arquivo (em breve)</p>

        </div>
      )}

      {/* ─── PASSO 2 · ESCOLHER NO MAPA ─────────────────────────────────────── */}
      {passo === 2 && (
        <div className="rota-p2-body">

          {/* Painel esquerdo: filtro + lista */}
          <div className="rota-p2-lista">

            {/* Filtro de bairro */}
            {bairrosDisponiveis.length > 0 && (
              <div className="rota-p2-filtro">
                <label className="eyebrow" htmlFor="rota-bairro-filter" style={{ whiteSpace: 'nowrap' }}>
                  Região
                </label>
                <select
                  id="rota-bairro-filter"
                  value={bairroFilter}
                  onChange={(e) => setBairroFilter(e.target.value)}
                >
                  <option value="">Todos os bairros</option>
                  {bairrosDisponiveis.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="table-bar">
              <span className="table-count">
                <b>{selLeads.length}</b>{' '}
                {selLeads.length === 1 ? 'selecionado' : 'selecionados'} de{' '}
                <b>{comCoord.length}</b>
                {semCoord.length > 0 && (
                  <> · <span className="rota-aviso-coord">{semCoord.length} sem endereço</span></>
                )}
              </span>
              <Checkbox
                checked={todosSelecionadosNoFiltro}
                onChange={(v) => toggleAll(idsComCoordFiltrado, v)}
                title={
                  bairroFilter
                    ? `Selecionar todos de ${bairroFilter}`
                    : 'Selecionar todos'
                }
              />
            </div>

            {isLoading ? (
              <div className="search-status">
                <Loader2 size={15} className="spin" /> Carregando leads…
              </div>
            ) : comCoord.length === 0 ? (
              <div className="empty-state">
                <h3>Nenhum lead com endereço mapeável</h3>
                <p>
                  {origem === 'buscar'
                    ? 'A busca não retornou leads com coordenada. Tente outra região.'
                    : 'Nenhum lead da base tem endereço georeferenciado.'}
                </p>
              </div>
            ) : (
              <div className="table-wrap rota-p2-table-wrap">
                <table className="leads-table">
                  <thead>
                    <tr>
                      <th className="col-check" />
                      <th className="eyebrow">Nome</th>
                      <th className="eyebrow">Bairro</th>
                      <th className="eyebrow">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comCoordOrdenado.map((lead) => {
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
                          <td className={lead.bairro ? undefined : 'cell-dash'}>
                            {fmtText(lead.bairro)}
                          </td>
                          <td>
                            <span
                              className="status-dot"
                              style={{ background: STATUS_META[lead.status].color }}
                            />{' '}
                            {STATUS_META[lead.status].label}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {semCoord.length > 0 && (
              <details className="rota-sem-coord-wrap">
                <summary className="eyebrow rota-sem-coord-summary">
                  {semCoord.length} lead{semCoord.length === 1 ? '' : 's'} sem endereço — não entram na rota ▾
                </summary>
                <ul className="rota-sem-coord-list">
                  {semCoord.map((l) => (
                    <li key={l.id}>
                      {l.nome}
                      {l.bairro ? ` · ${l.bairro}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="oli-actions">
              <button
                className="btn"
                onClick={() => setPasso(3)}
                disabled={selLeads.length === 0}
              >
                <RouteIcon size={15} />
                {selLeads.length === 0
                  ? 'Selecione ao menos uma parada'
                  : `Montar rota com ${selLeads.length} ${selLeads.length === 1 ? 'parada' : 'paradas'}`}
              </button>
            </div>
          </div>

          {/* Mapa direita: pinos dos leads filtrados; clique no popup togela seleção */}
          <LeadsMap
            leads={comCoordFiltrado}
            routeOrder={new Map()}
            startPoint={null}
            onOpenLead={setOpenId}
            selIds={sel}
            onToggleLead={toggleOne}
          />
        </div>
      )}

      {/* ─── PASSO 3 · ROTA PRONTA ───────────────────────────────────────────── */}
      {passo === 3 && (
        <div className="mapa-body">
          <aside className="map-panel">

            {/* Ponto de partida */}
            <div className="rota-inicio-group">
              <div className="eyebrow">Ponto de partida</div>
              <div className="pick-row">
                <button
                  className={`btn ghost sm${pickMode === 'start' ? ' active-pick' : ''}`}
                  onClick={() => setPickMode(pickMode === 'start' ? null : 'start')}
                >
                  <MapPin size={14} />{' '}
                  {pickMode === 'start' ? 'Clique no mapa…' : 'No mapa'}
                </button>
                <button className="btn ghost sm" onClick={usarMinhaLocalizacao}>
                  <Navigation size={14} /> Minha localização
                </button>
              </div>
              {geoMsg && <div className="muted-line">{geoMsg}</div>}
            </div>

            {/* Lista de paradas + ações */}
            {routeStops.length === 0 ? (
              <div className="muted-line">Nenhuma parada — volte ao passo anterior.</div>
            ) : (
              <div className="rota-stop-panel">
                <div className="eyebrow">Rota · {routeStops.length} paradas</div>
                <ol className="stop-list">
                  {routeStops.map((s, i) => {
                    const prev =
                      i === 0
                        ? routeStart
                        : { lat: routeStops[i - 1].lat, lng: routeStops[i - 1].lng }
                    const dist = prev ? haversineKm(prev, s) : 0
                    const jaVisitado = s.status === 'visitado' || localVisitados.has(s.id)
                    return (
                      <li key={s.id}>
                        <div className="stop-main">
                          <span className="stop-num">{i + 1}</span>
                          <div className="stop-info">
                            <div className="stop-name" onClick={() => setOpenId(s.id)}>
                              {s.nome}
                            </div>
                            <div className="stop-sub">
                              <span className="stop-sub-addr">{s.endereco ?? '—'}</span>
                              <span className="stop-sub-dist">
                                {' '}· {dist.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km
                              </span>
                            </div>
                          </div>
                          {jaVisitado ? (
                            <span className="rota-check-done">✓</span>
                          ) : (
                            <button className="btn sm" onClick={() => marcarVisitado(s.id)}>
                              Visitado
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>

                <div className="route-actions">
                  <a
                    className="btn-glow block"
                    href={routeStart ? googleMapsDirUrl(routeStart, routeStops) : '#'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="btn-glow-bg" />
                    <span className="btn-glow-content">
                      <ExternalLink size={15} /> Abrir no Google Maps
                    </span>
                  </a>
                  <a
                    className="btn ghost"
                    href={wazeUrl(routeStops[routeStops.length - 1])}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abrir no Waze
                  </a>
                  <button
                    className="btn"
                    onClick={() =>
                      gerarRotaPdf({
                        area: pdfArea,
                        stops: routeStops,
                        mapElementId: 'route-map',
                      })
                    }
                  >
                    <FileDown size={15} /> Baixar rota (PDF)
                  </button>
                  <button
                    className="btn ghost"
                    onClick={marcarEmRota}
                    disabled={setStatusBulk.isPending}
                  >
                    Marcar paradas como "em rota"
                  </button>
                  {routeMsg && <div className="muted-line">{routeMsg}</div>}
                </div>
              </div>
            )}

          </aside>

          {/* Mapa sempre visível no Passo 3 — garante que id="route-map" existe ao gerar PDF */}
          <LeadsMap
            leads={selLeads}
            routeOrder={routeOrder}
            startPoint={startPoint ?? routeStart}
            onMapClick={handleMapClickP3}
            onOpenLead={setOpenId}
            onMarkVisited={marcarVisitado}
          />
        </div>
      )}

      {openLead && (
        <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />
      )}
    </>
  )
}
