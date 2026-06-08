// Tipos do domínio — espelham a tabela public.leads (migration 0001).

export const LEAD_STATUSES = [
  'descoberto',
  'qualificado',
  'enriquecido',
  'em_rota',
  'visitado',
  'contatado',
  'interessado',
  'descartado',
] as const

export type LeadStatus = (typeof LEAD_STATUSES)[number]

export interface Socio {
  nome: string | null
  qualificacao: string | null
}

export interface Lead {
  id: string
  // Módulo 1 — sourcing (Google Places)
  nome: string
  endereco: string | null
  bairro: string | null
  cidade: string | null
  lat: number | null
  lng: number | null
  google_place_id: string | null
  telefone: string | null
  website: string | null
  rating: number | null
  reviews_count: number | null
  instagram_handle: string | null
  instagram_followers: number | null
  // Módulo 2 — enriquecimento
  cnpj: string | null
  razao_social: string | null
  socios: Socio[] | null
  dono_nome: string | null
  enrich_status: Record<string, string> | null
  // pipeline
  status: LeadStatus
  notas: string | null
  created_at: string
  updated_at: string
}

// Rótulo + cor (somente tokens do design system) por estágio do funil.
// A cor é aplicada num `.status-dot` via style inline — não é um novo sistema
// de cor, reaproveita as variáveis existentes.
export const STATUS_META: Record<LeadStatus, { label: string; color: string }> = {
  descoberto: { label: 'Descoberto', color: '#C4C9D1' },
  qualificado: { label: 'Qualificado', color: 'var(--fin)' },
  enriquecido: { label: 'Enriquecido', color: 'var(--fin)' },
  em_rota: { label: 'Em rota', color: 'var(--maky)' },
  visitado: { label: 'Visitado', color: 'var(--maky)' },
  contatado: { label: 'Contatado', color: 'var(--maky)' },
  interessado: { label: 'Interessado', color: 'var(--waz)' },
  descartado: { label: 'Descartado', color: 'var(--ink-3)' },
}
