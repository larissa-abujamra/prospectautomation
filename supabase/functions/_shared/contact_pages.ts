// Descoberta de páginas de contato num HTML (módulo WhatsApp, Parte A).
// =============================================================================
// Sem I/O — só parsing puro, unit-testado no Vitest e usado pela Edge Function
// `encontrar-whatsapp` (Deno). O link de wa.me costuma morar em /contato ou
// /fale-conosco, não na home — esta função acha esses links para o caller
// buscar (cada fetch SEMPRE passa pelo safeFetchHtml, que revalida SSRF).
//
// SÓ MESMA ORIGEM: a varredura não segue para domínios de terceiros — o número
// precisa vir do site do próprio negócio (anti-invenção/provenance).
// =============================================================================

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
const CONTACT_HINT_RE = /contat|fale[\s-]*conosco|atendimento|whats?app|\bwpp\b/i
const MAX_LINKS = 3

/**
 * Extrai até 3 URLs de páginas de contato do HTML, resolvidas contra baseUrl,
 * mesma origem apenas. Casa pela URL OU pelo texto do link ("Fale conosco").
 */
export function extractContactLinks(html: string, baseUrl: string): string[] {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return []
  }

  const out: string[] = []
  const seen = new Set<string>()

  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!href || href.startsWith('#')) continue

    const text = m[4].replace(/<[^>]*>/g, ' ')
    if (!CONTACT_HINT_RE.test(href) && !CONTACT_HINT_RE.test(text)) continue

    let resolved: URL
    try {
      resolved = new URL(href, base)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    if (resolved.origin !== base.origin) continue

    resolved.hash = ''
    const url = resolved.toString()
    // não devolve a própria página que está sendo varrida
    if (url.replace(/\/$/, '') === base.toString().replace(/\/$/, '')) continue

    if (!seen.has(url)) {
      seen.add(url)
      out.push(url)
      if (out.length >= MAX_LINKS) break
    }
  }

  return out
}
