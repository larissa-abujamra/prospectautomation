// Helper compartilhado entre Edge Functions.
// Busca o nº de seguidores de um perfil do Instagram via Scrapingdog.
// Best-effort: ~15 créditos por perfil; degrada para null sem lançar erro.
// O nome do campo de seguidores varia entre versões da API, então tentamos
// vários caminhos prováveis.
export async function buscarSeguidores(
  handle: string,
  apiKey: string,
): Promise<number | null> {
  const username = handle.replace(/^@/, '').trim()
  if (!username) return null
  try {
    const url = `https://api.scrapingdog.com/instagram/profile?api_key=${apiKey}&username=${encodeURIComponent(username)}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    const candidates = [
      data?.followers,
      data?.follower_count,
      data?.followers_count,
      data?.edge_followed_by?.count,
      data?.user?.edge_followed_by?.count,
      data?.data?.followers,
    ]
    for (const c of candidates) {
      const n = typeof c === 'string' ? Number(c.replace(/\D/g, '')) : Number(c)
      if (Number.isFinite(n) && n > 0) return n
    }
    return null
  } catch {
    return null
  }
}

// Extrai o handle de uma URL do instagram.com (ignora caminhos reservados).
export function instagramHandleFromUrl(url: string): string | null {
  const m = url.match(/instagram\.com\/([A-Za-z0-9._]+)/i)
  if (!m) return null
  const h = m[1]
  const reserved = new Set([
    'p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'about',
    'directory', 'developer', 'legal', 'web',
  ])
  return reserved.has(h.toLowerCase()) ? null : h
}

// Descobre o @handle de um negócio via Scrapingdog Google Search: pega o 1º link
// instagram.com/<perfil> dos resultados orgânicos. O handle vem de um link REAL
// do Google (não é inventado), no mesmo espírito da descoberta de CNPJ pela URL.
export async function descobrirHandle(
  nome: string,
  cidade: string | null,
  apiKey: string,
): Promise<string | null> {
  const query = `"${nome}" instagram ${cidade ?? ''}`.replace(/\s+/g, ' ').trim()
  const url = `https://api.scrapingdog.com/google/?api_key=${apiKey}&query=${encodeURIComponent(query)}&country=br&results=10`
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    const results = Array.isArray(data?.organic_results) ? data.organic_results : []
    for (const r of results) {
      for (const field of [r.link, r.displayed_link]) {
        const h = field ? instagramHandleFromUrl(String(field)) : null
        if (h) return h
      }
    }
    return null
  } catch {
    return null
  }
}
