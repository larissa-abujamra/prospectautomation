// Envio de template WhatsApp via Meta Cloud API (módulo WhatsApp, Parte D).
// =============================================================================
// Partes PURAS (sem I/O) — unit-testadas no Vitest e usadas pela Edge Function
// `enviar-whatsapp`. O envio em si é HubSpot-independente: a automação de
// workflow do HubSpot é bloqueada por escopo neste portal (automation 403), então
// disparamos direto pela Cloud API da Meta, que é a fonte real do WABA. O HubSpot
// segue como CRM (contato já sincronizado) e recebe as respostas no inbox.
//
// ANTI-INVENÇÃO: só monta payload para lead mensageável; nada de número/dado
// fabricado. Gênero ausente → 'f' (default seguro, ver _shared/genero.ts).
// =============================================================================

import type { Genero } from './genero.ts'

// Os dois templates aprovados na Meta (WABA Inner AI). Diferem só no artigo o/a.
export const TEMPLATE_F = 'squad_prospeccao_intro_f'
export const TEMPLATE_M = 'squad_prospeccao_intro_m'

export interface SendableLead {
  nome: string
  cidade: string | null
  whatsapp_phone: string | null
  whatsapp_status: string | null
  nome_genero: string | null
}

// Escolhe o template pelo gênero do nome. 'm' → masculino; qualquer outra coisa
// (incl. null/incerto) → feminino (default da lista, majoritariamente feminina).
export function templateForGenero(genero: Genero | string | null | undefined): string {
  return genero === 'm' ? TEMPLATE_M : TEMPLATE_F
}

// Idioma POR template — eles foram registrados em idiomas diferentes na Meta
// (intro_f = pt_BR, intro_m = en). O `language.code` do envio TEM que casar com o
// idioma registrado, senão a Meta rejeita. Configurável por env (WHATSAPP_LANG_F /
// WHATSAPP_LANG_M) pra ajustar sem redeploy se algum template for recriado.
export function langForGenero(
  genero: Genero | string | null | undefined,
  langF = 'pt_BR',
  langM = 'en',
): string {
  return genero === 'm' ? langM : langF
}

// Só envia quem tem número achado + cidade (variável do template). Sem isso,
// não há mensagem possível — devolve motivo claro para a UI/anti-invenção.
export function sendBlockReason(lead: SendableLead): string | null {
  if (lead.whatsapp_status !== 'found') return 'whatsapp_status != found'
  if (!lead.whatsapp_phone) return 'sem whatsapp_phone'
  if (!lead.nome || lead.nome.trim() === '') return 'sem nome'
  if (!lead.cidade || lead.cidade.trim() === '') return 'sem cidade (variável {{2}} do template)'
  return null
}

// E.164 "+5511963366136" → "5511963366136" (Cloud API quer só dígitos no `to`).
export function toWhatsappRecipient(e164: string): string {
  return e164.replace(/\D/g, '')
}

export interface TemplatePayload {
  messaging_product: 'whatsapp'
  to: string
  type: 'template'
  template: {
    name: string
    language: { code: string }
    components: Array<{
      type: 'body'
      parameters: Array<{ type: 'text'; text: string }>
    }>
  }
}

/**
 * Monta o payload exato do POST /{phone_number_id}/messages da Cloud API.
 * Os 3 parâmetros do corpo seguem a ordem dos templates: {{1}}=nome, {{2}}=cidade,
 * {{3}}=nome. (Os templates reusam o nome em {{1}} e {{3}}.)
 */
export function buildTemplatePayload(
  lead: SendableLead,
  langCode: string,
): TemplatePayload {
  const template = templateForGenero(lead.nome_genero)
  const nome = lead.nome.trim()
  const cidade = (lead.cidade ?? '').trim()
  return {
    messaging_product: 'whatsapp',
    to: toWhatsappRecipient(lead.whatsapp_phone as string),
    type: 'template',
    template: {
      name: template,
      language: { code: langCode },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: nome },
            { type: 'text', text: cidade },
            { type: 'text', text: nome },
          ],
        },
      ],
    },
  }
}

export type SendStatus = 'sent' | 'failed' | 'invalid'

export interface SendResult {
  status: SendStatus
  messageId: string | null
  errorCode: number | null
  errorMessage: string | null
}

// Códigos da Meta que indicam "número não está no WhatsApp" → marcamos 'invalid'
// (não adianta reenviar; não é falha transitória).
const NOT_ON_WHATSAPP_CODES = new Set([131026, 131000, 131047])

/**
 * Interpreta a resposta da Cloud API. 2xx com messages[0].id → 'sent'. Erro de
 * número inexistente no WhatsApp → 'invalid'. Qualquer outro erro → 'failed'.
 */
export function parseSendResult(httpStatus: number, body: unknown): SendResult {
  const b = (body ?? {}) as Record<string, any>
  if (httpStatus >= 200 && httpStatus < 300) {
    const id = b?.messages?.[0]?.id ?? null
    if (id) return { status: 'sent', messageId: String(id), errorCode: null, errorMessage: null }
    return { status: 'failed', messageId: null, errorCode: null, errorMessage: 'resposta 2xx sem message id' }
  }
  const err = b?.error ?? {}
  const code = Number(err?.code ?? err?.error_data?.details ?? 0) || null
  const msg = String(err?.message ?? `HTTP ${httpStatus}`)
  if (code && NOT_ON_WHATSAPP_CODES.has(code)) {
    return { status: 'invalid', messageId: null, errorCode: code, errorMessage: msg }
  }
  return { status: 'failed', messageId: null, errorCode: code, errorMessage: msg }
}
