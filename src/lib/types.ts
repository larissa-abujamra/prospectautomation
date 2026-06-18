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

export const LEAD_ORIGENS = ['google_places', 'squad_leads_form', 'manual_olivia', 'rf_cnpj'] as const
export type LeadOrigem = (typeof LEAD_ORIGENS)[number]

export const INBOUND_CLASSIFICATIONS = ['quente', 'nutrir', 'descartar'] as const
export type InboundClassification = (typeof INBOUND_CLASSIFICATIONS)[number]

export const INBOUND_REVENUE_RANGES = [
  'menos_10k',
  '10k_20k',
  '20k_50k',
  '50k_100k',
  'acima_100k',
] as const
export type InboundRevenueRange = (typeof INBOUND_REVENUE_RANGES)[number]

export const INBOUND_READY_TO_IMPLEMENT = [
  'sim_certeza',
  'talvez',
  'nao_proximos_7dias',
] as const
export type InboundReadyToImplement = (typeof INBOUND_READY_TO_IMPLEMENT)[number]

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
export type WhatsappSource = 'google' | 'instagram' | 'website' | 'manual' | 'perplexity'
// Módulo WhatsApp (Parte D, legado): status do envio/template.
export type WhatsappSendStatus =
  | 'sent'
  | 'failed'
  | 'invalid'
  | 'delivered'
  | 'read'
  | 'replied'

// Olivia Autônoma (Fase A — inbound). Máquina de estados da conversa; ver
// migration 0011 e .claude/plans/2026-06-10-olivia-autonoma.md.
export type OliviaEstado =
  | 'aguardando'
  | 'conversando'
  | 'agendando'
  | 'agendado'
  | 'handoff'
  | 'optout'
  | 'pausada'

// Mensagem do histórico WhatsApp (tabela whatsapp_mensagens, gravada pelo
// webhook). lead_id null = remetente não casou com nenhum lead (guardada
// mesmo assim — anti-invenção: não vinculamos no chute).
export interface WhatsappMensagem {
  id: string
  lead_id: string | null
  direcao: 'in' | 'out'
  wamid: string | null
  tipo: string | null
  corpo: string | null
  enviada_em: string
  created_at: string
}

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
  squad_leads_id: number | null
  origem: LeadOrigem
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
  whatsapp_checked_at: string | null
  // true quando o DDD do número achado diverge da praça do lead (possível número
  // errado/fornecedor) — bloqueia o disparo automático até revisão humana.
  whatsapp_ddd_mismatch: boolean | null
  // Gênero gramatical do nome ('f'|'m') — escolhe o template _f/_m (artigo o/a)
  nome_genero: 'f' | 'm' | null
  // Módulo WhatsApp (Parte B — sync com HubSpot)
  hubspot_contact_id: string | null
  hubspot_synced_at: string | null
  // Negócio (deal) no pipeline Squad Prospects — criado pelo "Importar pra HubSpot"
  hubspot_deal_id: string | null
  // Contato HubSpot separado para o dono/responsável indicado pela Olivia.
  hubspot_responsavel_contact_id: string | null
  // Módulo WhatsApp (Parte D, legado): envio/template status
  whatsapp_send_status: WhatsappSendStatus | null
  whatsapp_sent_at: string | null
  whatsapp_msg_id: string | null
  // Olivia Autônoma (Fase A — migration 0011)
  olivia_estado: OliviaEstado | null
  olivia_handoff_motivo: string | null
  reuniao_at: string | null
  reuniao_link: string | null
  prospect_email: string | null
  olivia_pending_slot_iso: string | null
  olivia_reply_apos: string | null
  olivia_lock: string | null
  olivia_pending_rep_email: string | null
  olivia_pending_rep_nome: string | null
  olivia_assigned_rep_email: string | null
  olivia_assigned_rep_nome: string | null
  reuniao_calendar_event_id: string | null
  reuniao_calendar_link: string | null
  reuniao_calendar_title: string | null
  // Fase 2 do re-layout: WhatsApp da dona(o) — preenchido MANUALMENTE pelo time
  // (sem data broker, LGPD). O disparo prefere este número quando presente.
  whatsapp_dono: string | null
  // Macro 1 — sinais de qualificação da bio do Instagram (migration 0015)
  bio_ponto_fisico: boolean
  bio_linktree: boolean
  bio_whatsapp_vendas: boolean
  bio_delivery_proprio: boolean
  // NULL = ainda não classificado; 0–6 quando enriquecido.
  lead_score: number | null
  // Fase 2 do re-layout: cliente oculto (check ✓ na Base de Dados)
  cliente_oculto_at: string | null
  cliente_oculto_notas: string | null
  // Leads inbound do app Squad Leads (waitlist/formulário externo).
  inbound_score: number | null
  inbound_classification: InboundClassification | null
  inbound_revenue_range: InboundRevenueRange | null
  inbound_ready_to_implement: InboundReadyToImplement | null
  inbound_created_at: string | null
  inbound_utm_source: string | null
  inbound_utm_medium: string | null
  inbound_utm_campaign: string | null
  inbound_meta: Record<string, unknown> | null
  // pipeline
  status: LeadStatus
  notas: string | null
  hubspot_exported_at: string | null
  created_at: string
  updated_at: string
}

export const LEAD_ORIGEM_LABEL: Record<LeadOrigem, string> = {
  google_places: 'Google Places',
  squad_leads_form: 'Squad Leads',
  manual_olivia: 'Manual Olivia',
  rf_cnpj: 'Receita (CNPJ)',
}

export const INBOUND_CLASSIFICATION_LABEL: Record<InboundClassification, string> = {
  quente: 'Quente',
  nutrir: 'Nutrir',
  descartar: 'Descartar',
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

// Rótulo + dot (semântica do .status-dot) de cada estado da conversa da Olivia.
// Fonte única — usada pela aba Conversa, pelo cockpit e pelo badge na Base.
export const OLIVIA_ESTADO_META: Record<
  OliviaEstado,
  { label: string; dot: 'empty' | 'pending' | 'ok' | 'missing' }
> = {
  aguardando: { label: 'Aguardando resposta', dot: 'empty' },
  conversando: { label: 'Conversando', dot: 'pending' },
  agendando: { label: 'Agendando reunião', dot: 'pending' },
  agendado: { label: 'Reunião agendada', dot: 'ok' },
  handoff: { label: 'Precisa de você', dot: 'missing' },
  optout: { label: 'Opt-out — não contatar', dot: 'missing' },
  pausada: { label: 'Olivia pausada', dot: 'missing' },
}

// Erro operacional registrado pelas edge functions (tabela olivia_erros) — o que
// o painel "Erros" mostra pro time. Ver migration 0026 e _shared/erros.ts.
export interface OliviaErro {
  id: string
  created_at: string
  fonte: string
  nivel: 'error' | 'warn'
  lead_id: string | null
  mensagem: string
  contexto: Record<string, unknown> | null
}
