// Edge Function: encontrar-whatsapp
// =============================================================================
// Módulo WhatsApp (Parte A): descobre um número WhatsApp-able de UM lead, com
// waterfall e provenance. Roda no servidor (Deno). As chaves NUNCA vão pro
// frontend — são secrets:
//   supabase secrets set SCRAPINGDOG_API_KEY=...   (opcional; só p/ bio do Insta)
//
// Waterfall (para na primeira fonte confiável):
//   1. telefone do Google  → só se for CELULAR (fixo não é whatsapp-able aqui)
//   2. bio/link do Instagram (Scrapingdog, best-effort)
//   3. site (SÓ links explícitos: wa.me / api.whatsapp.com / whatsapp:// / tel:
//      celular — nunca texto cru do HTML, onde floats de JS viram "telefones")
//
// ANTI-INVENÇÃO: nada de fabricar dígitos. Sem candidato confiável → whatsapp_phone
// = null + whatsapp_status = 'missing'. Não re-processa quem já tem número (salvo
// force), pra não gastar crédito do Scrapingdog à toa.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  normalizeBrazilPhone,
  whatsappFromUrl,
  findWhatsappInText,
  findWhatsappInHtml,
} from '../_shared/phone.ts'
import { safeFetchHtml } from '../_shared/ssrf.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'

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

type WhatsappSource = 'google' | 'instagram' | 'website'

interface Found {
  phone: string
  source: WhatsappSource
}

// --- Fonte 2: bio/link do Instagram via Scrapingdog (best-effort) ------------
async function fromInstagram(handle: string, apiKey: string): Promise<string | null> {
  const username = handle.replace(/^@/, '').trim()
  if (!username) return null
  try {
    const url = `https://api.scrapingdog.com/instagram/profile?api_key=${apiKey}&username=${encodeURIComponent(username)}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    // O formato varia entre versões — tentamos os campos prováveis de bio/link.
    const bio =
      data?.biography ??
      data?.bio ??
      data?.user?.biography ??
      data?.data?.biography ??
      ''
    const externalUrl =
      data?.external_url ??
      data?.bio_links?.[0]?.url ??
      data?.user?.external_url ??
      data?.data?.external_url ??
      null
    return whatsappFromUrl(externalUrl) ?? findWhatsappInText(String(bio))
  } catch {
    return null
  }
}

// --- Fonte 3: site (SÓ links explícitos de WhatsApp/tel) ---------------------
// safeFetchHtml (em _shared/ssrf.ts) faz a guarda anti-SSRF: allowlist de
// protocolo, resolução de DNS barrando IPs internos/loopback/link-local, e
// revalidação de cada redirect. `website` é entrada NÃO confiável (tabela leads).
// findWhatsappInHtml é links-only: a varredura de texto cru fabricava números a
// partir de floats de JS (ISSUE-001 — Margherita/Cristal Pizza).
async function fromWebsite(website: string): Promise<string | null> {
  try {
    const html = await safeFetchHtml(website)
    return html ? findWhatsappInHtml(html) : null
  } catch {
    return null
  }
}

async function discover(
  lead: {
    telefone: string | null
    instagram_handle: string | null
    website: string | null
  },
  scrapingdogKey: string | undefined,
): Promise<Found | null> {
  // 1) Google: só celular conta como WhatsApp-able.
  const g = normalizeBrazilPhone(lead.telefone)
  if (g && g.kind === 'mobile') return { phone: g.e164, source: 'google' }

  // 2) Instagram (best-effort, só com chave).
  if (lead.instagram_handle && scrapingdogKey) {
    const ig = await fromInstagram(lead.instagram_handle, scrapingdogKey)
    if (ig) return { phone: ig, source: 'instagram' }
  }

  // 3) Site.
  if (lead.website) {
    const w = await fromWebsite(lead.website)
    if (w) return { phone: w, source: 'website' }
  }

  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Só um membro logado dispara (gasta créditos de scraping).
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const scrapingdogKey = Deno.env.get('SCRAPINGDOG_API_KEY')

  let leadId: string
  let force = false
  try {
    const body = await req.json()
    leadId = String(body.lead_id ?? '')
    force = Boolean(body.force)
    if (!leadId) return json({ error: 'Informe lead_id.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select('id, telefone, instagram_handle, website, whatsapp_phone, status')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // Já tem número e sem force → não reprocessa (economiza crédito Scrapingdog).
  if (lead.whatsapp_phone && !force) {
    return json({ lead, skipped: true })
  }

  try {
    const found = await discover(lead, scrapingdogKey)

    const patch = found
      ? { whatsapp_phone: found.phone, whatsapp_source: found.source, whatsapp_status: 'found' }
      : { whatsapp_phone: null, whatsapp_source: null, whatsapp_status: 'missing' }

    const { data: updated, error: updErr } = await supabase
      .from('leads')
      .update(patch)
      .eq('id', leadId)
      .select('*')
      .single()
    if (updErr) throw updErr

    return json({ lead: updated, whatsapp_status: patch.whatsapp_status, source: found?.source ?? null })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Erro desconhecido'
    return json({ error: message }, 502)
  }
})
