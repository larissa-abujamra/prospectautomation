// Guarda anti-SSRF para fetch de URLs NÃO confiáveis (ex.: leads.website, que
// qualquer usuário interno / import CSV pode gravar). Sem isto, o fetch do
// servidor poderia atingir metadata da cloud (169.254.169.254), localhost ou
// IPs privados.
//
// Partes puras (classificação de IP) ficam aqui para serem unit-testadas no
// Vitest. `hostIsPublic`/`safeFetchHtml` usam APIs do Deno (resolveDns/fetch),
// que só são tocadas em tempo de execução — o módulo importa limpo no Node.

export function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return null
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0
}

export function isPrivateOrLoopbackV4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true // não parseou → trate como inseguro
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return ((n & mask) >>> 0) === ((b & mask) >>> 0)
  }
  return (
    inRange('0.0.0.0', 8) ||      // "this host"
    inRange('10.0.0.0', 8) ||     // privado (RFC1918)
    inRange('100.64.0.0', 10) ||  // CGNAT
    inRange('127.0.0.0', 8) ||    // loopback
    inRange('169.254.0.0', 16) || // link-local (inclui metadata 169.254.169.254)
    inRange('172.16.0.0', 12) ||  // privado
    inRange('192.168.0.0', 16)    // privado
  )
}

export function isPrivateOrLoopbackV6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (a === '::1' || a === '::') return true
  if (/^fe[89ab]/.test(a)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(a)) return true // fc00::/7 ULA
  const mapped = a.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/) // IPv4-mapeado
  if (mapped) return isPrivateOrLoopbackV4(mapped[1])
  return false
}

// Resolve o host e exige que TODOS os IPs sejam públicos. IP literal é checado
// direto. Declaração do Deno só para o type-check do edge (Node ignora em runtime).
declare const Deno: { resolveDns(host: string, type: 'A' | 'AAAA'): Promise<string[]> }

export async function hostIsPublic(hostname: string): Promise<boolean> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return !isPrivateOrLoopbackV4(hostname)
  if (hostname.includes(':')) return !isPrivateOrLoopbackV6(hostname)
  let resolvedAny = false
  for (const type of ['A', 'AAAA'] as const) {
    try {
      const ips = await Deno.resolveDns(hostname, type)
      for (const ip of ips) {
        resolvedAny = true
        const bad = type === 'A' ? isPrivateOrLoopbackV4(ip) : isPrivateOrLoopbackV6(ip)
        if (bad) return false
      }
    } catch {
      // sem registro desse tipo — tenta o próximo
    }
  }
  return resolvedAny // precisa resolver para ao menos um IP, todos públicos
}

// Fetch com allowlist de protocolo, checagem de IP e cada redirect revalidado.
// Retorna o corpo (HTML) limitado, ou null se inseguro/erro.
export async function safeFetchHtml(
  rawUrl: string,
  opts: { maxRedirects?: number; timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  const { maxRedirects = 3, timeoutMs = 8000, maxBytes = 500_000 } = opts
  let current = rawUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u: URL
    try {
      u = new URL(current)
    } catch {
      return null
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!(await hostIsPublic(u.hostname))) return null

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    let resp: Response
    try {
      resp = await fetch(u, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (SquadProspeccao bot)' },
      })
    } finally {
      clearTimeout(t)
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (!loc) return null
      current = new URL(loc, u).toString() // resolve relativo; revalida no topo do loop
      continue
    }
    if (!resp.ok) return null
    return (await resp.text()).slice(0, maxBytes)
  }
  return null // redirects demais
}
