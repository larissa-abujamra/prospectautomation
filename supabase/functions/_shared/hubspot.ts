// Mapeamento puro Lead → Contato do HubSpot (módulo WhatsApp, Parte B).
// =============================================================================
// Sem I/O — só transformação. Unit-testado no Vitest e usado pela Edge Function
// `hubspot-sync` (Deno). Princípio anti-invenção: campo nulo é OMITIDO (não vira
// string vazia que sobrescreveria um dado real no HubSpot).
// =============================================================================

// Propriedade CUSTOM única usada como chave de dedup no upsert (idProperty).
// Leads não têm e-mail; o google_place_id é a identidade estável do negócio.
export const HUBSPOT_DEDUP_PROPERTY = 'google_place_id'

// Propriedade CUSTOM que dispara o WhatsApp (Parte C). O workflow do HubSpot
// enrola o contato quando whatsapp_outreach = 'ready' e dispara o template.
export const HUBSPOT_OUTREACH_PROPERTY = 'whatsapp_outreach'

// Propriedade CUSTOM com o gênero do nome ('f'|'m'). O workflow ramifica nela
// (If/then) para escolher o template certo: f → ..._f, m → ..._m (artigo o/a).
export const HUBSPOT_GENERO_PROPERTY = 'nome_genero'

// Subset do Lead que o mapeamento precisa (evita acoplar ao tipo inteiro do app
// no runtime Deno; o teste passa um Lead completo, compatível com isto).
export interface SyncableLead {
  nome: string
  cidade: string | null
  website: string | null
  dono_nome: string | null
  instagram_handle: string | null
  google_place_id: string | null
  whatsapp_phone: string | null
  whatsapp_status: string | null
  nome_genero: string | null
}

export type ContactProperties = Record<string, string>

// Só sincroniza quem tem número WhatsApp achado E place_id (chave de dedup).
// Sem isso, ou poluiria o CRM com contato não-mensageável, ou duplicaria.
export function canSyncToHubspot(lead: SyncableLead): boolean {
  return (
    lead.whatsapp_status === 'found' &&
    !!lead.whatsapp_phone &&
    !!lead.google_place_id
  )
}

// Adiciona a chave só se o valor for não-vazio (anti-invenção).
function put(target: ContactProperties, key: string, value: string | null | undefined) {
  if (value != null && String(value).trim() !== '') target[key] = String(value)
}

/**
 * Converte um lead nas propriedades de Contato do HubSpot. Usa só propriedades
 * padrão (phone, company, firstname, city, website, lifecyclestage) + a custom
 * única `google_place_id` e `instagram_handle`. Campos nulos são omitidos.
 */
export function leadToContactProperties(lead: SyncableLead): ContactProperties {
  const props: ContactProperties = {}
  // Chave de dedup — sempre presente para um lead sincronizável.
  put(props, HUBSPOT_DEDUP_PROPERTY, lead.google_place_id)
  put(props, 'phone', lead.whatsapp_phone)
  put(props, 'company', lead.nome)
  put(props, 'firstname', lead.dono_nome) // dono real; omitido se desconhecido
  put(props, 'city', lead.cidade)
  put(props, 'website', lead.website)
  put(props, 'instagram_handle', lead.instagram_handle)
  put(props, HUBSPOT_GENERO_PROPERTY, lead.nome_genero) // 'f'|'m' p/ o workflow ramificar
  props.lifecyclestage = 'lead'
  return props
}

/**
 * Mesmas propriedades do contato + o gatilho de WhatsApp (Parte C). Quando
 * `trigger` é true, marca whatsapp_outreach='ready' — é só isso que o workflow
 * do HubSpot precisa para enrolar e disparar o template aprovado. Idempotente.
 */
export function leadToContactPropertiesWithTrigger(
  lead: SyncableLead,
  trigger: boolean,
): ContactProperties {
  const props = leadToContactProperties(lead)
  if (trigger) props[HUBSPOT_OUTREACH_PROPERTY] = 'ready'
  return props
}
