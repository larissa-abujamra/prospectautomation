// Edge Function: geocodar-local
// =============================================================================
// Resolve uma descrição de lugar (ex.: "São Paulo, SP, Brasil" ou "Pinheiros,
// São Paulo") em CENTRO (lat/lng) + BBOX (viewport) usando a Places API (New).
// É o passo anterior à busca em massa por grade (buscar-grade): a UI geocodifica
// o que o usuário escolheu no autocomplete e passa o bbox real da cidade/região
// pra ladrilhar — em vez de um círculo arbitrário.
//
// Usa Places searchText (já habilitada/cobrada na conta), NÃO a Geocoding API
// (que pode não estar habilitada). 1 requisição por chamada. Auth: usuário logado.
//   supabase functions deploy geocodar-local --no-verify-jwt
// =============================================================================

import { requireAuthenticatedUser } from '../_shared/auth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const PLACES_NEW_URL = 'https://places.googleapis.com/v1/places:searchText'
const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.viewport',
].join(',')

interface Viewport {
  low?: { latitude?: number; longitude?: number }
  high?: { latitude?: number; longitude?: number }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const key = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY')
  if (!key) return json({ error: 'GOOGLE_PLACES_API_KEY não configurada.' }, 500)

  let local: string
  try {
    const b = await req.json()
    local = String(b.local ?? b.localizacao ?? '').trim()
    if (!local) return json({ error: 'Informe um local.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  try {
    const resp = await fetch(PLACES_NEW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: local, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 1 }),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      const msg = (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${resp.status}`
      return json({ error: `Places: ${msg}` }, 502)
    }
    const place = (data as { places?: Array<Record<string, unknown>> }).places?.[0]
    const loc = place?.location as { latitude?: number; longitude?: number } | undefined
    if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
      return json({ error: 'Local não encontrado.' }, 404)
    }
    const vp = place?.viewport as Viewport | undefined
    const bbox =
      vp?.low?.latitude != null && vp?.high?.latitude != null
        ? {
            low: { lat: vp.low.latitude, lng: vp.low!.longitude! },
            high: { lat: vp.high.latitude, lng: vp.high!.longitude! },
          }
        : null
    return json({
      centerLat: loc.latitude,
      centerLng: loc.longitude,
      bbox, // viewport real da cidade/região (null se o Places não devolveu)
      nome: (place?.displayName as { text?: string })?.text ?? null,
      endereco: (place?.formattedAddress as string) ?? null,
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, 502)
  }
})
