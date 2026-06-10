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
// São a copy de DOCES (cita Scherby's, Brigadayros, We Lov Cakes como social proof).
export const TEMPLATE_F = 'squad_prospeccao_intro_f'
export const TEMPLATE_M = 'squad_prospeccao_intro_m'

export interface SendableLead {
  nome: string
  setor: string | null
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

// --- Template por perfil (setor) ---------------------------------------------
// Plano .claude/plans/2026-06-10-olivia-autonoma.md (Parte 1): a copy de doces
// só faz sentido para confeitaria/cafeteria; o resto recebe a copy genérica.

export type SetorGrupo = 'doces' | 'generic'

// Match por substring normalizada (sem acento, minúscula) — cobre variações que
// o backend de busca classifica ("Confeitaria", "Cafeteria") e entradas manuais.
const SETORES_DOCES = ['confeitaria', 'doceria', 'doces', 'cafeteria']

const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * Agrupa o `setor` do lead no grupo de template. Sem setor → 'generic'
 * (anti-invenção: a copy genérica é verdadeira para qualquer negócio; a de
 * doces afirma "docerias e confeitarias como a sua" e seria mentira numa
 * academia).
 */
export function grupoForSetor(setor: string | null | undefined): SetorGrupo {
  if (!setor || setor.trim() === '') return 'generic'
  const n = normalize(setor)
  return SETORES_DOCES.some((s) => n.includes(s)) ? 'doces' : 'generic'
}

// Templates por SEGMENTO × gênero (todos aprovados na Meta em 10/06, pt_BR, com
// o link da matéria). Os antigos squad_prospeccao_intro_f/m (TEMPLATE_F/M) ficam
// só para o legado templateForGenero; a matriz usa os novos por segmento.
export const TEMPLATE_DOCES_F = 'squad_intro_doces_f'
export const TEMPLATE_DOCES_M = 'squad_intro_doces_m'
export const TEMPLATE_GENERIC_F = 'squad_intro_generic_f'
export const TEMPLATE_GENERIC_M = 'squad_intro_generic_m'

export interface TemplateMatrix {
  docesF: string
  docesM: string
  genericF: string
  genericM: string
}

export const DEFAULT_TEMPLATES: TemplateMatrix = {
  docesF: TEMPLATE_DOCES_F,
  docesM: TEMPLATE_DOCES_M,
  genericF: TEMPLATE_GENERIC_F,
  genericM: TEMPLATE_GENERIC_M,
}

/** Escolhe o template na matriz segmento × gênero (default 'f', como sempre). */
export function templateFor(
  setor: string | null | undefined,
  genero: Genero | string | null | undefined,
  templates: TemplateMatrix = DEFAULT_TEMPLATES,
): string {
  const grupo = grupoForSetor(setor)
  if (grupo === 'doces') return genero === 'm' ? templates.docesM : templates.docesF
  return genero === 'm' ? templates.genericM : templates.genericF
}

// Idiomas por célula da matriz — os 4 templates novos são todos pt_BR (o 'en'
// legado era do antigo squad_prospeccao_intro_m). Sobrescrevível por env na function.
export interface LangMatrix {
  docesF: string
  docesM: string
  genericF: string
  genericM: string
}

export const DEFAULT_LANGS: LangMatrix = {
  docesF: 'pt_BR',
  docesM: 'pt_BR',
  genericF: 'pt_BR',
  genericM: 'pt_BR',
}

/** Idioma registrado do template escolhido (tem que casar, senão a Meta rejeita). */
export function langFor(
  setor: string | null | undefined,
  genero: Genero | string | null | undefined,
  langs: LangMatrix = DEFAULT_LANGS,
): string {
  const grupo = grupoForSetor(setor)
  if (grupo === 'doces') return genero === 'm' ? langs.docesM : langs.docesF
  return genero === 'm' ? langs.genericM : langs.genericF
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
  templates: TemplateMatrix = DEFAULT_TEMPLATES,
): TemplatePayload {
  const template = templateFor(lead.setor, lead.nome_genero, templates)
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
