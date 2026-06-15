import type { BuscarParams } from './leads'
import { canTriggerWhatsappWorkflow, preferredWhatsappNumber } from './communicationStatus'
import { jaTeveDisparo } from './oliviaSelecao'
import { toE164Br } from './phoneBr'
import type { Lead } from './types'

export interface DirectCompanyInput {
  raw: string
  company: string
  context: string | null
}

export type DirectMatchConfidence = 'alta' | 'media' | 'baixa'

export interface DirectLeadSelection {
  lead: Lead
  score: number
  confidence: DirectMatchConfidence
  reason: string
}

const SEARCH_WITHOUT_CONTEXT = 'Brasil'

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function parseDirectCompanyInput(input: string): DirectCompanyInput | null {
  const raw = cleanText(input)
  if (!raw) return null

  const commaParts = raw.split(',').map(cleanText).filter(Boolean)
  if (commaParts.length >= 2) {
    return {
      raw,
      company: commaParts[0],
      context: commaParts.slice(1).join(', '),
    }
  }

  const dashParts = raw.split(/\s+[–-]\s+/).map(cleanText).filter(Boolean)
  if (dashParts.length >= 2) {
    return {
      raw,
      company: dashParts[0],
      context: dashParts.slice(1).join(' - '),
    }
  }

  return { raw, company: raw, context: null }
}

export function buildDirectCompanySearchParams(input: DirectCompanyInput): BuscarParams {
  return {
    setor: input.company,
    local: input.context ?? SEARCH_WITHOUT_CONTEXT,
    max: 5,
    comSeguidores: false,
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(' ').filter((token) => token.length >= 3))
}

export function scoreDirectCompanyMatch(company: string, lead: Pick<Lead, 'nome'>): number {
  const wanted = normalize(company)
  const found = normalize(lead.nome)
  if (!wanted || !found) return 0
  if (wanted === found) return 100
  if (found.includes(wanted) || wanted.includes(found)) return 86

  const wantedTokens = tokens(wanted)
  const foundTokens = tokens(found)
  if (wantedTokens.size === 0 || foundTokens.size === 0) return 0

  let overlap = 0
  for (const token of wantedTokens) {
    if (foundTokens.has(token)) overlap++
  }
  const ratio = overlap / wantedTokens.size
  return Math.round(ratio * 78)
}

function confidenceForScore(score: number): DirectMatchConfidence {
  if (score >= 80) return 'alta'
  if (score >= 45) return 'media'
  return 'baixa'
}

function reasonForConfidence(confidence: DirectMatchConfidence): string {
  switch (confidence) {
    case 'alta':
      return 'Nome retornado pelo Google bate bem com a busca.'
    case 'media':
      return 'Há semelhança parcial no nome; confira a empresa antes de enviar.'
    case 'baixa':
      return 'Resultado pouco parecido com a busca; confirme manualmente antes de seguir.'
  }
}

export function selectBestDirectLead(
  leads: Lead[],
  placeIds: Iterable<string>,
  company: string,
): DirectLeadSelection | null {
  const order = new Map(Array.from(placeIds).map((id, index) => [id, index]))
  const candidates = leads.filter((lead) => lead.google_place_id && order.has(lead.google_place_id))
  if (candidates.length === 0) return null

  const ranked = candidates
    .map((lead) => ({ lead, score: scoreDirectCompanyMatch(company, lead) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (order.get(a.lead.google_place_id ?? '') ?? 999) -
        (order.get(b.lead.google_place_id ?? '') ?? 999)
    })

  const best = ranked[0]
  const confidence = confidenceForScore(best.score)
  return {
    lead: best.lead,
    score: best.score,
    confidence,
    reason: reasonForConfidence(confidence),
  }
}

export function hasValidBrWhatsappForDirectOutreach(
  lead: Pick<
    Lead,
    | 'origem'
    | 'google_place_id'
    | 'whatsapp_phone'
    | 'whatsapp_dono'
    | 'whatsapp_status'
    | 'whatsapp_sent_at'
    | 'whatsapp_send_status'
  >,
): boolean {
  if (!canTriggerWhatsappWorkflow(lead)) return false
  if (jaTeveDisparo(lead)) return false
  if (lead.whatsapp_send_status === 'invalid') return false
  const phone = preferredWhatsappNumber(lead)
  return !!phone && toE164Br(phone) != null
}

export function directOutreachWarnings(
  lead: Pick<
    Lead,
    | 'hubspot_contact_id'
    | 'hubspot_deal_id'
    | 'whatsapp_phone'
    | 'whatsapp_dono'
    | 'whatsapp_status'
    | 'whatsapp_sent_at'
    | 'whatsapp_send_status'
    | 'origem'
    | 'google_place_id'
  >,
  confidence: DirectMatchConfidence,
): string[] {
  const warnings: string[] = []
  const phone = preferredWhatsappNumber(lead)

  if (confidence === 'baixa') {
    warnings.push('Confiança baixa: confira se este é mesmo o negócio antes de enviar.')
  }
  if (!phone) {
    warnings.push('Sem WhatsApp pronto: encontre ou informe um número válido antes do disparo.')
  } else if (toE164Br(phone) == null) {
    warnings.push('WhatsApp inválido para BR: corrija o número antes do disparo.')
  }
  if (!canTriggerWhatsappWorkflow(lead)) {
    warnings.push('Ainda faltam dados mínimos para acionar o workflow do HubSpot.')
  }
  if (jaTeveDisparo(lead)) {
    warnings.push('Este lead já teve disparo/workflow acionado; o envio direto fica bloqueado para evitar duplicidade.')
  }
  if (lead.whatsapp_send_status === 'failed') {
    warnings.push('Há uma falha anterior de envio; se for limite/template/cap do HubSpot ou Meta, tente novamente só depois de revisar.')
  }
  if (lead.whatsapp_send_status === 'invalid') {
    warnings.push('Envio anterior marcou número inválido; corrija o WhatsApp antes de reenviar.')
  }
  if (lead.hubspot_contact_id || lead.hubspot_deal_id) {
    warnings.push('Contato/negócio já existe no HubSpot; a confirmação atualiza o registro e só então aciona o workflow.')
  }

  return warnings
}
