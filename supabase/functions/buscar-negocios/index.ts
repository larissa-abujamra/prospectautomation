// Edge Function: buscar-negocios
// =============================================================================
// Descobre negócios de QUALQUER setor (confeitaria, restaurante, pet shop…) num
// bairro de São Paulo via Google Places e grava como leads em public.leads.
// Roda no servidor (Deno) — a CHAVE DO GOOGLE NUNCA vai pro frontend.
//
// Secret (server-side):
//   supabase secrets set GOOGLE_PLACES_API_KEY=...
//   (também aceita o nome antigo GOOGLE_MAPS_API_KEY, por compatibilidade)
//   supabase secrets set SCRAPINGDOG_API_KEY=...   (só p/ o toggle de seguidores)
//
// Antes de usar em produção, no Google Cloud: ative o BILLING e restrinja a
// chave à Places API (Text Search + Place Details são COBRADOS por requisição).
// O UPSERT por google_place_id evita re-buscar/re-cobrar leads já existentes.
//
// NOTA: seguidores do Instagram NÃO vêm do Google Places. Quando comSeguidores
// é true, buscamos via Scrapingdog (~15 créditos/perfil) só para os leads que
// têm instagram_handle. Falha degrada para null em silêncio.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buscarSeguidores } from '../_shared/instagram.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { parseEnderecoFormatado } from '../_shared/endereco.ts'

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Extrai um handle do Instagram de uma URL de website, SE for instagram.com.
// Caso contrário devolve null — nunca inventa handle.
function instagramHandleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/instagram\.com\/([A-Za-z0-9._]+)/i)
  if (!m) return null
  const handle = m[1]
  const reserved = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv'])
  if (reserved.has(handle.toLowerCase())) return null
  return handle
}

// Resultado já COMPLETO de um lugar: a Places API (New) devolve telefone, site e
// horário no mesmo searchText (via FieldMask), então NÃO há mais uma 2ª chamada
// paga de "details" por resultado (era o gargalo de custo). primaryType pode vir
// null.
interface PlaceResult {
  place_id: string
  name: string
  formatted_address: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  user_ratings_total: number | null
  primaryType: string | null
  telefone: string | null
  website: string | null
  weekday_text: string[] | null
}

// Places API (New). A legada (maps/api/place/textsearch) tem a paginação quebrada
// para chaves novas (page 1 OK, mas o next_page_token devolve INVALID_REQUEST
// eterno). A New API pagina de forma confiável: repete-se o MESMO corpo da busca
// inicial + o pageToken. Campos retornados são controlados pelo X-Goog-FieldMask.
const PLACES_NEW_URL = 'https://places.googleapis.com/v1/places:searchText'
const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.primaryType',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.regularOpeningHours.weekdayDescriptions',
  'nextPageToken',
].join(',')

interface NewPlace {
  id?: string
  displayName?: { text?: string }
  formattedAddress?: string
  location?: { latitude?: number; longitude?: number }
  rating?: number
  userRatingCount?: number
  primaryType?: string
  nationalPhoneNumber?: string
  internationalPhoneNumber?: string
  websiteUri?: string
  regularOpeningHours?: { weekdayDescriptions?: string[] }
}

function mapNewPlace(p: NewPlace): PlaceResult | null {
  if (!p.id || !p.displayName?.text) return null // anti-invenção: sem id/nome, descarta
  return {
    place_id: p.id,
    name: p.displayName.text,
    formatted_address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    rating: p.rating ?? null,
    user_ratings_total: p.userRatingCount ?? null,
    primaryType: p.primaryType ?? null,
    telefone: p.nationalPhoneNumber ?? p.internationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    weekday_text: p.regularOpeningHours?.weekdayDescriptions ?? null,
  }
}

// --- Breakdown de restaurante em subcategorias (setor) ---------------------
// Listas de palavras = ponto de partida, fáceis de ajustar.
const PIZZA_WORDS = ['pizza', 'pizzaria']
const BURGER_WORDS = ['burger', 'burguer', 'hamburg', 'hamburgueria', 'smash']
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Termo buscado é da "família restaurante"? (aí classificamos cada resultado)
function ehFamiliaRestaurante(setor: string): boolean {
  const s = norm(setor)
  return (
    s.includes('restaurante') ||
    PIZZA_WORDS.some((w) => s.includes(w)) ||
    BURGER_WORDS.some((w) => s.includes(w))
  )
}

// Classifica um resultado: tipo do Places (v1) → palavra no nome → catch-all.
function classificarSetor(nome: string, primaryType?: string): string {
  if (primaryType === 'pizza_restaurant') return 'Pizzaria'
  if (primaryType === 'hamburger_restaurant') return 'Hamburgueria'
  const n = norm(nome)
  if (PIZZA_WORDS.some((w) => n.includes(w))) return 'Pizzaria'
  if (BURGER_WORDS.some((w) => n.includes(w))) return 'Hamburgueria'
  return 'Restaurante' // o que sobra
}

async function textSearch(
  setor: string,
  bairro: string,
  key: string,
  max: number,
): Promise<PlaceResult[]> {
  const textQuery = `${setor} em ${bairro}, São Paulo`
  const results: PlaceResult[] = []
  let pageToken: string | null = null
  do {
    // A New API exige que a requisição paginada repita o MESMO corpo da busca
    // inicial + o pageToken (o contrário da legada). pageSize 20 = máx por página.
    const body: Record<string, unknown> = {
      textQuery,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
    }
    if (pageToken) body.pageToken = pageToken

    const resp = await fetch(PLACES_NEW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    if (!resp.ok) {
      const msg = data?.error?.message ?? `HTTP ${resp.status}`
      throw new Error(`Places searchText: ${msg}`)
    }
    for (const p of (data.places ?? []) as NewPlace[]) {
      const mapped = mapNewPlace(p)
      if (mapped) results.push(mapped)
    }
    pageToken = data.nextPageToken ?? null
    // O pageToken da New API costuma valer de imediato, mas damos uma folga curta.
    if (pageToken && results.length < max) await sleep(1500)
    else pageToken = null
  } while (pageToken && results.length < max)
  return results.slice(0, max)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Só um membro logado dispara (Google Places é COBRADO por requisição). A anon
  // key — que vive no bundle do frontend — é um JWT válido mas SEM usuário, então
  // sem este gate qualquer um poderia varrer o endpoint e gastar o billing.
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const googleKey =
    Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY')
  if (!googleKey) {
    return json({ error: 'GOOGLE_PLACES_API_KEY não configurada (supabase secrets set).' }, 500)
  }
  const scrapingdogKey = Deno.env.get('SCRAPINGDOG_API_KEY')

  let setor: string
  let bairro: string
  let max: number
  let comSeguidores: boolean
  try {
    const body = await req.json()
    setor = String(body.setor ?? '').trim()
    bairro = String(body.bairro ?? '').trim()
    max = Math.min(Math.max(Number(body.max) || 20, 1), 60)
    comSeguidores = Boolean(body.comSeguidores)
    if (!setor) return json({ error: 'Informe um setor.' }, 400)
    if (!bairro) return json({ error: 'Informe um bairro.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  // Service role: função protegida por JWT; aqui escrevemos ignorando a RLS.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    const places = await textSearch(setor, bairro, googleKey, max)
    if (places.length === 0) return json({ inserted: 0, updated: 0, total: 0 })

    // Separa INSERT de UPDATE para não resetar campos do funil (status, notas)
    // nem dados manuais (instagram_followers/handle, setor) em re-buscas.
    const ids = places.map((p) => p.place_id)
    const { data: existingRows, error: selErr } = await supabase
      .from('leads')
      .select('google_place_id, instagram_handle, setor')
      .in('google_place_id', ids)
    if (selErr) throw selErr
    const existing = new Map((existingRows ?? []).map((r) => [r.google_place_id, r]))

    const toInsert: Record<string, unknown>[] = []
    const updates: { placeId: string; patch: Record<string, unknown> }[] = []
    // place_id -> handle, para a etapa opcional de seguidores
    const handles = new Map<string, string>()

    // Numa busca da família restaurante, cada resultado é classificado em
    // Pizzaria / Hamburgueria / Restaurante; senão, usa o setor buscado.
    const familia = ehFamiliaRestaurante(setor)

    for (const p of places) {
      // telefone/site/horário já vêm no searchText (New API) — sem 2ª chamada paga.
      const website = p.website
      const handle = instagramHandleFromUrl(website)
      if (handle) handles.set(p.place_id, handle)
      const setorLead = familia ? classificarSetor(p.name, p.primaryType ?? undefined) : setor

      const googleFields = {
        nome: p.name,
        endereco: p.formatted_address,
        lat: p.lat,
        lng: p.lng,
        telefone: p.telefone,
        website,
        rating: p.rating,
        reviews_count: p.user_ratings_total,
        horario_funcionamento: p.weekday_text,
      }

      const prev = existing.get(p.place_id)
      if (!prev) {
        // Bairro REAL do endereço (o Google devolve resultados de bairros
        // vizinhos; o termo pesquisado é só fallback — ISSUE-002). Idem cidade.
        const parsed = parseEnderecoFormatado(p.formatted_address ?? null)
        toInsert.push({
          ...googleFields,
          bairro: parsed?.bairro ?? bairro,
          ...(parsed?.cidade ? { cidade: parsed.cidade } : {}),
          setor: setorLead,
          google_place_id: p.place_id,
          instagram_handle: handle,
          status: 'descoberto',
        })
      } else {
        const patch: Record<string, unknown> = { ...googleFields }
        if (handle && !prev.instagram_handle) patch.instagram_handle = handle
        if (!prev.setor) patch.setor = setorLead // não sobrescreve setor já definido
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

    // Etapa opcional: seguidores do Instagram (consome créditos do Scrapingdog).
    if (comSeguidores && scrapingdogKey && handles.size > 0) {
      for (const [placeId, handle] of handles) {
        const followers = await buscarSeguidores(handle, scrapingdogKey)
        if (followers != null) {
          await supabase
            .from('leads')
            .update({ instagram_followers: followers })
            .eq('google_place_id', placeId)
        }
      }
    }

    return json({ inserted, updated, total: places.length })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Erro desconhecido'
    return json({ error: message }, 502)
  }
})
