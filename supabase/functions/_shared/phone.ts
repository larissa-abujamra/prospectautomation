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

/**
 * Extrai o DDD (2 dígitos) de um número E.164/nacional BR. Usado para o
 * cross-check de região (DDD do número achado × DDD de referência do lead).
 * Devolve null se não for um nacional BR plausível.
 */
export function extrairDddE164(e164: string | null | undefined): string | null {
  if (!e164) return null
  const national = stripCountryCode(onlyDigits(e164))
  if (national.length !== 10 && national.length !== 11) return null
  const ddd = national.slice(0, 2)
  return isValidDdd(ddd) ? ddd : null
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

// Janela (em chars do HTML cru) ao redor de um href="tel:" onde procuramos uma
// palavra-chave de WhatsApp. Cobre o ícone/classe da âncora ("fa-whatsapp"),
// rótulo adjacente ("WhatsApp:") e atributos próximos.
const TEL_KEYWORD_WINDOW = 120

// Há sinal de WhatsApp (palavra/ícone/classe) perto deste href="tel:"? Um número
// de telefone num tel: é, por padrão, para LIGAR — só o tratamos como WhatsApp
// quando o próprio site sinaliza isso por perto. Sem sinal → é call-only.
function temSinalWhatsappPerto(html: string, idx: number, len: number): boolean {
  const start = Math.max(0, idx - TEL_KEYWORD_WINDOW)
  const end = Math.min(html.length, idx + len + TEL_KEYWORD_WINDOW)
  return /whats?app|\bwpp\b|\bzap\b/i.test(html.slice(start, end))
}

/**
 * Extrai um número de WhatsApp de HTML de SITE: só fontes EXPLÍCITAS — links
 * wa.me / api.whatsapp.com / whatsapp:// (todos os candidatos, em ordem) e, em
 * fallback, href="tel:..." de CELULAR **somente quando há sinal de WhatsApp por
 * perto** (ícone/rótulo/classe). Sem esse sinal, um tel: é só um número de
 * ligação — tratá-lo como WhatsApp era a principal fonte de "número errado".
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
    if (norm && norm.kind === 'mobile' && temSinalWhatsappPerto(html, m.index ?? 0, m[0].length)) {
      return norm.e164
    }
  }

  return null
}

// Palavras que anunciam um número de WhatsApp em texto visível de site.
const WA_KEYWORD_RE = /whats?app|\bwpp\b|\bzap\b/gi
// Celular com FRONTEIRAS: não pode encostar em mais dígitos/ponto — floats de
// JS (47.925619188), UUIDs e sequências longas ficam de fora por construção.
const NEAR_PHONE_RE = /(?<![\d.])(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*\d{4,5}[\s.-]*\d{4}(?![\d.])/g
const KW_WINDOW_BEFORE = 40
const KW_WINDOW_AFTER = 80

// Texto visível: remove blocos de script/style/noscript, comentários e tags.
function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
}

/**
 * Recall calibrado para HTML de site: acha um CELULAR escrito como texto
 * VISÍVEL a poucos caracteres de uma palavra-chave de WhatsApp (ex.:
 * "Whatsapp (11) 96595-0143"). Complementa findWhatsappInHtml (links) sem
 * reabrir o buraco do texto cru: scripts/styles são descartados, o número
 * precisa de fronteira limpa e a proximidade da palavra-chave é obrigatória.
 */
export function findWhatsappNearKeyword(html: string | null | undefined): string | null {
  if (!html) return null
  const text = visibleText(html)
  for (const kw of text.matchAll(WA_KEYWORD_RE)) {
    const idx = kw.index ?? 0
    const start = Math.max(0, idx - KW_WINDOW_BEFORE)
    const end = Math.min(text.length, idx + kw[0].length + KW_WINDOW_AFTER)
    const win = text.slice(start, end)
    for (const m of win.matchAll(NEAR_PHONE_RE)) {
      const norm = normalizeBrazilPhone(m[0])
      if (norm && norm.kind === 'mobile') return norm.e164
    }
  }
  return null
}

/**
 * Varre TEXTO HUMANO CURTO (bio do Instagram) por um número de WhatsApp.
 * Prioriza links wa.me (autoritativos); senão, o primeiro CELULAR escrito por
 * extenso. Telefones fixos no texto são ignorados (não são whatsapp-able aqui).
 * NÃO usar em HTML de site — para isso existe findWhatsappInHtml (links-only)
 * + findWhatsappNearKeyword (texto visível com palavra-chave): o texto cru do
 * HTML transforma floats de JS em celulares fabricados (anti-invenção).
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
