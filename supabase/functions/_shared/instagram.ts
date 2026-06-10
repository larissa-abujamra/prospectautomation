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
    'directory', 'developer', 'legal', 'web', 'sharer',
  ])
  return reserved.has(h.toLowerCase()) ? null : h
}

/**
 * Extrai um @handle do Instagram do HTML de um site (link no header/rodapé).
 * Muitos negócios linkam o IG no próprio site — fonte DIRETA e grátis, e o
 * enriquecimento já baixa esse HTML pro CNPJ (custo zero). Pega o 1º handle
 * válido (caminhos reservados /p /reel… são ignorados). Não inventa nada.
 */
export function handleFromHtml(html: string | null | undefined): string | null {
  if (!html) return null
  for (const m of html.matchAll(/instagram\.com\/([A-Za-z0-9._]+)/gi)) {
    const h = instagramHandleFromUrl('instagram.com/' + m[1])
    if (h) return h
  }
  return null
}

const normIg = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Quão bem um @handle casa com o nome do negócio (0..1). Igual/contido → alto;
 * senão, fração dos tokens do nome (>2 letras) presentes no handle. Usado para
 * escolher o handle CERTO entre os links do Google (evita concorrente/agregador).
 */
export function handleCasaNome(handle: string, nome: string): number {
  const h = normIg(handle)
  const n = normIg(nome)
  if (!h || !n) return 0
  if (h === n) return 1
  if (h.includes(n) || n.includes(h)) return 0.8
  const tokens = nome
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((t) => t.length > 2)
  if (tokens.length === 0) return 0
  const hits = tokens.filter((t) => h.includes(t)).length
  return hits / tokens.length
}

// Descobre o @handle de um negócio via Scrapingdog Google Search. Em vez de pegar
// o 1º link instagram.com/<perfil> (que pode ser concorrente/agregador), pontua
// cada candidato pela semelhança com o nome e escolhe o melhor; só cai no 1º
// encontrado quando nenhum casa o nome (melhora precisão sem perder cobertura).
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
    const candidatos: string[] = []
    for (const r of results) {
      for (const field of [r.link, r.displayed_link]) {
        const h = field ? instagramHandleFromUrl(String(field)) : null
        if (h && !candidatos.includes(h)) candidatos.push(h)
      }
    }
    if (candidatos.length === 0) return null
    let melhor = candidatos[0]
    let melhorScore = handleCasaNome(melhor, nome)
    for (const h of candidatos.slice(1)) {
      const s = handleCasaNome(h, nome)
      if (s > melhorScore) { melhor = h; melhorScore = s }
    }
    return melhor
  } catch {
    return null
  }
}
