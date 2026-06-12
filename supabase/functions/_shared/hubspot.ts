// Mapeamento puro Lead → Contato do HubSpot (módulo WhatsApp, Parte B).
// =============================================================================
// Sem I/O — só transformação. Unit-testado no Vitest e usado pela Edge Function
// `hubspot-sync` (Deno). Princípio anti-invenção: campo nulo é OMITIDO (não vira
// string vazia que sobrescreveria um dado real no HubSpot).
// =============================================================================

import { grupoForSetor } from './whatsapp_send.ts'

// Propriedade CUSTOM única usada como chave de dedup no upsert (idProperty).
// Leads não têm e-mail. Google usa o Place ID cru; Squad Leads usa chave
// prefixada para não misturar fontes nem preencher public.leads.google_place_id.
export const HUBSPOT_DEDUP_PROPERTY = 'google_place_id'

// Propriedade CUSTOM que enfileira o WhatsApp no HubSpot (Parte C). O workflow
// existente do HubSpot enrola o contato quando whatsapp_outreach = 'ready' e
// dispara o template. Este é o caminho ativo de go-live; Meta fica só para
// criação/aprovação de templates.
export const HUBSPOT_OUTREACH_PROPERTY = 'whatsapp_outreach'
export const HUBSPOT_OUTREACH_READY = 'ready'

// Propriedade CUSTOM com o gênero do nome ('f'|'m'). O workflow ramifica nela
// (If/then) para escolher o template certo: f → ..._f, m → ..._m (artigo o/a).
export const HUBSPOT_GENERO_PROPERTY = 'nome_genero'

// Propriedade PADRÃO do HubSpot que a integração WhatsApp usa para enviar e que
// dispara o fluxo "Whatsapp Consent" (opt-in automático). O `phone` padrão NÃO
// basta: um contato recém-criado só com `phone` fica sem consentimento e o envio
// nativo não tem destinatário. Por isso preenchemos os dois.
export const HUBSPOT_WHATSAPP_PHONE_PROPERTY = 'hs_whatsapp_phone_number'

// Pipeline de negócios "Squad Prospects" e seus estágios (ids reais do portal
// 50173893). O "Importar pra HubSpot" cria o negócio em PROSPECTS; quando o
// WhatsApp é enviado, o workflow move pra TENTATIVA DE CONTATO.
export const HUBSPOT_DEALS_PIPELINE = '901116980'
export const HUBSPOT_STAGE_PROSPECTS = '1363467867'
export const HUBSPOT_STAGE_TENTATIVA_CONTATO = '1363467868'

// Propriedade CUSTOM com o grupo de template por perfil ('doces'|'generic').
// Workflows de disparo por segmento ramificam nela (template por perfil — plano
// Olivia Autônoma, Parte 1). A propriedade precisa existir no portal antes do
// primeiro sync que a inclua.
export const HUBSPOT_SETOR_GRUPO_PROPERTY = 'setor_grupo'

// Propriedade CUSTOM com o SETOR cru (Confeitaria, Pizzaria, Academia…). Coluna no
// HubSpot para o time filtrar/segmentar; o setor_grupo (doces/generic) é derivado.
export const HUBSPOT_SETOR_PROPERTY = 'setor'

// Subset do Lead que o mapeamento precisa (evita acoplar ao tipo inteiro do app
// no runtime Deno; o teste passa um Lead completo, compatível com isto).
export interface SyncableLead {
  nome: string
  setor?: string | null
  cidade: string | null
  website: string | null
  dono_nome: string | null
  instagram_handle: string | null
  google_place_id: string | null
  squad_leads_id?: number | null
  whatsapp_phone: string | null
  whatsapp_status: string | null
  nome_genero: string | null
  // WhatsApp PESSOAL da dona(o), preenchido MANUALMENTE pelo time (resposta,
  // visita ou cliente oculto). Opcional: a Edge Function pode receber leads
  // antigos sem a coluna. Quando presente, tem preferência no disparo.
  whatsapp_dono?: string | null
}

export type ContactProperties = Record<string, string>

// Nº pessoal da dona(o) preenchido manualmente conta como número válido só
// quando não-vazio (anti-invenção: string em branco não destrava nada).
function temWhatsappDono(lead: SyncableLead): boolean {
  return lead.whatsapp_dono != null && lead.whatsapp_dono.trim() !== ''
}

export function hubspotDedupValue(
  lead: Pick<SyncableLead, 'google_place_id' | 'squad_leads_id'>,
): string | null {
  if (lead.google_place_id) return lead.google_place_id
  if (lead.squad_leads_id != null) return `squad_leads:${lead.squad_leads_id}`
  return null
}

// Só sincroniza quem é mensageável E tem chave de dedup. Mensageável =
// número da loja achado OU nº manual da dona(o) — o whatsapp_dono sozinho basta,
// senão exatamente o lead que o plano manda preferir no disparo ficaria travado.
export function canSyncToHubspot(lead: SyncableLead): boolean {
  if (!hubspotDedupValue(lead)) return false
  const temNumeroLoja = lead.whatsapp_status === 'found' && !!lead.whatsapp_phone
  return temNumeroLoja || temWhatsappDono(lead)
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
  put(props, HUBSPOT_DEDUP_PROPERTY, hubspotDedupValue(lead))
  // Número de envio: `whatsapp_dono` (nº PESSOAL da dona/o, preenchido
  // MANUALMENTE pelo time) tem PREFERÊNCIA sobre o nº da loja quando não-vazio.
  // Decisão registrada no plano de 10/06: nada de data broker (risco LGPD em
  // cold outreach) — só usamos nº pessoal obtido por resposta/visita/c. oculto.
  const numeroEnvio = temWhatsappDono(lead) ? lead.whatsapp_dono : lead.whatsapp_phone
  put(props, 'phone', numeroEnvio)
  // Número que o WhatsApp do HubSpot realmente usa para enviar + dispara o opt-in
  // automático (fluxo "Whatsapp Consent"). Sem isto o envio nativo não funciona.
  put(props, HUBSPOT_WHATSAPP_PHONE_PROPERTY, numeroEnvio)
  put(props, 'company', lead.nome)
  put(props, 'firstname', lead.dono_nome) // dono real; omitido se desconhecido
  put(props, 'city', lead.cidade)
  put(props, 'website', lead.website)
  put(props, 'instagram_handle', lead.instagram_handle)
  put(props, HUBSPOT_GENERO_PROPERTY, lead.nome_genero) // 'f'|'m' p/ o workflow ramificar
  // Setor cru (Confeitaria, Pizzaria…) — coluna no HubSpot p/ o time filtrar/segmentar.
  put(props, HUBSPOT_SETOR_PROPERTY, lead.setor)
  // Grupo de template por perfil (doces/generic), derivado do setor — o workflow
  // por segmento ramifica aqui. Sem setor → 'generic' (grupoForSetor cuida disso).
  put(props, HUBSPOT_SETOR_GRUPO_PROPERTY, grupoForSetor(lead.setor))
  props.lifecyclestage = 'lead'
  return props
}

/**
 * Mesmas propriedades do contato + o gatilho de WhatsApp (Parte C). Quando
 * `trigger` é true, marca whatsapp_outreach='ready'. Isso só enfileira o contato
 * para o workflow do HubSpot; o envio real acontece dentro do HubSpot. Idempotente.
 */
export function leadToContactPropertiesWithTrigger(
  lead: SyncableLead,
  trigger: boolean,
): ContactProperties {
  const props = leadToContactProperties(lead)
  if (trigger) props[HUBSPOT_OUTREACH_PROPERTY] = HUBSPOT_OUTREACH_READY
  return props
}

// Só vira card no pipeline de prospecção quem tem identidade estável da fonte
// e nome. CNPJ/dono NÃO são exigidos — prospects entram crus e são enriquecidos
// depois. (Régua mais frouxa que canSyncToHubspot, que é p/ o CRM completo.)
export function canExportDeal(
  lead: { nome: string; google_place_id: string | null; squad_leads_id?: number | null },
): boolean {
  return !!lead.nome && !!hubspotDedupValue(lead)
}

// Propriedades do NEGÓCIO (deal) no pipeline Squad Prospects, estágio Prospects.
// dealname = nome do negócio (espelha o card do board). Valor fica zerado.
export function leadToDealProperties(lead: { nome: string }): ContactProperties {
  return {
    dealname: lead.nome,
    pipeline: HUBSPOT_DEALS_PIPELINE,
    dealstage: HUBSPOT_STAGE_PROSPECTS,
  }
}
