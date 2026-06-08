import type { Lead } from './types'

export interface LatLng {
  lat: number
  lng: number
}

// Lead garantidamente com coordenada (estreita o tipo pra evitar checagens).
export type LeadComCoord = Lead & { lat: number; lng: number }

export function temCoord(l: Lead): l is LeadComCoord {
  return l.lat != null && l.lng != null
}

// Distância haversine em km entre dois pontos.
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Ordena os stops por vizinho-mais-próximo (greedy) a partir de `start`.
// NÃO é o TSP ótimo — é uma heurística boa o suficiente pra porta-a-porta num
// bairro. (Upgrade futuro opcional: OSRM para distância por rua.)
export function nearestNeighbor(start: LatLng, stops: LeadComCoord[]): LeadComCoord[] {
  const remaining = [...stops]
  const ordered: LeadComCoord[] = []
  let current: LatLng = start
  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(current, remaining[i])
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    const next = remaining.splice(bestIdx, 1)[0]
    ordered.push(next)
    current = { lat: next.lat, lng: next.lng }
  }
  return ordered
}

const coord = (p: LatLng) => `${p.lat},${p.lng}`

// Deep link de navegação do Google Maps (sem chave). A ordem dos waypoints é a
// ordem da rota; o último stop vira o destino.
export function googleMapsDirUrl(origin: LatLng, stops: LeadComCoord[]): string {
  if (stops.length === 0) return ''
  const destination = stops[stops.length - 1]
  const waypoints = stops.slice(0, -1).map((s) => coord(s)).join('|')
  const params = new URLSearchParams({
    api: '1',
    origin: coord(origin),
    destination: coord(destination),
    travelmode: 'driving',
  })
  // waypoints precisa do separador '|' sem encode para o Google interpretar.
  const wp = waypoints ? `&waypoints=${waypoints}` : ''
  return `https://www.google.com/maps/dir/?${params.toString()}${wp}`
}

// Deep link do Waze (só destino — o Waze não aceita múltiplos waypoints por URL).
export function wazeUrl(dest: LatLng): string {
  return `https://waze.com/ul?ll=${dest.lat},${dest.lng}&navigate=yes`
}
