import { useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Crosshair, MapPin, Route as RouteIcon, FileDown, ExternalLink, Navigation } from 'lucide-react'
import { useLeads, useUpdateLead, useSetStatusBulk } from '../lib/leads'
import { isClienteOcultoPendente } from '../lib/clienteOculto'
import { useLeadsUI } from '../context/leadsUI'
import { applyFilters, distinctBairros, distinctSetores, EMPTY_FILTERS } from '../components/leads/filters'
import type { Filters } from '../components/leads/filters'
import { LeadFilters } from '../components/leads/LeadFilters'
import { nounSetor } from '../lib/format'
import { haversineKm, nearestNeighbor, googleMapsDirUrl, wazeUrl, temCoord } from '../lib/route'
import type { LatLng, LeadComCoord } from '../lib/route'
import { gerarRotaPdf } from '../lib/routePdf'
import { LeadsMap } from '../components/mapa/LeadsMap'
import { LeadDrawer } from '../components/leads/LeadDrawer'

export default function Mapa() {
  const location = useLocation()
  const { data: leads = [] } = useLeads()
  const { selectedIds } = useLeadsUI()
  const update = useUpdateLead()
  const setStatusBulk = useSetStatusBulk()
  const [routeMsg, setRouteMsg] = useState('')
  // Filtros próprios do mapa (independentes do Buscar) — narram o que é plotado.
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)

  const [center, setCenter] = useState<LatLng | null>(null)
  const [radiusKm, setRadiusKm] = useState(1.5)
  const [startPoint, setStartPoint] = useState<LatLng | null>(null)
  const [pickMode, setPickMode] = useState<'center' | 'start' | null>(null)
  // Seleção EXPLÍCITA do usuário (CTA "Montar roteiro" → state.routeIds, ou os
  // botões "rotear" no mapa). null = ainda não mexeu → cai no roteiro padrão
  // (pendentes de cliente oculto), derivado abaixo. Evita setState-em-effect.
  const navSeed = (location.state as { routeIds?: string[] } | null)?.routeIds ?? null
  const [userSeed, setUserSeed] = useState<string[] | null>(navSeed)
  const [openId, setOpenId] = useState<string | null>(null)
  const [geoMsg, setGeoMsg] = useState('')

  // Mesmos filtros da tabela de Leads (via contexto compartilhado).
  const filtered = useMemo(() => applyFilters(leads, filters), [leads, filters])
  const comCoord = useMemo(() => filtered.filter(temCoord), [filtered])
  const semCoord = filtered.length - comCoord.length
  const bairros = useMemo(() => distinctBairros(leads), [leads])
  const setores = useMemo(() => distinctSetores(leads), [leads])
  const leadsById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads])

  // Visitas de cliente oculto pendentes COM coordenada — o roteiro PADRÃO da Rotas.
  const pendentesOculto = useMemo(
    () => leads.filter((l) => isClienteOcultoPendente(l) && temCoord(l)),
    [leads],
  )
  // Roteiro efetivo: o que o usuário escolheu, ou o padrão (pendentes de cliente
  // oculto) enquanto ele não mexeu. Derivado — sem setState-em-effect.
  const routeSeedIds = useMemo(
    () => userSeed ?? pendentesOculto.map((l) => l.id),
    [userSeed, pendentesOculto],
  )

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

  const rotear = (source: LeadComCoord[]) => setUserSeed(source.map((l) => l.id))

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

  // Centra o raio no centroide do bairro filtrado (atalho do "Centro do raio").
  function centralizarNoBairro(b: string) {
    const pts = comCoord.filter((l) => l.bairro === b)
    if (pts.length === 0) return
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

  // Marca as paradas elegíveis como "em rota" em UMA query (update em lote), em
  // vez de N mutateAsync sequenciais — que, na falha do meio, deixavam parte das
  // paradas atualizadas em silêncio. Atômico + um único refetch + feedback claro.
  async function marcarEmRota() {
    const ids = routeStops
      .filter((s) => s.status === 'descoberto' || s.status === 'qualificado' || s.status === 'enriquecido')
      .map((s) => s.id)
    if (ids.length === 0) {
      setRouteMsg('Nenhuma parada elegível (já estão em rota/visitadas).')
      return
    }
    setRouteMsg('')
    try {
      await setStatusBulk.mutateAsync({ ids, status: 'em_rota' })
      setRouteMsg(`${ids.length} ${ids.length === 1 ? 'parada marcada' : 'paradas marcadas'} como “em rota”.`)
    } catch (e) {
      setRouteMsg(`Não foi possível atualizar as paradas: ${(e as Error).message}`)
    }
  }

  function marcarVisitado(id: string) {
    update.mutate({ id, patch: { status: 'visitado' } })
  }

  const area = filters.bairro || 'São Paulo'

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">03 · Rotas</div>
        <h1>Roteiro de visitas</h1>
        <p className="page-sub">
          Já vem com as visitas de cliente oculto pendentes na ordem otimizada —
          é só abrir no Google Maps/Waze ou baixar o PDF do dia. Dá pra ajustar a
          seleção no mapa.
        </p>
      </header>

      <div className="mapa-body">
        <aside className="map-panel">
          <LeadFilters
            filters={filters}
            onChange={setFilters}
            bairros={bairros}
            setores={setores}
            statusOptions={['descoberto', 'enriquecido', 'contatado', 'descartado']}
          />

          <div className="filter-group">
            <div className="eyebrow">Cobertura</div>
            <p className="muted-line">
              {comCoord.length} de {filtered.length} leads no mapa.
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
              <select value="" onChange={(e) => e.target.value && centralizarNoBairro(e.target.value)}>
                <option value="">Centralizar no bairro…</option>
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
                <b>{inRadius.length}</b> {nounSetor(filters.setor, inRadius.length)} nesse raio
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
                <button className="btn ghost" onClick={marcarEmRota} disabled={setStatusBulk.isPending}>
                  Marcar paradas como “em rota”
                </button>
                {routeMsg && <div className="muted-line">{routeMsg}</div>}
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
