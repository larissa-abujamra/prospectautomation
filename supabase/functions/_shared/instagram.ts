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
