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

export type EnrichFieldStatus = 'pending' | 'ok' | 'missing'

export interface EnrichStatus {
  cnpj?: EnrichFieldStatus
  dono?: EnrichFieldStatus
  instagram?: EnrichFieldStatus
  cnpj_confidence?: number
}

// Módulo WhatsApp (Parte A — descoberta do número).
export type WhatsappStatus = 'pending' | 'found' | 'missing' | 'invalid'
export type WhatsappSource = 'google' | 'instagram' | 'website' | 'manual'
// Módulo WhatsApp (Parte D — envio do template via Meta Cloud API).
export type WhatsappSendStatus =
  | 'sent'
  | 'failed'
  | 'invalid'
  | 'delivered'
  | 'read'
  | 'replied'

export interface Lead {
  id: string
  // Módulo 1 — sourcing (Google Places)
  nome: string
  setor: string | null
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
  horario_funcionamento: string[] | null
  instagram_handle: string | null
  instagram_followers: number | null
  // Módulo 2 — enriquecimento
  cnpj: string | null
  razao_social: string | null
  socios: Socio[] | null
  dono_nome: string | null
  porte: string | null // faixa legal de porte (BrasilAPI) — NÃO é faturamento medido
  mei: boolean | null
  enrich_status: EnrichStatus | null
  // Módulo WhatsApp (Parte A)
  whatsapp_phone: string | null
  whatsapp_source: WhatsappSource | null
  whatsapp_status: WhatsappStatus | null
  // Gênero gramatical do nome ('f'|'m') — escolhe o template _f/_m (artigo o/a)
  nome_genero: 'f' | 'm' | null
  // Módulo WhatsApp (Parte B — sync com HubSpot)
  hubspot_contact_id: string | null
  hubspot_synced_at: string | null
  // Módulo WhatsApp (Parte D — envio via Meta Cloud API)
  whatsapp_send_status: WhatsappSendStatus | null
  whatsapp_sent_at: string | null
  whatsapp_msg_id: string | null
  // pipeline
  status: LeadStatus
  notas: string | null
  hubspot_exported_at: string | null
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
