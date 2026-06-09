// Pure phone helpers for Brazilian WhatsApp number-finding.
// =============================================================================
// Used by the `encontrar-whatsapp` Edge Function (Deno) AND unit-tested from the
// frontend test suite (Vitest). Keep this file PURE: no Deno/Node APIs, no I/O —
// only string/regex logic, so it imports cleanly in both runtimes.
//
// ANTI-INVENÇÃO (crítico): nunca fabricar dígitos. Um celular legado de 8 dígitos
// (sem o 9º dígito) é AMBÍGUO → retornamos null em vez de "completar" o número.
// =============================================================================

export type PhoneKind = 'mobile' | 'landline'

export interface NormalizedPhone {
  e164: string
  kind: PhoneKind
}

const onlyDigits = (s: string): string => s.replace(/\D/g, '')

// Tira o DDI 55 quando o total bate com nacional + país (12 ou 13 dígitos).
function stripCountryCode(digits: string): string {
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return digits.slice(2)
  }
  return digits
}

const isValidDdd = (ddd: string): boolean => {
  const n = Number(ddd)
  return Number.isInteger(n) && n >= 11 && n <= 99
}

/**
 * Normaliza um telefone brasileiro para E.164 + classifica fixo/celular.
 * - Celular: subscriber de 9 dígitos começando com 9.
 * - Fixo: subscriber de 8 dígitos começando 2–5.
 * - Qualquer outra coisa (ambíguo/implausível) → null (anti-invenção).
 */
export function normalizeBrazilPhone(
  raw: string | null | undefined,
): NormalizedPhone | null {
  if (!raw) return null
  const national = stripCountryCode(onlyDigits(raw))
  if (national.length !== 10 && national.length !== 11) return null

  const ddd = national.slice(0, 2)
  if (!isValidDdd(ddd)) return null

  const subscriber = national.slice(2)

  if (subscriber.length === 9 && subscriber.startsWith('9')) {
    return { e164: `+55${national}`, kind: 'mobile' }
  }
  if (subscriber.length === 8 && /^[2-5]/.test(subscriber)) {
    return { e164: `+55${national}`, kind: 'landline' }
  }
  // 8 dígitos começando 6–9 = celular legado sem o 9º dígito → não inventamos.
  return null
}

// Formata dígitos "soltos" (de um link wa.me, que já é WhatsApp autoritativo) em
// E.164, assumindo DDI 55 quando só vieram DDD+assinante. Não classifica tipo —
// confia no link. Retorna null se o comprimento não fizer sentido.
function looseBrazilE164(digits: string): string | null {
  const national = stripCountryCode(digits)
  if (national.length !== 10 && national.length !== 11) return null
  if (!isValidDdd(national.slice(0, 2))) return null
  return `+55${national}`
}

/**
 * Extrai um número de WhatsApp de uma URL (wa.me, api.whatsapp.com/send?phone=,
 * whatsapp://send?phone=). Retorna E.164 ou null.
 */
export function whatsappFromUrl(url: string | null | undefined): string | null {
  if (!url) return null

  // phone= em api.whatsapp.com/send ou whatsapp://send
  const phoneParam = url.match(/[?&]phone=([^&]+)/i)
  if (phoneParam) {
    let raw = phoneParam[1]
    try {
      raw = decodeURIComponent(raw)
    } catch {
      // mantém cru se o decode falhar
    }
    const digits = onlyDigits(raw)
    return digits ? looseBrazilE164(digits) : null
  }

  // wa.me/<numero>
  const waMe = url.match(/wa\.me\/([+\d][\d\s()+-]*)/i)
  if (waMe) {
    const digits = onlyDigits(waMe[1])
    return digits ? looseBrazilE164(digits) : null
  }

  return null
}

const WA_LINK_RE = /(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/send)\S*/i
// Versão global para varrer TODOS os candidatos de link num HTML (o primeiro
// pode ser um wa.me/qr/<slug> sem número — não pode encerrar a busca).
const WA_LINK_RE_G = new RegExp(WA_LINK_RE.source, 'gi')
// href="tel:..." — declaração explícita de telefone pelo dono do site.
const TEL_HREF_RE = /href\s*=\s*["']?tel:([+\d][\d\s().+-]*)/gi
// DDD + assinante (4–5 dígitos + 4), com DDI/máscara opcionais.
const PHONE_RE = /(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*\d{4,5}[\s.-]*\d{4}/g

/**
 * Extrai um número de WhatsApp de HTML de SITE: só fontes EXPLÍCITAS — links
 * wa.me / api.whatsapp.com / whatsapp:// (todos os candidatos, em ordem) e, em
 * fallback, href="tel:..." quando for CELULAR.
 *
 * NUNCA varre o texto cru do HTML: floats de JavaScript parecem celulares
 * válidos para o regex solto e viram números fabricados (bug real: o
 * `47.925619188` de uma animação no margherita.com.br virou +5547925619188 e
 * recebeu um template de WhatsApp). Anti-invenção > recall.
 */
export function findWhatsappInHtml(html: string | null | undefined): string | null {
  if (!html) return null

  for (const candidate of html.match(WA_LINK_RE_G) ?? []) {
    const fromLink = whatsappFromUrl(candidate)
    if (fromLink) return fromLink
  }

  for (const m of html.matchAll(TEL_HREF_RE)) {
    const norm = normalizeBrazilPhone(m[1])
    if (norm && norm.kind === 'mobile') return norm.e164
  }

  return null
}

/**
 * Varre TEXTO HUMANO CURTO (bio do Instagram) por um número de WhatsApp.
 * Prioriza links wa.me (autoritativos); senão, o primeiro CELULAR escrito por
 * extenso. Telefones fixos no texto são ignorados (não são whatsapp-able aqui).
 * NÃO usar em HTML de site — para isso existe findWhatsappInHtml (links-only).
 */
export function findWhatsappInText(text: string | null | undefined): string | null {
  if (!text) return null

  const link = text.match(WA_LINK_RE)
  if (link) {
    const fromLink = whatsappFromUrl(link[0])
    if (fromLink) return fromLink
  }

  const matches = text.match(PHONE_RE)
  if (matches) {
    for (const m of matches) {
      const norm = normalizeBrazilPhone(m)
      if (norm && norm.kind === 'mobile') return norm.e164
    }
  }

  return null
}
