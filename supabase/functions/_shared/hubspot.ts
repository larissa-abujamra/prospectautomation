// Mapeamento puro Lead → Contato do HubSpot (módulo WhatsApp, Parte B).
// =============================================================================
// Sem I/O — só transformação. Unit-testado no Vitest e usado pela Edge Function
// `hubspot-sync` (Deno). Princípio anti-invenção: campo nulo é OMITIDO (não vira
// string vazia que sobrescreveria um dado real no HubSpot).
// =============================================================================

import { grupoForSetor } from './whatsapp_send.ts'

// Propriedade CUSTOM única usada como chave de dedup no upsert (idProperty).
// Leads não têm e-mail. Só Google Places entra no fluxo de prospecção; Squad
// Leads é base de aprendizado de clientes reais/ativos e não deve disparar CRM.
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
export const HUBSPOT_STAGE_LOCALIZAR_RESPONSAVEL = '1363467869'
export const HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO = '1379606668'
export const HUBSPOT_STAGE_REUNIAO_PROPOSTA = '1379606669'
export const HUBSPOT_STAGE_REUNIAO_AGENDADA = '1379617163'
export const HUBSPOT_STAGE_CLOSED_WON = '1363467872'
export const HUBSPOT_STAGE_CLOSED_LOST = '1363467873'
const HUBSPOT_BASE = 'https://api.hubapi.com'
const HUBSPOT_TIMEOUT_MS = 12_000
// Associação padrão Contato → Negócio (HUBSPOT_DEFINED, typeId 4).
const CONTACT_TO_DEAL_TYPE_ID = 4

export const HUBSPOT_DEAL_STAGE_IDS = {
  prospects: HUBSPOT_STAGE_PROSPECTS,
  tentativa_contato: HUBSPOT_STAGE_TENTATIVA_CONTATO,
  localizar_responsavel: HUBSPOT_STAGE_LOCALIZAR_RESPONSAVEL,
  respondido_conversando: HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO,
  reuniao_proposta: HUBSPOT_STAGE_REUNIAO_PROPOSTA,
  reuniao_agendada: HUBSPOT_STAGE_REUNIAO_AGENDADA,
  closed_won: HUBSPOT_STAGE_CLOSED_WON,
  closed_lost: HUBSPOT_STAGE_CLOSED_LOST,
} as const

export type HubspotDealStageKey = keyof typeof HUBSPOT_DEAL_STAGE_IDS

export interface HubspotDealStagePatchBody {
  properties: {
    dealstage: string
  }
}

export function hubspotDealStageId(stage: HubspotDealStageKey): string {
  return HUBSPOT_DEAL_STAGE_IDS[stage]
}

export function buildDealStagePatchBody(stageId: string): HubspotDealStagePatchBody {
  return { properties: { dealstage: stageId } }
}

const HUBSPOT_DEAL_STAGE_TIMEOUT_MS = 8_000

const HUBSPOT_DEAL_STAGE_RANK: Record<string, number> = {
  [HUBSPOT_STAGE_PROSPECTS]: 0,
  [HUBSPOT_STAGE_TENTATIVA_CONTATO]: 1,
  [HUBSPOT_STAGE_LOCALIZAR_RESPONSAVEL]: 2,
  [HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO]: 3,
  [HUBSPOT_STAGE_REUNIAO_PROPOSTA]: 4,
  [HUBSPOT_STAGE_REUNIAO_AGENDADA]: 5,
  [HUBSPOT_STAGE_CLOSED_WON]: 6,
  [HUBSPOT_STAGE_CLOSED_LOST]: 6,
}

export function shouldSyncDealStage(
  currentStageId: string | null | undefined,
  targetStageId: string,
): boolean {
  if (!currentStageId) return true
  const currentRank = HUBSPOT_DEAL_STAGE_RANK[currentStageId]
  const targetRank = HUBSPOT_DEAL_STAGE_RANK[targetStageId]
  if (currentRank == null || targetRank == null) return true
  return targetRank >= currentRank
}

interface HubspotDealStageHistoryValue {
  value?: string | null
}

interface HubspotDealStageSnapshot {
  properties?: { dealstage?: string | null }
  propertiesWithHistory?: { dealstage?: HubspotDealStageHistoryValue[] }
}

export function highestKnownDealStage(stageIds: Array<string | null | undefined>): string | null {
  let highestStageId: string | null = null
  let highestRank = -1
  for (const stageId of stageIds) {
    if (!stageId) continue
    const rank = HUBSPOT_DEAL_STAGE_RANK[stageId]
    if (rank == null) continue
    if (rank > highestRank) {
      highestRank = rank
      highestStageId = stageId
    }
  }
  return highestStageId
}

export function shouldRestoreDealStage(
  currentStageId: string | null | undefined,
  desiredStageId: string | null | undefined,
): boolean {
  if (!currentStageId || !desiredStageId) return false
  const currentRank = HUBSPOT_DEAL_STAGE_RANK[currentStageId]
  const desiredRank = HUBSPOT_DEAL_STAGE_RANK[desiredStageId]
  if (currentRank == null || desiredRank == null) return false
  return currentRank < desiredRank
}

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

export interface ResponsibleContactLeadContext {
  nome: string
  setor?: string | null
  cidade?: string | null
  nome_genero?: string | null
  hubspot_contact_id?: string | null
  hubspot_deal_id?: string | null
}

export interface ResponsibleContactInput {
  numero: string
  nome: string | null | undefined
  lead: ResponsibleContactLeadContext
}

export interface HubspotContactSearchBody {
  filterGroups: Array<{
    filters: Array<{
      propertyName: string
      operator: 'EQ'
      value: string
    }>
  }>
  properties: string[]
  limit: number
}

export interface HubspotAssociationSpec {
  associationCategory: 'HUBSPOT_DEFINED'
  associationTypeId: number
}

export interface EnsureResponsibleContactResult {
  contactId: string
  created: boolean
  workflowQueued: boolean
  associatedToDeal: boolean
}

export interface HubspotContactSearchResult {
  id?: string | number | null
  properties?: Record<string, string | null | undefined>
}

interface HubspotSearchResponse {
  results?: HubspotContactSearchResult[]
}

// Nº pessoal da dona(o) preenchido manualmente conta como número válido só
// quando não-vazio (anti-invenção: string em branco não destrava nada).
function temWhatsappDono(lead: SyncableLead): boolean {
  return lead.whatsapp_dono != null && lead.whatsapp_dono.trim() !== ''
}

export function hubspotDedupValue(
  lead: Pick<SyncableLead, 'google_place_id' | 'squad_leads_id'>,
): string | null {
  if (lead.google_place_id) return lead.google_place_id
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

function generoForHubspotWorkflow(genero: string | null | undefined): 'f' | 'm' {
  return genero === 'm' ? 'm' : 'f'
}

/**
 * Propriedades do contato responsável indicado na conversa com a Olivia.
 * Não usa `google_place_id`: esse id pertence ao contato original do negócio.
 */
export function responsibleContactProperties(input: ResponsibleContactInput): ContactProperties {
  const props: ContactProperties = {}
  put(props, 'firstname', input.nome)
  put(props, 'phone', input.numero)
  put(props, 'mobilephone', input.numero)
  put(props, HUBSPOT_WHATSAPP_PHONE_PROPERTY, input.numero)
  put(props, 'company', input.lead.nome)
  put(props, 'city', input.lead.cidade)
  put(props, HUBSPOT_GENERO_PROPERTY, generoForHubspotWorkflow(input.lead.nome_genero))
  put(props, HUBSPOT_SETOR_PROPERTY, input.lead.setor)
  props[HUBSPOT_SETOR_GRUPO_PROPERTY] = grupoForSetor(input.lead.setor)
  props[HUBSPOT_OUTREACH_PROPERTY] = HUBSPOT_OUTREACH_READY
  props.lifecyclestage = 'lead'
  return props
}

export function responsibleContactPatchProperties(input: ResponsibleContactInput): ContactProperties {
  const props: ContactProperties = {}
  put(props, 'phone', input.numero)
  put(props, 'mobilephone', input.numero)
  put(props, HUBSPOT_WHATSAPP_PHONE_PROPERTY, input.numero)
  put(props, HUBSPOT_GENERO_PROPERTY, generoForHubspotWorkflow(input.lead.nome_genero))
  put(props, HUBSPOT_SETOR_PROPERTY, input.lead.setor)
  props[HUBSPOT_SETOR_GRUPO_PROPERTY] = grupoForSetor(input.lead.setor)
  props[HUBSPOT_OUTREACH_PROPERTY] = HUBSPOT_OUTREACH_READY
  return props
}

export function buildResponsibleContactSearchBody(numero: string): HubspotContactSearchBody {
  const searchablePhoneProperties = [HUBSPOT_WHATSAPP_PHONE_PROPERTY, 'phone', 'mobilephone']
  return {
    filterGroups: searchablePhoneProperties.map((propertyName) => ({
      filters: [{ propertyName, operator: 'EQ', value: numero }],
    })),
    properties: [
      'firstname',
      'phone',
      'mobilephone',
      HUBSPOT_WHATSAPP_PHONE_PROPERTY,
      HUBSPOT_OUTREACH_PROPERTY,
      HUBSPOT_DEDUP_PROPERTY,
    ],
    limit: 10,
  }
}

export function buildResponsibleContactWriteBody(input: ResponsibleContactInput): {
  properties: ContactProperties
} {
  return { properties: responsibleContactProperties(input) }
}

export function buildResponsibleContactPatchBody(input: ResponsibleContactInput): {
  properties: ContactProperties
} {
  return { properties: responsibleContactPatchProperties(input) }
}

export function buildContactToDealAssociationBody(): HubspotAssociationSpec[] {
  return [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: CONTACT_TO_DEAL_TYPE_ID }]
}

export function reusableResponsibleContactId(
  results: HubspotContactSearchResult[],
  excludedContactId: string | null | undefined,
): string | null {
  const excluded = excludedContactId?.trim()
  for (const result of results) {
    if (result.id == null) continue
    const id = String(result.id)
    if (excluded && id === excluded) continue
    if (result.properties?.[HUBSPOT_DEDUP_PROPERTY]?.trim()) continue
    return id
  }
  return null
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

// Só vira card no pipeline de prospecção quem tem identidade estável de Google
// Places e nome. CNPJ/dono NÃO são exigidos — prospects entram crus e são
// enriquecidos depois. Squad Leads fica fora: é referência de aprendizado.
export function canExportDeal(
  lead: { nome: string; google_place_id: string | null; squad_leads_id?: number | null },
): boolean {
  return !!lead.nome && !!lead.google_place_id
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

function hubspotPrivateAppToken(): string | null {
  const deno = (globalThis as {
    Deno?: { env?: { get: (name: string) => string | undefined } }
  }).Deno
  return deno?.env?.get('HUBSPOT_PRIVATE_APP_TOKEN') ?? null
}

async function hubspotJsonFetch(
  token: string,
  path: string,
  init: Omit<RequestInit, 'headers' | 'body'> & { body?: unknown },
  context: string,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS)
  try {
    const resp = await fetch(`${HUBSPOT_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body == null ? {} : { body: JSON.stringify(init.body) }),
    })
    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      throw new Error(data?.message ?? `${context} falhou (HTTP ${resp.status})`)
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

export async function findResponsibleHubspotContactByPhone(
  token: string,
  numero: string,
  context = 'hubspot-responsible-contact',
  excludedContactId?: string | null,
): Promise<string | null> {
  const data = await hubspotJsonFetch(
    token,
    '/crm/v3/objects/contacts/search',
    { method: 'POST', body: buildResponsibleContactSearchBody(numero) },
    `${context}:search`,
  ) as HubspotSearchResponse
  return reusableResponsibleContactId(data.results ?? [], excludedContactId)
}

async function createResponsibleHubspotContact(
  token: string,
  input: ResponsibleContactInput,
  context: string,
): Promise<string> {
  const data = await hubspotJsonFetch(
    token,
    '/crm/v3/objects/contacts',
    { method: 'POST', body: buildResponsibleContactWriteBody(input) },
    `${context}:create`,
  ) as { id?: string | number | null }
  if (data.id == null) throw new Error(`${context}: HubSpot não retornou id do contato responsável.`)
  return String(data.id)
}

async function patchResponsibleHubspotContact(
  token: string,
  contactId: string,
  input: ResponsibleContactInput,
  context: string,
): Promise<void> {
  await hubspotJsonFetch(
    token,
    `/crm/v3/objects/contacts/${contactId}`,
    { method: 'PATCH', body: buildResponsibleContactPatchBody(input) },
    `${context}:patch`,
  )
}

export async function associateResponsibleContactToDeal(
  token: string,
  contactId: string,
  dealId: string | null | undefined,
  context = 'hubspot-responsible-contact',
): Promise<boolean> {
  const cleanDealId = dealId?.trim()
  if (!cleanDealId) return false
  try {
    await hubspotJsonFetch(
      token,
      `/crm/v4/objects/contacts/${contactId}/associations/deals/${cleanDealId}`,
      { method: 'PUT', body: buildContactToDealAssociationBody() },
      `${context}:associate-deal`,
    )
    return true
  } catch (e) {
    console.error(`${context}: associação contato responsável→deal falhou`, e instanceof Error ? e.message : e)
    return false
  }
}

export async function ensureResponsibleHubspotContact(
  token: string,
  input: ResponsibleContactInput,
  context = 'hubspot-responsible-contact',
): Promise<EnsureResponsibleContactResult> {
  const existingId = await findResponsibleHubspotContactByPhone(
    token,
    input.numero,
    context,
    input.lead.hubspot_contact_id,
  )
  const contactId = existingId ?? (await createResponsibleHubspotContact(token, input, context))
  if (existingId) await patchResponsibleHubspotContact(token, contactId, input, context)
  const associatedToDeal = await associateResponsibleContactToDeal(token, contactId, input.lead.hubspot_deal_id, context)
  return {
    contactId,
    created: !existingId,
    workflowQueued: true,
    associatedToDeal,
  }
}

async function fetchDealStageSnapshot(
  dealId: string,
  token: string,
  signal: AbortSignal,
  context: string,
): Promise<{ currentStageId: string | null; highestStageId: string | null } | null> {
  const resp = await fetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealstage&propertiesWithHistory=dealstage`,
    {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!resp.ok) {
    console.error(`${context}: HubSpot dealstage GET falhou`, resp.status)
    return null
  }
  const snapshot = (await resp.json().catch(() => null)) as HubspotDealStageSnapshot | null
  const currentStageId = snapshot?.properties?.dealstage ?? null
  const historyStageIds = snapshot?.propertiesWithHistory?.dealstage?.map((entry) => entry.value) ?? []
  return {
    currentStageId,
    highestStageId: highestKnownDealStage([currentStageId, ...historyStageIds]),
  }
}

async function patchDealStage(
  dealId: string,
  stageId: string,
  token: string,
  signal: AbortSignal,
  context: string,
): Promise<boolean> {
  const resp = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    method: 'PATCH',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildDealStagePatchBody(stageId)),
  })
  if (!resp.ok) {
    console.error(`${context}: HubSpot dealstage PATCH falhou`, resp.status)
    return false
  }
  return true
}

// Atualiza o card do negócio no board. É deliberadamente best-effort: a conversa
// com o lead e o agendamento nunca podem falhar só porque o CRM recusou um PATCH.
export async function syncHubspotDealStage(
  dealId: string | null | undefined,
  stageId: string,
  context = 'hubspot-stage-sync',
): Promise<boolean> {
  const id = dealId?.trim()
  if (!id) return false

  const token = hubspotPrivateAppToken()
  if (!token) return false

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_DEAL_STAGE_TIMEOUT_MS)
  try {
    const before = await fetchDealStageSnapshot(id, token, controller.signal, context)
    if (!before) return false
    if (!shouldSyncDealStage(before.highestStageId ?? before.currentStageId, stageId)) {
      return false
    }

    const patched = await patchDealStage(id, stageId, token, controller.signal, context)
    if (!patched) return false

    const after = await fetchDealStageSnapshot(id, token, controller.signal, context)
    const desiredStageId = highestKnownDealStage([stageId, after?.highestStageId])
    if (desiredStageId && shouldRestoreDealStage(after?.currentStageId, desiredStageId)) {
      await patchDealStage(id, desiredStageId, token, controller.signal, `${context}:restore`)
    }
    return true
  } catch (e) {
    console.error(`${context}: HubSpot dealstage PATCH erro`, e instanceof Error ? e.message : e)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export function queueHubspotDealStageSync(
  dealId: string | null | undefined,
  stageId: string,
  context = 'hubspot-stage-sync',
  delayMs = 0,
): void {
  const promise = (async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return syncHubspotDealStage(dealId, stageId, context)
  })()
  try {
    ;(globalThis as { EdgeRuntime?: { waitUntil?: (pr: Promise<unknown>) => void } }).EdgeRuntime
      ?.waitUntil?.(promise)
  } catch {
    /* ambiente sem EdgeRuntime — a promise já captura/loga internamente */
  }
}
