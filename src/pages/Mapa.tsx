// Página 03 · Rotas — redesign v2 (fluxo de 4 passos tipo Olivia)
// Reusa: olivia-steps.wizard, SearchPanel (form inline), useBuscarNegocios,
//         LeadsMap, nearestNeighbor, routePdf, LeadDrawer, Checkbox.
// Seleção LOCAL: não herda selectedIds do LeadsUIProvider (o fluxo de passos
// tem seu próprio estado de seleção independente de outras páginas).

import { useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
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

type Passo = 1 | 2 | 3 | 4
type Origem = 'buscar' | 'base'

const PASSOS: { n: Passo; t: string }[] = [
  { n: 1, t: 'Origem' },
  { n: 2, t: 'Selecionar' },
  { n: 3, t: 'Montar rota' },
  { n: 4, t: 'Sair pra rua' },
]

export default function Mapa() {
  const location = useLocation()
  const { data: leads = [], isLoading } = useLeads()
  const update = useUpdateLead()
  const setStatusBulk = useSetStatusBulk()

  // ── Compatibilidade ClienteOculto → Rotas ──────────────────────────────────
  // ClienteOculto.tsx faz navigate('/rotas', { state: { routeIds } }).
  // Quando presente: abre já no Passo 2 com esses IDs pré-selecionados.
  const navSeed = (location.state as { routeIds?: string[] } | null)?.routeIds ?? null

  // ── Navegação ───────────────────────────────────────────────────────────────
  const [passo, setPasso] = useState<Passo>(navSeed ? 2 : 1)
  const [origem, setOrigem] = useState<Origem | null>(navSeed ? 'base' : null)

  // ── Passo 1 · Buscar agora ──────────────────────────────────────────────────
  const buscar = useBuscarNegocios()
  const [setorInput, setSetorInput] = useState('')
  const [localInput, setLocalInput] = useState('')
  const [maxInput, setMaxInput] = useState(40)
  const [busca, setBusca] = useState<BuscarResult | null>(null)

  // ── Passo 2 · Seleção LOCAL (NÃO herda selectedIds do LeadsUIProvider) ──────
  const [sel, setSel] = useState<Set<string>>(new Set(navSeed ?? []))

  // ── Passo 3 · Configuração do mapa ─────────────────────────────────────────
  const [center, setCenter] = useState<LatLng | null>(null)
  const [radiusKm, setRadiusKm] = useState(1.5)
  const [startPoint, setStartPoint] = useState<LatLng | null>(null)
  const [pickMode, setPickMode] = useState<'center' | 'start' | null>(null)
  const [geoMsg, setGeoMsg] = useState('')

  // ── Passo 4 · Execução ──────────────────────────────────────────────────────
  const [routeMsg, setRouteMsg] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const leadsById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads])

  // ── Pools por origem ────────────────────────────────────────────────────────
  // "Da Base": qualquer lead que saiu da fase de descoberta.
  const baseLeads = useMemo(
    () => leads.filter((l) => l.status !== 'descoberto' && l.status !== 'descartado'),
    [leads],
  )
  // "Buscar agora": leads frescos da última busca (place_ids desta execução).
  const buscarLeads = useMemo(
    () => (busca ? leadsDaBusca(leads, busca.place_ids) : []),
    [leads, busca],
  )
  // Default seed de "Da Base": pendentes de cliente oculto (comportamento original).
  const pendentesOculto = useMemo(() => leads.filter(isClienteOcultoPendente), [leads])

  // Pool ativo para o Passo 2.
  const poolAtivo = useMemo(
    () => (origem === 'buscar' ? buscarLeads : origem === 'base' ? baseLeads : []),
    [origem, buscarLeads, baseLeads],
  )

  // Divisão honesta: com coordenada (pode entrar na rota) vs. sem.
  const comCoord = useMemo(
    () => poolAtivo.filter(temCoord) as LeadComCoord[],
    [poolAtivo],
  )
  const semCoord = useMemo(() => poolAtivo.filter((l) => !temCoord(l)), [poolAtivo])

  // Tabela do Passo 2: pré-selecionados primeiro, depois o resto por nome.
  const comCoordOrdenado = useMemo(
    () =>
      [...comCoord].sort((a, b) => {
        const aS = sel.has(a.id) ? 0 : 1
        const bS = sel.has(b.id) ? 0 : 1
        if (aS !== bS) return aS - bS
        return a.nome.localeCompare(b.nome, 'pt-BR')
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [comCoord], // intencionalmente NÃO reordena a cada toggle (só na entrada do passo)
  )

  // Leads selecionados COM coordenada — o que realmente entra na rota.
  const selLeads = useMemo(
    () => comCoord.filter((l) => sel.has(l.id)),
    [comCoord, sel],
  )

  // ── Rota otimizada ──────────────────────────────────────────────────────────
  const { stops: routeStops, start: routeStart } = useMemo(() => {
    const stops = selLeads
    if (stops.length === 0) return { stops: [] as LeadComCoord[], start: null as LatLng | null }
    const start: LatLng = startPoint ?? center ?? { lat: stops[0].lat, lng: stops[0].lng }
    return { stops: nearestNeighbor(start, stops), start }
  }, [selLeads, startPoint, center])

  const routeOrder = useMemo(
    () => new Map(routeStops.map((l, i) => [l.id, i + 1])),
    [routeStops],
  )

  // Leads dentro do raio opcional (Passo 3).
  const inRadius = useMemo(() => {
    if (!center) return [] as LeadComCoord[]
    return selLeads.filter((l) => haversineKm(center, l) <= radiusKm)
  }, [center, radiusKm, selLeads])
  const inRadiusIds = useMemo(() => new Set(inRadius.map((l) => l.id)), [inRadius])

  // Área para o PDF: derivada dos bairros reais das paradas, não de um filtro.
  const pdfArea = useMemo(() => {
    const bairros = Array.from(new Set(routeStops.map((s) => s.bairro).filter(Boolean)))
    if (bairros.length === 0) return 'Rota'
    if (bairros.length === 1) return bairros[0]!
    return bairros.slice(0, 2).join(' / ') + (bairros.length > 2 ? '…' : '')
  }, [routeStops])

  // ── Helpers de seleção ──────────────────────────────────────────────────────
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

  // ── Passo 1 · Handlers ─────────────────────────────────────────────────────
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
          setOrigem('buscar')
          setPasso(2)
        },
      },
    )
  }

  function selecionarDaBase() {
    // Pré-seleciona pendentesOculto como sugestão; usuário pode alterar no Passo 2.
    setSel(new Set(pendentesOculto.map((l) => l.id)))
    setOrigem('base')
    setPasso(2)
  }

  // ── Passo 3 · Handlers ─────────────────────────────────────────────────────
  function onMapClick(p: LatLng) {
    if (pickMode === 'start') {
      setStartPoint(p)
      setPickMode(null)
    } else {
      setCenter(p)
      if (pickMode === 'center') setPickMode(null)
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
      () => setGeoMsg('Não foi possível obter localização — clique no mapa para definir o início.'),
    )
  }

  // ── Passo 4 · Handlers ─────────────────────────────────────────────────────
  async function marcarEmRota() {
    const ids = routeStops
      .filter(
        (s) =>
          s.status === 'descoberto' ||
          s.status === 'qualificado' ||
          s.status === 'enriquecido',
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
    update.mutate({ id, patch: { status: 'visitado' } })
  }

  function recomecar() {
    setPasso(1)
    setOrigem(null)
    setBusca(null)
    setSel(new Set())
    setCenter(null)
    setStartPoint(null)
    setPickMode(null)
    setRouteMsg('')
    setGeoMsg('')
    buscar.reset()
  }

  const idsComCoord = useMemo(() => comCoord.map((l) => l.id), [comCoord])
  const todosSelecionados =
    idsComCoord.length > 0 && idsComCoord.every((id) => sel.has(id))
  const openLead = openId ? (leadsById.get(openId) ?? null) : null

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">03 · Rotas</div>
        <h1>Roteiro de visitas</h1>
      </header>

      {/* Stepper — mesmo padrão da Olivia (.olivia-steps.wizard) */}
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

      {/* ─── PASSO 1 · ORIGEM ──────────────────────────────────────────────── */}
      {passo === 1 && (
        <div className="rota-origem-grid">

          {/* (a) Buscar agora */}
          <div className="card rota-origem-card">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Buscar agora</div>
            <p className="muted-line" style={{ marginBottom: 16 }}>
              Faça uma nova busca no Google e escolha os leads para rotear.
            </p>
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
                <LocalAutocomplete id="rota-local" value={localInput} onChange={setLocalInput} />
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

          {/* (b) Da Base de Dados */}
          <div className="card rota-origem-card">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Da Base de Dados</div>
            <p className="muted-line" style={{ marginBottom: 16 }}>
              {pendentesOculto.length > 0
                ? `${pendentesOculto.length} visita${pendentesOculto.length === 1 ? '' : 's'} de cliente oculto pendente${pendentesOculto.length === 1 ? '' : 's'} — prontas pra rotear. Você pode ajustar a seleção no próximo passo.`
                : 'Escolha qualquer lead da sua base para montar a rota.'}
            </p>
            <button className="btn" onClick={selecionarDaBase} disabled={isLoading}>
              <ArrowRight size={15} />
              {isLoading ? 'Carregando…' : 'Ir pra seleção'}
            </button>
          </div>

          {/* (c) Importar arquivo — TODO: implementar parsing CSV + geocodificação */}
          <div className="card rota-origem-card rota-origem-em-breve" aria-disabled="true">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Importar arquivo</div>
            <p className="muted-line" style={{ marginBottom: 12 }}>
              Importe uma planilha de leads com endereço.
            </p>
            <span className="badge">Em breve</span>
          </div>

        </div>
      )}

      {/* ─── PASSO 2 · SELECIONAR ───────────────────────────────────────────── */}
      {passo === 2 && (
        <>
          <div className="table-bar">
            <span className="table-count">
              <b>{selLeads.length}</b>{' '}
              {selLeads.length === 1 ? 'selecionado' : 'selecionados'} de{' '}
              <b>{comCoord.length}</b> disponíveis
              {semCoord.length > 0 && (
                <> · <span className="rota-aviso-coord">{semCoord.length} sem endereço mapeável</span></>
              )}
            </span>
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
            <div className="table-wrap">
              <table className="leads-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <Checkbox
                        checked={todosSelecionados}
                        onChange={(v) => toggleAll(idsComCoord, v)}
                        title="Selecionar todos"
                      />
                    </th>
                    <th className="eyebrow">Nome</th>
                    <th className="eyebrow">Bairro</th>
                    <th className="eyebrow">Setor</th>
                    <th className="eyebrow">Endereço</th>
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
                        <td className={lead.setor ? undefined : 'cell-dash'}>
                          {fmtText(lead.setor)}
                        </td>
                        <td className={lead.endereco ? undefined : 'cell-dash'}>
                          {fmtText(lead.endereco)}
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
                {semCoord.length} lead{semCoord.length === 1 ? '' : 's'} sem endereço mapeável — não entram na rota ▾
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
              <RouteIcon size={15} /> Montar rota com{' '}
              {selLeads.length}{' '}
              {selLeads.length === 1 ? 'parada' : 'paradas'}
            </button>
          </div>
        </>
      )}

      {/* ─── PASSO 3 · MONTAR A ROTA ────────────────────────────────────────── */}
      {passo === 3 && (
        <div className="mapa-body">
          <aside className="map-panel">

            <div className="filter-group">
              <div className="eyebrow">Início da rota</div>
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

            <div className="filter-group">
              <div className="eyebrow">Centro do raio (opcional)</div>
              <button
                className={`btn ghost sm${pickMode === 'center' ? ' active-pick' : ''}`}
                onClick={() => setPickMode(pickMode === 'center' ? null : 'center')}
              >
                <Crosshair size={14} />{' '}
                {pickMode === 'center' ? 'Clique no mapa…' : 'Definir pelo mapa'}
              </button>
            </div>

            {center && (
              <div className="filter-group">
                <div className="filter-head">
                  <div className="eyebrow">Raio</div>
                  <span className="range-val">{radiusKm.toLocaleString('pt-BR')} km</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={radiusKm}
                  onChange={(e) => setRadiusKm(Number(e.target.value))}
                />
                <div className="count-big">
                  <b>{inRadius.length}</b> negócios nesse raio
                </div>
              </div>
            )}

            <div className="filter-group">
              <div className="eyebrow">Rota · {routeStops.length} paradas</div>
              <p className="muted-line">
                {routeStops.length === 0
                  ? 'Volte ao passo anterior para selecionar paradas.'
                  : 'Ordem otimizada pelo algoritmo de vizinho-mais-próximo. Defina o início para recalcular.'}
              </p>
            </div>

            <div className="oli-actions" style={{ padding: 0 }}>
              <button
                className="btn"
                onClick={() => setPasso(4)}
                disabled={routeStops.length === 0}
              >
                <ArrowRight size={15} /> Pronto — sair pra rua
              </button>
            </div>

          </aside>

          <LeadsMap
            leads={selLeads}
            center={center}
            radiusKm={radiusKm}
            inRadiusIds={inRadiusIds}
            routeOrder={routeOrder}
            startPoint={startPoint ?? routeStart}
            onMapClick={onMapClick}
            onOpenLead={setOpenId}
            onMarkVisited={marcarVisitado}
          />
        </div>
      )}

      {/* ─── PASSO 4 · SAIR PRA RUA ─────────────────────────────────────────── */}
      {passo === 4 && (
        <>
          {routeStops.length === 0 ? (
            <div className="empty-state">
              <h3>Nenhuma parada na rota</h3>
              <p>Volte ao passo 2 e selecione ao menos um lead com endereço.</p>
            </div>
          ) : (
            <div className="filter-group">
              <div className="eyebrow">Rota · {routeStops.length} paradas</div>
              <ol className="stop-list">
                {routeStops.map((s, i) => {
                  const prev =
                    i === 0
                      ? routeStart
                      : { lat: routeStops[i - 1].lat, lng: routeStops[i - 1].lng }
                  const dist = prev ? haversineKm(prev, s) : 0
                  return (
                    <li key={s.id}>
                      <div className="stop-main">
                        <span className="stop-num">{i + 1}</span>
                        <div className="stop-info">
                          <div className="stop-name" onClick={() => setOpenId(s.id)}>
                            {s.nome}
                          </div>
                          <div className="stop-sub">
                            {s.endereco ?? '—'} ·{' '}
                            {dist.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km
                          </div>
                        </div>
                        {s.status !== 'visitado' && (
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
                {routeStops.length > 0 && (
                  <a
                    className="btn ghost"
                    href={wazeUrl(routeStops[routeStops.length - 1])}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Abrir no Waze
                  </a>
                )}
                <button
                  className="btn"
                  onClick={() =>
                    gerarRotaPdf({ area: pdfArea, stops: routeStops, mapElementId: 'route-map' })
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
        </>
      )}

      {openLead && (
        <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />
      )}
    </>
  )
}
