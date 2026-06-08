import L from 'leaflet'
import type { LeadStatus } from '../../lib/types'

// Cor do pino por status (só tokens do design system).
export const MARKER_COLOR: Record<LeadStatus, string> = {
  descoberto: 'var(--fin)', // azul destacado (em vez de cinza) — docerias a prospectar
  qualificado: 'var(--fin)',
  enriquecido: 'var(--fin)',
  em_rota: 'var(--maky)',
  contatado: 'var(--maky)',
  visitado: 'var(--waz)',
  interessado: 'var(--waz)',
  descartado: 'var(--ink-3)',
}

// Marcador círculo simples (não pin pesado). Pode mostrar nº da rota e destaque.
export function pinIcon(
  status: LeadStatus,
  opts: { highlight?: boolean; number?: number } = {},
): L.DivIcon {
  const ring = opts.highlight ? 'box-shadow:0 0 0 4px rgba(0,0,0,.14);' : ''
  const num = opts.number != null ? `<span class="map-pin-num">${opts.number}</span>` : ''
  const size = opts.number != null ? 22 : 18
  return L.divIcon({
    className: 'map-pin-wrap',
    html: `<span class="map-pin" style="background:${MARKER_COLOR[status]};width:${size}px;height:${size}px;${ring}">${num}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// Marcador do ponto de início da rota (quadrado preto).
export function startIcon(): L.DivIcon {
  return L.divIcon({
    className: 'map-pin-wrap',
    html: `<span class="map-start"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}
