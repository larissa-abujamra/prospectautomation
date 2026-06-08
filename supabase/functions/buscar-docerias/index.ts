// Edge Function: buscar-docerias
// =============================================================================
// Descobre docerias/confeitarias em São Paulo via Google Places e grava como
// leads em public.leads. Roda no servidor (Deno) — a CHAVE DO GOOGLE NUNCA vai
// pro frontend.
//
// Secret necessário (server-side):
//   supabase secrets set GOOGLE_MAPS_API_KEY=...
//
// Antes de usar em produção, no Google Cloud:
//   1) ative o BILLING do projeto (Text Search + Place Details são COBRADOS por
//      requisição — cada place descoberto custa 1 Text Search compartilhado +
//      1 Place Details);
//   2) restrinja a chave por API (habilite só "Places API") e, se possível, por
//      referenciador/IP.
//
// O UPSERT por google_place_id (ver abaixo) evita re-buscar/re-cobrar leads que
// já existem.
//
// NOTA HONESTA sobre o ICP (">3k seguidores no Instagram"): esse dado NÃO vem do
// Google Places — o Places não conhece Instagram. O filtro de seguidores é
// aplicado depois, sobre a coluna instagram_followers, preenchida por outro
// caminho (edição inline / import CSV — ver Parte C do módulo). Leads sem esse
// dado NÃO são descartados aqui; ficam com instagram_followers = null.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Extrai um handle do Instagram a partir de uma URL de website, SE for um link
// do instagram.com. Caso contrário devolve null — nunca inventa handle.
function instagramHandleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/instagram\.com\/([A-Za-z0-9._]+)/i)
  if (!m) return null
  const handle = m[1]
  // caminhos reservados do Instagram não são perfis
  const reserved = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv'])
  if (reserved.has(handle.toLowerCase())) return null
  return handle
}

interface PlaceResult {
  place_id: string
  name: string
  formatted_address?: string
  geometry?: { location?: { lat: number; lng: number } }
  rating?: number
  user_ratings_total?: number
}

interface PlaceDetails {
  formatted_phone_number?: string
  international_phone_number?: string
  website?: string
}

const GOOGLE_BASE = 'https://maps.googleapis.com/maps/api/place'

// Text Search paginado. O Google devolve em páginas de ~20 e exige um pequeno
// delay antes do next_page_token ficar válido. No total a API entrega no máximo
// ~60 resultados (2 tokens), então `max` acima de 60 é naturalmente limitado.
async function textSearch(
  bairro: string,
  key: string,
  max: number,
): Promise<PlaceResult[]> {
  const query = `doceria OR confeitaria em ${bairro}, São Paulo`
  const results: PlaceResult[] = []
  let pageToken: string | null = null

  do {
    const url = new URL(`${GOOGLE_BASE}/textsearch/json`)
    url.searchParams.set('query', query)
    url.searchParams.set('language', 'pt-BR')
    url.searchParams.set('region', 'br')
    url.searchParams.set('key', key)
    if (pageToken) url.searchParams.set('pagetoken', pageToken)

    const resp = await fetch(url.toString())
    const data = await resp.json()

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(
        `Google Text Search: ${data.status} — ${data.error_message ?? 'sem detalhe'}`,
      )
    }

    for (const r of data.results ?? []) results.push(r)
    pageToken = data.next_page_token ?? null

    if (pageToken && results.length < max) {
      // o token só fica válido após um curto intervalo
      await sleep(2000)
    } else {
      pageToken = null
    }
  } while (pageToken && results.length < max)

  return results.slice(0, max)
}

async function placeDetails(
  placeId: string,
  key: string,
): Promise<PlaceDetails> {
  const url = new URL(`${GOOGLE_BASE}/details/json`)
  url.searchParams.set('place_id', placeId)
  url.searchParams.set(
    'fields',
    'formatted_phone_number,international_phone_number,website',
  )
  url.searchParams.set('language', 'pt-BR')
  url.searchParams.set('key', key)

  const resp = await fetch(url.toString())
  const data = await resp.json()
  if (data.status !== 'OK') return {}
  return data.result ?? {}
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const googleKey = Deno.env.get('GOOGLE_MAPS_API_KEY')
  if (!googleKey) {
    return json(
      { error: 'GOOGLE_MAPS_API_KEY não configurada (supabase secrets set).' },
      500,
    )
  }

  let bairro: string
  let max: number
  try {
    const body = await req.json()
    bairro = String(body.bairro ?? '').trim()
    max = Math.min(Math.max(Number(body.max) || 20, 1), 60)
    if (!bairro) return json({ error: 'Informe um bairro.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  // Service role: a função é protegida por JWT (só usuários autenticados
  // conseguem invocá-la), então aqui usamos a service role para escrever
  // ignorando a RLS — a autorização já aconteceu na borda.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    const places = await textSearch(bairro, googleKey, max)
    if (places.length === 0) return json({ inserted: 0, updated: 0, total: 0 })

    // Quais place_ids já existem? Separamos INSERT de UPDATE em vez de um upsert
    // cego: assim uma nova busca NÃO reseta campos do funil (status, notas) nem
    // dados preenchidos à mão (instagram_followers, instagram_handle) de leads
    // que já estão no pipeline. Só atualizamos os campos vindos do Google.
    const ids = places.map((p) => p.place_id)
    const { data: existingRows, error: selErr } = await supabase
      .from('leads')
      .select('google_place_id, instagram_handle')
      .in('google_place_id', ids)
    if (selErr) throw selErr

    const existing = new Map(
      (existingRows ?? []).map((r) => [r.google_place_id, r]),
    )

    const toInsert: Record<string, unknown>[] = []
    const updates: { placeId: string; patch: Record<string, unknown> }[] = []

    for (const p of places) {
      const details = await placeDetails(p.place_id, googleKey)
      const telefone =
        details.formatted_phone_number ??
        details.international_phone_number ??
        null
      const website = details.website ?? null
      const handle = instagramHandleFromUrl(website)
      const loc = p.geometry?.location

      const googleFields = {
        nome: p.name,
        endereco: p.formatted_address ?? null,
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
        telefone,
        website,
        rating: p.rating ?? null,
        reviews_count: p.user_ratings_total ?? null,
      }

      const prev = existing.get(p.place_id)
      if (!prev) {
        toInsert.push({
          ...googleFields,
          bairro,
          google_place_id: p.place_id,
          instagram_handle: handle, // pode ser null
          status: 'descoberto',
        })
      } else {
        const patch: Record<string, unknown> = { ...googleFields }
        // só preenche o handle se ainda estiver vazio — não sobrescreve edição manual
        if (handle && !prev.instagram_handle) patch.instagram_handle = handle
        updates.push({ placeId: p.place_id, patch })
      }
    }

    let inserted = 0
    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from('leads').insert(toInsert)
      if (insErr) throw insErr
      inserted = toInsert.length
    }

    let updated = 0
    for (const u of updates) {
      const { error: updErr } = await supabase
        .from('leads')
        .update(u.patch)
        .eq('google_place_id', u.placeId)
      if (updErr) throw updErr
      updated++
    }

    return json({ inserted, updated, total: places.length })
  } catch (e) {
    // Erro da API/DB volta com mensagem clara, sem derrubar a função.
    const message = e instanceof Error ? e.message : 'Erro desconhecido'
    return json({ error: message }, 502)
  }
})
