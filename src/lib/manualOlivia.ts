import { toE164Br } from './phoneBr'
import type { Lead } from './types'

export interface ManualOliviaInput {
  nome: string
  whatsapp: string
  cidade: string
  notas?: string | null
}

export interface NormalizedManualOliviaInput {
  nome: string
  whatsapp: string
  cidade: string
  notas: string | null
}

export type ManualOliviaValidationResult =
  | { ok: true; value: NormalizedManualOliviaInput }
  | { ok: false; error: string }

export interface ManualOliviaLeadPayload {
  nome: string
  origem: 'manual_olivia'
  google_place_id: string
  setor: string
  cidade: string
  whatsapp_phone: string
  whatsapp_source: 'manual'
  whatsapp_status: 'found'
  whatsapp_checked_at: string
  nome_genero: null
  status: 'qualificado'
  notas: string
  whatsapp_send_status: null
  whatsapp_msg_id: null
  whatsapp_sent_at: null
}

const RETRYABLE_SEND_STATUSES = new Set<Lead['whatsapp_send_status']>(['failed', 'invalid'])
const SENT_SEND_STATUSES = new Set<Lead['whatsapp_send_status']>(['sent', 'delivered', 'read', 'replied'])
const MAX_NOME_LENGTH = 120
const MAX_CIDADE_LENGTH = 120
const MAX_NOTAS_LENGTH = 1000

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeManualOliviaInput(input: ManualOliviaInput): ManualOliviaValidationResult {
  const nome = cleanText(input.nome)
  if (!nome) return { ok: false, error: 'Informe o nome do contato ou negócio.' }
  if (nome.length > MAX_NOME_LENGTH) return { ok: false, error: `Nome deve ter até ${MAX_NOME_LENGTH} caracteres.` }

  const whatsapp = toE164Br(input.whatsapp)
  if (!whatsapp) return { ok: false, error: 'Informe um WhatsApp brasileiro com DDD.' }

  const cidade = cleanText(input.cidade)
  if (!cidade) return { ok: false, error: 'Informe a cidade.' }
  if (cidade.length > MAX_CIDADE_LENGTH) return { ok: false, error: `Cidade deve ter até ${MAX_CIDADE_LENGTH} caracteres.` }

  const notas = cleanText(input.notas ?? '')
  if (notas.length > MAX_NOTAS_LENGTH) return { ok: false, error: `Notas devem ter até ${MAX_NOTAS_LENGTH} caracteres.` }
  return {
    ok: true,
    value: {
      nome,
      whatsapp,
      cidade,
      notas: notas || null,
    },
  }
}

export function manualOliviaDedupKey(whatsappE164: string): string {
  return `manual_olivia:${whatsappE164.replace(/\D/g, '')}`
}

export function buildManualOliviaLeadPayload(
  input: NormalizedManualOliviaInput,
  checkedAtIso: string,
): ManualOliviaLeadPayload {
  return {
    nome: input.nome,
    origem: 'manual_olivia',
    google_place_id: manualOliviaDedupKey(input.whatsapp),
    setor: 'Geral',
    cidade: input.cidade,
    whatsapp_phone: input.whatsapp,
    whatsapp_source: 'manual',
    whatsapp_status: 'found',
    whatsapp_checked_at: checkedAtIso,
    nome_genero: null,
    status: 'qualificado',
    notas: input.notas ? `Manual Olivia: ${input.notas}` : 'Manual Olivia',
    whatsapp_send_status: null,
    whatsapp_msg_id: null,
    whatsapp_sent_at: null,
  }
}

export function canRetryManualOliviaOutreach(
  lead: Pick<Lead, 'whatsapp_sent_at' | 'whatsapp_send_status'>,
): boolean {
  if (RETRYABLE_SEND_STATUSES.has(lead.whatsapp_send_status)) return true
  if (SENT_SEND_STATUSES.has(lead.whatsapp_send_status)) return false
  return !lead.whatsapp_sent_at
}
