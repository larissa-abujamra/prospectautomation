import type { InboundClassification, Lead, LeadOrigem } from './types'

// Seleção do wizard da Olivia (passo 2). Garante que o que aparece e o que é
// processado é EXATAMENTE a busca atual — nem todos os 'descoberto' do banco,
// nem leads já processados que voltaram numa re-busca.

const WHATSAPP_SEND_STATUS_COM_DISPARO = new Set<Lead['whatsapp_send_status']>([
  'sent',
  'delivered',
  'read',
  'replied',
])
const WHATSAPP_SEND_STATUS_REENVIAVEL = new Set<Lead['whatsapp_send_status']>([
  'failed',
  'invalid',
])

export function jaTeveDisparo(
  lead: Pick<Lead, 'whatsapp_sent_at' | 'whatsapp_send_status'>,
): boolean {
  if (WHATSAPP_SEND_STATUS_REENVIAVEL.has(lead.whatsapp_send_status)) return false
  if (WHATSAPP_SEND_STATUS_COM_DISPARO.has(lead.whatsapp_send_status)) return true
  return !!lead.whatsapp_sent_at
}

export function leadDisponivelParaProspeccao(
  lead: Pick<Lead, 'origem' | 'status' | 'whatsapp_sent_at' | 'whatsapp_send_status'>,
): boolean {
  if (lead.origem === 'squad_leads_form') return false
  return lead.status === 'descoberto' && !jaTeveDisparo(lead)
}

// Leads desta busca que estão prontos pra processar: status 'descoberto', sem
// disparo/outreach anterior, entre os place_ids retornados pela busca, e únicos
// por Google Place ID. Um lead reencontrado mas já processado NÃO aparece.
export function leadsDaBusca(leads: Lead[], placeIdsBusca: Iterable<string>): Lead[] {
  const ids = placeIdsBusca instanceof Set ? placeIdsBusca : new Set(placeIdsBusca)
  const vistos = new Set<string>()
  return leads.filter((l) => {
    if (!leadDisponivelParaProspeccao(l)) return false
    if (!l.google_place_id || !ids.has(l.google_place_id)) return false
    if (vistos.has(l.google_place_id)) return false
    vistos.add(l.google_place_id)
    return true
  })
}

// Leads inbound do Squad Leads são base de aprendizado: ajudam a entender bons
// sinais de clientes reais, mas não entram no lote de prospecção/mensagem.
export function leadsInboundParaAprendizado(leads: Lead[]): Lead[] {
  return leads
    .filter((l) => l.origem === 'squad_leads_form')
    .sort((a, b) => {
      const at = Date.parse(a.inbound_created_at ?? a.created_at)
      const bt = Date.parse(b.inbound_created_at ?? b.created_at)
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at)
    })
}

// Selecionados que REALMENTE estão na lista visível. A seleção é um Set que pode
// reter ids de buscas anteriores; o botão "Processar N" tem que contar e processar
// só estes — o número mostrado = o número processado (nem mais, nem menos).
export function selecionadosVisiveis(visiveis: Lead[], selecionados: ReadonlySet<string>): Lead[] {
  return visiveis.filter((l) => selecionados.has(l.id))
}

// --- Gate de WhatsApp (sem número confirmado, o lead não aparece p/ disparo) ---

/** Lead mensageável: número da loja achado OU nº manual da dona(o). */
export function temWhatsapp(lead: Lead): boolean {
  if (lead.whatsapp_dono?.trim()) return true
  return lead.whatsapp_status === 'found' && !!lead.whatsapp_phone
}

/** Verificação de WhatsApp ainda não rodou (nem achou nem descartou). */
export function aguardandoWhatsapp(lead: Lead): boolean {
  if (temWhatsapp(lead)) return false
  return lead.whatsapp_status == null || lead.whatsapp_status === 'pending'
}

// --- Filtros da seleção (seguidores, nota, avaliações, Instagram) -------------

export interface FiltrosSelecao {
  minSeguidores: number | null
  minRating: number | null
  minReviews: number | null
  comInstagram: boolean
  origem: LeadOrigem | ''
  inboundClassifications: InboundClassification[]
}

export const FILTROS_VAZIOS: FiltrosSelecao = {
  minSeguidores: null,
  minRating: null,
  minReviews: null,
  comInstagram: false,
  origem: '',
  inboundClassifications: [],
}

/**
 * Aplica os filtros da seleção. Anti-invenção nos mínimos numéricos: dado
 * ausente (null) NÃO passa num filtro de mínimo — não dá pra afirmar que um
 * lead sem contagem de seguidores tem "1000+".
 */
export function filtrarLeads(leads: Lead[], f: FiltrosSelecao): Lead[] {
  return leads.filter((l) => {
    if (f.comInstagram && !l.instagram_handle) return false
    if (f.minSeguidores != null && (l.instagram_followers ?? -1) < f.minSeguidores) return false
    if (f.minRating != null && (l.rating ?? -1) < f.minRating) return false
    if (f.minReviews != null && (l.reviews_count ?? -1) < f.minReviews) return false
    if (f.origem && l.origem !== f.origem) return false
    if (
      f.inboundClassifications.length > 0 &&
      (!l.inbound_classification || !f.inboundClassifications.includes(l.inbound_classification))
    ) {
      return false
    }
    return true
  })
}
