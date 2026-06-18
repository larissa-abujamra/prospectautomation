// Edge Function: resolver-place-rf
// =============================================================================
// Ponte de "sendability" dos leads da Receita (origem 'rf_cnpj'): eles entram
// SEM google_place_id, e o HubSpot usa place_id como chave de dedup (idProperty),
// então sem ele não dá pra disparar. Aqui buscamos o lead no Google Places por
// nome + cidade, casamos por similaridade de nome e, com match confiável,
// preenchemos google_place_id + dados do Google (endereço, site, telefone,
// rating…). Aí o lead vira sendable e segue o fluxo normal (descoberta de
// WhatsApp + hubspot-sync).
//
// ANTI-INVENÇÃO: sem match confiável → NÃO grava place_id (resolved=false). Nunca
// liga o lead a um Place errado. Auth: usuário logado OU segredo interno (batch).
// Deploy --no-verify-jwt.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { nomeSimilaridade } from '../_shared/cnpj_match.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const PLACES_NEW_URL = 'https://places.googleapis.com/v1/places:searchText'
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.rating', 'places.userRatingCount', 'places.nationalPhoneNumber',
  'places.internationalPhoneNumber', 'places.websiteUri',
  'places.regularOpeningHours.weekdayDescriptions',
].join(',')

// Match mínimo de nome p/ aceitar o Place como o mesmo negócio (anti-invenção).
const SIM_MIN = 0.55

interface PlaceCand {
  id?: string
  displayName?: { text?: string }
  formattedAddress?: string
  location?: { latitude?: number; longitude?: number }
  rating?: number
  userRatingCount?: number
  nationalPhoneNumber?: string
  internationalPhoneNumber?: string
  websiteUri?: string
  regularOpeningHours?: { weekdayDescriptions?: string[] }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const segredo = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  const autorizado =
    (!!segredo && req.headers.get('x-olivia-secret') === segredo) ||
    (await requireAuthenticatedUser(req))
  if (!autorizado) return json({ error: 'Autenticação obrigatória.' }, 401)

  const key = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_API_KEY')
  if (!key) return json({ error: 'GOOGLE_PLACES_API_KEY não configurada.' }, 500)

  let leadId: string
  try {
    leadId = String((await req.json()).lead_id ?? '')
    if (!leadId) return json({ error: 'Informe lead_id.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: lead, error } = await supabase
    .from('leads')
    .select('id, nome, razao_social, cidade, bairro, google_place_id, telefone, website, cnpj, dono_nome, socios')
    .eq('id', leadId).single()
  if (error || !lead) return json({ error: 'Lead não encontrado.' }, 404)
  if (lead.google_place_id) return json({ resolved: true, already: true, place_id: lead.google_place_id })

  const cidade = (lead.cidade as string | null)?.trim() || 'São Paulo'
  const termo = [lead.nome, lead.bairro, cidade].filter(Boolean).join(', ')

  try {
    const resp = await fetch(PLACES_NEW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({ textQuery: termo, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 5 }),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return json({ error: `Places: ${(data as { error?: { message?: string } })?.error?.message ?? resp.status}` }, 502)
    }
    const cands = ((data as { places?: PlaceCand[] }).places ?? [])

    // Melhor candidato por similaridade de nome (vs nome + razão social do lead).
    let best: { p: PlaceCand; sim: number } | null = null
    for (const p of cands) {
      const nome = p.displayName?.text ?? ''
      const sim = Math.max(
        nomeSimilaridade(String(lead.nome ?? ''), nome, null),
        lead.razao_social ? nomeSimilaridade(String(lead.razao_social), nome, null) : 0,
      )
      if (!best || sim > best.sim) best = { p, sim }
    }

    if (!best || best.sim < SIM_MIN || !best.p.id) {
      return json({ resolved: false, motivo: 'sem match confiável no Google', melhor_sim: best?.sim ?? 0 })
    }

    const p = best.p

    // COLISÃO: o place já é outro lead (google_place_id é UNIQUE). O lead RF é
    // duplicata de um já existente (provável: já veio do Places). Em vez de
    // falhar na constraint, MESCLA o que a Receita agrega (CNPJ/dono/razão/sócios,
    // só onde o existente está vazio) no lead canônico e remove a duplicata RF.
    const { data: existente } = await supabase
      .from('leads').select('id, cnpj, dono_nome, razao_social, socios')
      .eq('google_place_id', p.id).neq('id', leadId).maybeSingle()
    if (existente) {
      const merge: Record<string, unknown> = {}
      if (!existente.cnpj && lead.cnpj) merge.cnpj = lead.cnpj
      if (!existente.dono_nome && lead.dono_nome) merge.dono_nome = lead.dono_nome
      if (!existente.razao_social && lead.razao_social) merge.razao_social = lead.razao_social
      if (!existente.socios && lead.socios) merge.socios = lead.socios
      if (Object.keys(merge).length > 0) {
        await supabase.from('leads').update(merge).eq('id', existente.id)
      }
      await supabase.from('leads').delete().eq('id', leadId)
      return json({ resolved: false, duplicate: true, merged_into: existente.id, place_id: p.id })
    }

    // Preenche place_id + dados do Google. Não sobrescreve telefone/site já
    // existentes (RF pode já ter trazido) — só completa o que falta.
    const patch: Record<string, unknown> = {
      google_place_id: p.id,
      endereco: p.formattedAddress ?? null,
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      rating: p.rating ?? null,
      reviews_count: p.userRatingCount ?? null,
      horario_funcionamento: p.regularOpeningHours?.weekdayDescriptions ?? null,
    }
    if (!lead.telefone) patch.telefone = p.nationalPhoneNumber ?? p.internationalPhoneNumber ?? null
    if (!lead.website) patch.website = p.websiteUri ?? null

    const { error: updErr } = await supabase.from('leads').update(patch).eq('id', leadId)
    if (updErr) throw updErr

    return json({ resolved: true, place_id: p.id, nome_google: p.displayName?.text ?? null, sim: best.sim })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, 502)
  }
})
