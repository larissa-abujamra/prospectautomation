// Edge Function: instagram-followers
// =============================================================================
// Descobre o @handle do negócio (se faltar) e devolve o nº de seguidores, via
// Scrapingdog. A CHAVE NUNCA vai pro frontend — fica neste secret server-side:
//   supabase secrets set SCRAPINGDOG_API_KEY=...
//
// Entrada: { handle? , nome?, cidade? }
//   - com handle → busca direto os seguidores do perfil.
//   - sem handle, com nome → descobre o @handle pelo Google (1º link
//     instagram.com/<perfil> dos resultados) e então busca os seguidores.
// Saída: { handle: <usado/descoberto ou null>, followers: <número ou null> }
//
// Best-effort: perfil privado/erro/sem handle → null (nunca lança 500).
// Custo: descoberta = 1 Google Search; seguidores = ~15 créditos por perfil.
// =============================================================================

import { buscarSeguidores, descobrirHandle } from '../_shared/instagram.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const key = Deno.env.get('SCRAPINGDOG_API_KEY')
  if (!key) return json({ error: 'SCRAPINGDOG_API_KEY não configurada.' }, 500)

  let handle: string
  let nome: string
  let cidade: string | null
  try {
    const body = await req.json()
    handle = String(body.handle ?? '').trim().replace(/^@/, '')
    nome = String(body.nome ?? '').trim()
    cidade = body.cidade == null ? null : String(body.cidade)
    if (!handle && !nome) return json({ error: 'Informe handle ou nome.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  // Descobre o handle pelo Google se não veio um.
  if (!handle && nome) {
    handle = (await descobrirHandle(nome, cidade, key)) ?? ''
  }
  if (!handle) return json({ handle: null, followers: null })

  const followers = await buscarSeguidores(handle, key)
  return json({ handle, followers })
})
