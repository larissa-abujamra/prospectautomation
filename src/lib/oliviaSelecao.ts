import type { InboundClassification, Lead, LeadOrigem } from './types'

// Seleção do wizard da Olivia (passo 2). Garante que o que aparece e o que é
// processado é EXATAMENTE a busca atual — nem todos os 'descoberto' do banco,
// nem leads já processados que voltaram numa re-busca.

// Leads desta busca que estão prontos pra processar: status 'descoberto' E entre
// os place_ids retornados pela busca. Um lead reencontrado mas já qualificado/
// processado NÃO aparece (não se re-processa quem já entrou no funil).
export function leadsDaBusca(leads: Lead[], placeIdsBusca: Iterable<string>): Lead[] {
  const ids = placeIdsBusca instanceof Set ? placeIdsBusca : new Set(placeIdsBusca)
  return leads.filter(
    (l) => l.status === 'descoberto' && !!l.google_place_id && ids.has(l.google_place_id),
  )
}

// Leads inbound importados pelo Squad Leads não têm google_place_id. Eles entram
// na Olivia por uma fonte explícita, também só quando ainda estão frescos.
export function leadsInboundDisponiveis(leads: Lead[]): Lead[] {
  return leads.filter((l) => l.status === 'descoberto' && l.origem === 'squad_leads_form')
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
