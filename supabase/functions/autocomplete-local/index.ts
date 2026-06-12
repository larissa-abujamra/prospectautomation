// Edge Function: autocomplete-local
// =============================================================================
// Sugestões de localidade (bairro/cidade/região) via Google Places Autocomplete
// (New API), para o campo "Local" das buscas. Resolve a ambiguidade de nomes
// repetidos (ex.: "Alta Floresta" cidade no MT vs. bairro homônimo em outro
// estado): o usuário escolhe a sugestão certa e a descrição completa vai pro
// textQuery da busca.
//
// Roda no servidor (Deno) — a CHAVE DO GOOGLE NUNCA vai pro frontend. Usa o
// mesmo secret da buscar-negocios (GOOGLE_PLACES_API_KEY).
//
// CUSTO: Autocomplete é cobrado por requisição (barato, mas não-zero). O
// frontend debounça (~300ms) e exige 3+ caracteres; aqui validamos de novo.
// =============================================================================

import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { parseAutocompleteSuggestions } from '../_shared/autocomplete_local.ts'

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

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const key = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY')
  if (!key) return json({ error: 'GOOGLE_PLACES_API_KEY não configurada.' }, 500)

  let input: string
  try {
    const body = await req.json()
    input = String(body.input ?? '').trim()
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }
  if (input.length < 3) return json({ sugestoes: [] })

  // Filtra para REGIÕES (cidades, bairros, estados) — não queremos negócios
  // aqui, só lugares. Se o filtro for recusado pela API, repete sem ele
  // (robustez > filtro).
  const baseBody = { input, languageCode: 'pt-BR', includedRegionCodes: ['br'] }
  try {
    let resp = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ ...baseBody, includedPrimaryTypes: ['(regions)'] }),
    })
    if (!resp.ok) {
      resp = await fetch(AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
        body: JSON.stringify(baseBody),
      })
    }
    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = (data as any)?.error?.message ?? `HTTP ${resp.status}`
      return json({ error: `Autocomplete: ${msg}` }, 502)
    }
    return json({ sugestoes: parseAutocompleteSuggestions(data) })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, 502)
  }
})
