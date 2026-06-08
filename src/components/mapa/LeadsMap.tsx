import 'leaflet/dist/leaflet.css'
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMapEvents } from 'react-leaflet'
import type { LatLng, LeadComCoord } from '../../lib/route'
import { fmtInt, fmtRating } from '../../lib/format'
import { pinIcon, startIcon } from './markers'

// Centro de São Paulo (fallback quando ainda não há nada definido).
const SP_CENTER: LatLng = { lat: -23.5615, lng: -46.6562 }

function ClickCapture({ onClick }: { onClick: (p: LatLng) => void }) {
  useMapEvents({
    click(e) {
      onClick({ lat: e.latlng.lat, lng: e.latlng.lng })
    },
  })
  return null
}

export function LeadsMap({
  leads,
  center,
  radiusKm,
  inRadiusIds,
  routeOrder,
  startPoint,
  onMapClick,
  onOpenLead,
  onMarkVisited,
}: {
  leads: LeadComCoord[]
  center: LatLng | null
  radiusKm: number
  inRadiusIds: Set<string>
  routeOrder: Map<string, number> // id -> número da parada (1-based)
  startPoint: LatLng | null
  onMapClick: (p: LatLng) => void
  onOpenLead: (id: string) => void
  onMarkVisited: (id: string) => void
}) {
  // Polyline da rota: início → stops na ordem.
  const ordered = [...routeOrder.entries()].sort((a, b) => a[1] - b[1])
  const polyPoints: [number, number][] = []
  if (startPoint) polyPoints.push([startPoint.lat, startPoint.lng])
  for (const [id] of ordered) {
    const l = leads.find((x) => x.id === id)
    if (l) polyPoints.push([l.lat, l.lng])
  }

  return (
    <div id="route-map" className="map-box">
      <MapContainer center={[SP_CENTER.lat, SP_CENTER.lng]} zoom={12} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          crossOrigin="anonymous"
        />

        <ClickCapture onClick={onMapClick} />

        {center && (
          <Circle
            center={[center.lat, center.lng]}
            radius={radiusKm * 1000}
            pathOptions={{ color: '#111827', weight: 1.5, fillColor: '#111827', fillOpacity: 0.05 }}
          />
        )}

        {polyPoints.length > 1 && (
          <Polyline positions={polyPoints} pathOptions={{ color: '#f45dac', weight: 3, opacity: 0.85 }} />
        )}

        {startPoint && <Marker position={[startPoint.lat, startPoint.lng]} icon={startIcon()} />}

        {leads.map((l) => (
          <Marker
            key={l.id}
            position={[l.lat, l.lng]}
            icon={pinIcon(l.status, {
              highlight: inRadiusIds.has(l.id),
              number: routeOrder.get(l.id),
            })}
          >
            <Popup>
              <div className="map-popup">
                <strong>{l.nome}</strong>
                <div className="mp-line">
                  {l.bairro ?? '—'} · Nota {fmtRating(l.rating)} · {fmtInt(l.instagram_followers)} seg.
                </div>
                <div className="mp-actions">
                  <button className="btn ghost sm" onClick={() => onOpenLead(l.id)}>
                    Ver detalhes
                  </button>
                  {l.status !== 'visitado' && (
                    <button className="btn sm" onClick={() => onMarkVisited(l.id)}>
                      Visitado
                    </button>
                  )}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}
