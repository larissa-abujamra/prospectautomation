import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Crosshair, MapPin, Route as RouteIcon, FileDown, ExternalLink, Navigation } from 'lucide-react'
import { useLeads, useUpdateLead } from '../lib/leads'
import { useLeadsUI } from '../context/leadsUI'
import { applyFilters, distinctBairros } from '../components/leads/filters'
import { haversineKm, nearestNeighbor, googleMapsDirUrl, wazeUrl, temCoord } from '../lib/route'
import type { LatLng, LeadComCoord } from '../lib/route'
import { gerarRotaPdf } from '../lib/routePdf'
import { LeadsMap } from '../components/mapa/LeadsMap'
import { LeadDrawer } from '../components/leads/LeadDrawer'

export default function Mapa() {
  const navigate = useNavigate()
  const location = useLocation()
  const { data: leads = [] } = useLeads()
  const { filters, selectedIds } = useLeadsUI()
  const update = useUpdateLead()

  const [center, setCenter] = useState<LatLng | null>(null)
  const [radiusKm, setRadiusKm] = useState(1.5)
  const [startPoint, setStartPoint] = useState<LatLng | null>(null)
  const [pickMode, setPickMode] = useState<'center' | 'start' | null>(null)
  // Conjunto (não ordenado) de leads que compõem a rota. A ordenação é derivada.
  // Semeado pela navegação "Rotear selecionados" da tabela (state.routeIds).
  const [routeSeedIds, setRouteSeedIds] = useState<string[]>(
    () => (location.state as { routeIds?: string[] } | null)?.routeIds ?? [],
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [geoMsg, setGeoMsg] = useState('')

  // Mesmos filtros da tabela de Leads (via contexto compartilhado).
  const filtered = useMemo(() => applyFilters(leads, filters), [leads, filters])
  const comCoord = useMemo(() => filtered.filter(temCoord), [filtered])
  const semCoord = filtered.length - comCoord.length
  const bairros = useMemo(() => distinctBairros(leads), [leads])
  const leadsById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads])

  // Leads dentro do raio do centro.
  const inRadius = useMemo(() => {
    if (!center) return [] as LeadComCoord[]
    return comCoord.filter((l) => haversineKm(center, l) <= radiusKm)
  }, [center, radiusKm, comCoord])
  const inRadiusIds = useMemo(() => new Set(inRadius.map((l) => l.id)), [inRadius])

  // Rota DERIVADA: pega os leads do conjunto (status fresco), define o início
  // (ponto escolhido → centro → 1º stop) e ordena por vizinho-mais-próximo.
  const { stops: routeStops, start: routeStart } = useMemo(() => {
    const stops = routeSeedIds
      .map((id) => leadsById.get(id))
      .filter((l): l is NonNullable<typeof l> => !!l)
      .filter(temCoord)
    if (stops.length === 0) return { stops: [] as LeadComCoord[], start: null as LatLng | null }
    const start: LatLng = startPoint ?? center ?? { lat: stops[0].lat, lng: stops[0].lng }
    return { stops: nearestNeighbor(start, stops), start }
  }, [routeSeedIds, leadsById, startPoint, center])

  const routeOrder = useMemo(() => new Map(routeStops.map((l, i) => [l.id, i + 1])), [routeStops])

  const rotear = (source: LeadComCoord[]) => setRouteSeedIds(source.map((l) => l.id))

  function onMapClick(p: LatLng) {
    if (pickMode === 'start') {
      setStartPoint(p)
      setPickMode(null)
    } else {
      // padrão: define o centro do raio
      setCenter(p)
      if (pickMode === 'center') setPickMode(null)
    }
  }

  function escolherBairro(b: string) {
    if (!b) {
      setCenter(null)
      return
    }
    const pts = comCoord.filter((l) => l.bairro === b)
    if (pts.length === 0) return
    // centroide simples do bairro
    const lat = pts.reduce((s, l) => s + l.lat, 0) / pts.length
    const lng = pts.reduce((s, l) => s + l.lng, 0) / pts.length
    setCenter({ lat, lng })
  }

  function usarMinhaLocalizacao() {
    setGeoMsg('')
    if (!navigator.geolocation) {
      setGeoMsg('Geolocalização indisponível — clique no mapa para definir o início.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setStartPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeoMsg('Não foi possível obter sua localização — clique no mapa para definir o início.'),
    )
  }

  async function marcarEmRota() {
    for (const s of routeStops) {
      if (s.status === 'descoberto' || s.status === 'qualificado' || s.status === 'enriquecido') {
        await update.mutateAsync({ id: s.id, patch: { status: 'em_rota' } })
      }
    }
  }

  function marcarVisitado(id: string) {
    update.mutate({ id, patch: { status: 'visitado' } })
  }

  const area = filters.bairro || 'São Paulo'

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Roteirização</div>
        <h1>Mapa</h1>
      </header>

      <div className="mapa-body">
        <aside className="map-panel">
          <div className="filter-group">
            <div className="eyebrow">Cobertura</div>
            <p className="muted-line">
              {comCoord.length} de {filtered.length} leads no mapa (filtros da aba Leads).{' '}
              <button className="linkish" onClick={() => navigate('/')}>Ajustar filtros</button>
            </p>
            {semCoord > 0 && (
              <div className="sem-coord">
                {semCoord} {semCoord === 1 ? 'lead' : 'leads'} sem coordenada — não plotado(s).
              </div>
            )}
          </div>

          <div className="filter-group">
            <div className="eyebrow">Centro do raio</div>
            <button
              className={`btn ghost sm${pickMode === 'center' ? ' active-pick' : ''}`}
              onClick={() => setPickMode(pickMode === 'center' ? null : 'center')}
            >
              <Crosshair size={14} /> {pickMode === 'center' ? 'Clique no mapa…' : 'Definir pelo mapa'}
            </button>
            <div className="field" style={{ marginTop: 8 }}>
              <select value={filters.bairro || ''} onChange={(e) => escolherBairro(e.target.value)}>
                <option value="">Ou escolher bairro…</option>
                {bairros.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
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
                <b>{inRadius.length}</b> {inRadius.length === 1 ? 'doceria' : 'docerias'} nesse raio
              </div>
              <button className="btn" onClick={() => rotear(inRadius)} disabled={inRadius.length === 0}>
                <RouteIcon size={15} /> Montar rota com esses {inRadius.length}
              </button>
            </div>
          )}

          <div className="filter-group">
            <div className="eyebrow">Início da rota</div>
            <div className="pick-row">
              <button
                className={`btn ghost sm${pickMode === 'start' ? ' active-pick' : ''}`}
                onClick={() => setPickMode(pickMode === 'start' ? null : 'start')}
              >
                <MapPin size={14} /> {pickMode === 'start' ? 'Clique no mapa…' : 'No mapa'}
              </button>
              <button className="btn ghost sm" onClick={usarMinhaLocalizacao}>
                <Navigation size={14} /> Minha localização
              </button>
            </div>
            {geoMsg && <div className="muted-line">{geoMsg}</div>}
            {selectedIds.size > 0 && (
              <button
                className="btn ghost sm"
                style={{ marginTop: 8 }}
                onClick={() => rotear(comCoord.filter((l) => selectedIds.has(l.id)))}
              >
                <RouteIcon size={14} /> Rotear seleção ({comCoord.filter((l) => selectedIds.has(l.id)).length})
              </button>
            )}
          </div>

          {routeStops.length > 0 && (
            <div className="filter-group">
              <div className="eyebrow">Rota · {routeStops.length} paradas</div>
              <ol className="stop-list">
                {routeStops.map((s, i) => {
                  const prev = i === 0 ? routeStart : { lat: routeStops[i - 1].lat, lng: routeStops[i - 1].lng }
                  const dist = prev ? haversineKm(prev, s) : 0
                  return (
                    <li key={s.id}>
                      <div className="stop-main">
                        <span className="stop-num">{i + 1}</span>
                        <div className="stop-info">
                          <div className="stop-name" onClick={() => setOpenId(s.id)}>{s.nome}</div>
                          <div className="stop-sub">
                            {s.endereco ?? '—'} · {dist.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km
                          </div>
                        </div>
                        {s.status !== 'visitado' && (
                          <button className="btn sm" onClick={() => marcarVisitado(s.id)}>Visitado</button>
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
                  <span className="btn-glow-content"><ExternalLink size={15} /> Abrir no Google Maps</span>
                </a>
                <a
                  className="btn ghost"
                  href={wazeUrl(routeStops[routeStops.length - 1])}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir no Waze
                </a>
                <button className="btn" onClick={() => gerarRotaPdf({ area, stops: routeStops, mapElementId: 'route-map' })}>
                  <FileDown size={15} /> Baixar rota (PDF)
                </button>
                <button className="btn ghost" onClick={marcarEmRota} disabled={update.isPending}>
                  Marcar paradas como “em rota”
                </button>
              </div>
            </div>
          )}
        </aside>

        <LeadsMap
          leads={comCoord}
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

      {openId && leadsById.get(openId) && (
        <LeadDrawer key={openId} lead={leadsById.get(openId)!} onClose={() => setOpenId(null)} />
      )}
    </>
  )
}
