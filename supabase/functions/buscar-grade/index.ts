// Edge Function: buscar-grade
// =============================================================================
// BUSCA EM MASSA por GRADE (Fase 1 do mass-scraping). Quebra o teto de 60
// resultados/consulta do Places ladrilhando uma área (centro + raio) numa grade
// de células e rodando uma busca por célula com `locationRestriction` (retângulo).
// A soma das células densas escala pra centenas/milhares por área.
//
// PROCESSAMENTO EM LOTE (cursor): a grade inteira não cabe em uma invocação
// (timeout + páginas com sleep). Cada chamada processa `tilesPerCall` células a
// partir de `cursor` e devolve o próximo cursor + progresso; o frontend chama em
// loop até `done`. Determinística (gerarGrade) → o cursor é só um índice.
//
// CUSTO: Places é cobrado por requisição. O frontend mostra estimarCusto() ANTES
// de rodar; aqui há tetos (tilesPerCall, maxTermos, maxPaginas) e dedup por
// place_id (UPSERT por google_place_id nunca re-cobra lead já existente).
//
// Secret: GOOGLE_PLACES_API_KEY (ou GOOGLE_MAPS_API_KEY). Auth: usuário logado.
//   supabase functions deploy buscar-grade --no-verify-jwt  (faz o próprio gate)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { parseEnderecoFormatado } from '../_shared/endereco.ts'
import {
  classificarSetor,
  ehFamiliaRestaurante,
  expandirTermosBusca,
} from '../_shared/busca_setor.ts'
import {
  bboxDeCentroRaio,
  gerarGrade,
  type Celula,
  type Retangulo,
} from '../_shared/geo_grid.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

function instagramHandleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/instagram\.com\/([A-Za-z0-9._]+)/i)
  if (!m) return null
  const reserved = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv'])
  return reserved.has(m[1].toLowerCase()) ? null : m[1]
}

function mapNewPlace(p: NewPlace): PlaceResult | null {
  if (!p.id || !p.displayName?.text) return null
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

// Uma busca textSearch DENTRO de um retângulo (célula da grade), paginada. A
// `locationRestriction.rectangle` confina os resultados à célula — é o que
// permite varrer a cidade inteira somando células sem o teto global de 60.
async function buscarNaCelula(
  termo: string,
  rect: Retangulo,
  key: string,
  maxPaginas: number,
): Promise<{ places: PlaceResult[]; requisicoes: number }> {
  const places: PlaceResult[] = []
  let pageToken: string | null = null
  let requisicoes = 0
  let pagina = 0
  do {
    const body: Record<string, unknown> = {
      textQuery: termo,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
      locationRestriction: {
        rectangle: {
          low: { latitude: rect.low.lat, longitude: rect.low.lng },
          high: { latitude: rect.high.lat, longitude: rect.high.lng },
        },
      },
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
    requisicoes++
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      const msg = (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${resp.status}`
      throw new Error(`Places searchText (célula): ${msg}`)
    }
    for (const p of ((data as { places?: NewPlace[] }).places ?? [])) {
      const mapped = mapNewPlace(p)
      if (mapped) places.push(mapped)
    }
    pageToken = (data as { nextPageToken?: string }).nextPageToken ?? null
    pagina++
    if (pageToken && pagina < maxPaginas) await sleep(1500)
    else pageToken = null
  } while (pageToken && pagina < maxPaginas)
  return { places, requisicoes }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const googleKey = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY')
  if (!googleKey) return json({ error: 'GOOGLE_PLACES_API_KEY não configurada.' }, 500)

  let setor: string
  let centerLat: number
  let centerLng: number
  let raioKm: number
  let cellKm: number
  let cursor: number
  let tilesPerCall: number
  let maxTermos: number
  let maxPaginas: number
  try {
    const b = await req.json()
    setor = String(b.setor ?? '').trim()
    centerLat = Number(b.centerLat)
    centerLng = Number(b.centerLng)
    raioKm = Math.min(Math.max(Number(b.raioKm) || 10, 1), 300)
    cellKm = Math.min(Math.max(Number(b.cellKm) || 2, 0.5), 50)
    cursor = Math.max(Number(b.cursor) || 0, 0)
    tilesPerCall = Math.min(Math.max(Number(b.tilesPerCall) || 10, 1), 25)
    maxTermos = Math.min(Math.max(Number(b.maxTermos) || 2, 1), 3)
    maxPaginas = Math.min(Math.max(Number(b.maxPaginas) || 2, 1), 3)
    if (!setor) return json({ error: 'Informe um setor.' }, 400)
    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
      return json({ error: 'Informe centerLat e centerLng.' }, 400)
    }
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const bbox = bboxDeCentroRaio(centerLat, centerLng, raioKm)
  const grade: Celula[] = gerarGrade(bbox, cellKm)
  const totalTiles = grade.length
  const lote = grade.slice(cursor, cursor + tilesPerCall)
  const termos = expandirTermosBusca(setor).slice(0, maxTermos)
  if (termos.length === 0) return json({ error: 'Setor inválido.' }, 400)
  const familia = ehFamiliaRestaurante(setor)

  try {
    // 1) Coleta candidatos do lote de células, dedupando por place_id no lote.
    const candidatos = new Map<string, PlaceResult>()
    let requisicoes = 0
    for (const cel of lote) {
      for (const termo of termos) {
        const { places, requisicoes: reqs } = await buscarNaCelula(termo, cel, googleKey, maxPaginas)
        requisicoes += reqs
        for (const p of places) if (!candidatos.has(p.place_id)) candidatos.set(p.place_id, p)
      }
    }

    const found = candidatos.size
    let inserted = 0
    if (found > 0) {
      // 2) Dedup contra o banco: só insere place_ids que ainda não existem
      //    (UPSERT por google_place_id; mass-scraping é net-new — não mexe no
      //    funil/dados de quem já está na base).
      const ids = [...candidatos.keys()]
      const existentes = new Set<string>()
      // .in() em lotes de 200 pra não estourar a URL.
      for (let i = 0; i < ids.length; i += 200) {
        const fatia = ids.slice(i, i + 200)
        const { data, error } = await supabase
          .from('leads')
          .select('google_place_id')
          .in('google_place_id', fatia)
        if (error) throw error
        for (const r of data ?? []) existentes.add(r.google_place_id as string)
      }

      const novos: Record<string, unknown>[] = []
      for (const p of candidatos.values()) {
        if (existentes.has(p.place_id)) continue
        const parsed = parseEnderecoFormatado(p.formatted_address ?? null)
        novos.push({
          nome: p.name,
          endereco: p.formatted_address,
          lat: p.lat,
          lng: p.lng,
          telefone: p.telefone,
          website: p.website,
          rating: p.rating,
          reviews_count: p.user_ratings_total,
          horario_funcionamento: p.weekday_text,
          bairro: parsed?.bairro ?? null,
          cidade: parsed?.cidade ?? null,
          setor: familia ? classificarSetor(p.name, p.primaryType ?? undefined) : setor,
          google_place_id: p.place_id,
          instagram_handle: instagramHandleFromUrl(p.website),
          whatsapp_status: 'pending',
          status: 'descoberto',
        })
      }
      if (novos.length > 0) {
        // upsert ignorando duplicados (corrida entre lotes paralelos).
        const { error } = await supabase
          .from('leads')
          .upsert(novos, { onConflict: 'google_place_id', ignoreDuplicates: true })
        if (error) throw error
        inserted = novos.length
      }
    }

    const proximoCursor = cursor + lote.length
    const done = proximoCursor >= totalTiles
    return json({
      done,
      cursor: proximoCursor,
      total_tiles: totalTiles,
      tiles_processed: lote.length,
      found,
      inserted,
      requisicoes,
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, 502)
  }
})
