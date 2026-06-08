// Edge Function: instagram-followers
// =============================================================================
// Recebe um handle do Instagram e devolve o nº de seguidores (Scrapingdog).
// A CHAVE NUNCA vai pro frontend — fica neste secret server-side:
//   supabase secrets set SCRAPINGDOG_API_KEY=...
//
// Best-effort: perfil privado/erro → { followers: null } (nunca lança 500).
// Custo: ~15 créditos por perfil. O frontend chama isto em segundo plano só
// para leads que têm handle e ainda não têm o número.
// =============================================================================

import { buscarSeguidores } from '../_shared/instagram.ts'

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
  try {
    const body = await req.json()
    handle = String(body.handle ?? '').trim()
    if (!handle) return json({ error: 'Informe handle.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const followers = await buscarSeguidores(handle, key)
  return json({ followers })
})
