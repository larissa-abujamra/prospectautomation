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
//   3. site (varre HTML por links wa.me / api.whatsapp.com)
//
// Além do número, quando a bio do Instagram é buscada, classifica os sinais de
// qualificação (Fase 3 do Macro 1): bio_ponto_fisico, bio_linktree,
// bio_whatsapp_vendas, bio_delivery_proprio + lead_score.
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
} from '../_shared/phone.ts'
import { safeFetchHtml } from '../_shared/ssrf.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { calcularLeadScore } from '../_shared/lead_score.ts'

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

// Sinais classificados a partir da bio do Instagram.
interface BioSinais {
  linktree: boolean
  whatsappVendas: boolean
  deliveryProprio: boolean
}

// Normaliza texto para matching: minúsculas + remove acentos.
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// Classifica os sinais de qualificação a partir do texto da bio e do
// external_url do perfil do Instagram. Sem nova chamada de API — usa o que já
// foi buscado para a descoberta do número de WhatsApp.
//
// ANTI-FALSO-POSITIVO:
//   bio_whatsapp_vendas: link wa.me/api.whatsapp.com/wa.link OU frase de intenção
//     de venda próxima a "whats". Número solto NÃO basta.
//   bio_delivery_proprio: frases de entrega própria ("entregamos", "delivery
//     próprio" etc.). Bio com APENAS agregador (iFood/Rappi/Uber Eats) → FALSE.
//   bio_linktree: linktr.ee / linktree / beacons / linkbio no texto ou external_url.
export function classificarBioSinais(bio: string, externalUrl: string | null): BioSinais {
  const t = norm(bio)
  const extNorm = externalUrl ? norm(externalUrl) : ''

  // --- linktree ---
  const linktree =
    /linktr\.ee|linktree|beacons\.|linkbio/.test(t) ||
    /linktr\.ee|linktree|beacons\.|linkbio/.test(extNorm)

  // --- whatsappVendas ---
  // Link direto de WhatsApp na bio ou no external_url
  const temLinkWA =
    /wa\.me|api\.whatsapp\.com|wa\.link/.test(t) ||
    /wa\.me|api\.whatsapp\.com|wa\.link/.test(extNorm)
  // Frases de intenção de venda (pedido/encomenda/atendimento via WhatsApp)
  const temFraseVenda =
    /pedidos?\s+pelo\s+whats|pe[cç]a?\s+pelo\s+whatsapp|encomendas?\s+pelo\s+whatsapp|chama\s+no\s+whats|whatsapp\s+para\s+pedidos|pelo\s+whats|via\s+whatsapp/.test(t)
  const whatsappVendas = temLinkWA || temFraseVenda

  // --- deliveryProprio ---
  // Frases que indicam entrega feita pelo próprio negócio
  const temEntregaPropria =
    /delivery\s+pr[oó]prio|entregamos|fazemos\s+entrega|tele.?entrega/.test(t)
  // Bio contém APENAS referência a agregadores (sem entrega própria) → FALSE
  // Se tiver as frases acima, é TRUE mesmo que mencione agregador também.
  const deliveryProprio = temEntregaPropria

  return { linktree, whatsappVendas, deliveryProprio }
}

// --- Fonte 2: bio/link do Instagram via Scrapingdog (best-effort) ------------
// Retorna o número de WhatsApp encontrado E os dados brutos da bio para
// classificação de sinais (mesma chamada, sem custo extra de API).
async function fromInstagram(
  handle: string,
  apiKey: string,
): Promise<{ phone: string | null; bio: string; externalUrl: string | null }> {
  const username = handle.replace(/^@/, '').trim()
  if (!username) return { phone: null, bio: '', externalUrl: null }
  try {
    const url = `https://api.scrapingdog.com/instagram/profile?api_key=${apiKey}&username=${encodeURIComponent(username)}`
    const resp = await fetch(url)
    if (!resp.ok) return { phone: null, bio: '', externalUrl: null }
    const data = await resp.json()
    // O formato varia entre versões — tentamos os campos prováveis de bio/link.
    const bio: string =
      data?.biography ??
      data?.bio ??
      data?.user?.biography ??
      data?.data?.biography ??
      ''
    const externalUrl: string | null =
      data?.external_url ??
      data?.bio_links?.[0]?.url ??
      data?.user?.external_url ??
      data?.data?.external_url ??
      null
    const phone = whatsappFromUrl(externalUrl) ?? findWhatsappInText(String(bio))
    return { phone, bio: String(bio), externalUrl }
  } catch {
    return { phone: null, bio: '', externalUrl: null }
  }
}

// --- Fonte 3: site (varre HTML por links de WhatsApp) ------------------------
// safeFetchHtml (em _shared/ssrf.ts) faz a guarda anti-SSRF: allowlist de
// protocolo, resolução de DNS barrando IPs internos/loopback/link-local, e
// revalidação de cada redirect. `website` é entrada NÃO confiável (tabela leads).
async function fromWebsite(website: string): Promise<string | null> {
  try {
    const html = await safeFetchHtml(website)
    return html ? findWhatsappInText(html) : null
  } catch {
    return null
  }
}

// Resultado de discover: número WA + bio do Instagram (quando buscada).
interface DiscoverResult {
  found: Found | null
  // Definido quando o Instagram foi consultado (ramo 2 do waterfall).
  igBio: string | null
  igExternalUrl: string | null
}

async function discover(
  lead: {
    telefone: string | null
    instagram_handle: string | null
    website: string | null
  },
  scrapingdogKey: string | undefined,
): Promise<DiscoverResult> {
  // 1) Google: só celular conta como WhatsApp-able.
  const g = normalizeBrazilPhone(lead.telefone)
  if (g && g.kind === 'mobile') {
    return { found: { phone: g.e164, source: 'google' }, igBio: null, igExternalUrl: null }
  }

  // 2) Instagram (best-effort, só com chave).
  if (lead.instagram_handle && scrapingdogKey) {
    const ig = await fromInstagram(lead.instagram_handle, scrapingdogKey)
    const found = ig.phone ? { phone: ig.phone, source: 'instagram' as const } : null
    // Bio retornada mesmo sem número — sinais de qualificação classificados a seguir.
    return { found, igBio: ig.bio, igExternalUrl: ig.externalUrl }
  }

  // 3) Site.
  if (lead.website) {
    const w = await fromWebsite(lead.website)
    if (w) return { found: { phone: w, source: 'website' }, igBio: null, igExternalUrl: null }
  }

  return { found: null, igBio: null, igExternalUrl: null }
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

  // Inclui endereco (para bio_ponto_fisico) e os sinais já gravados (para
  // recalcular o score completo caso este ramo não consulte o Instagram).
  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select(
      'id, telefone, instagram_handle, website, whatsapp_phone, status, endereco, ' +
      'bio_ponto_fisico, bio_delivery_proprio, bio_whatsapp_vendas, bio_linktree',
    )
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // Já tem número e sem force → não reprocessa (economiza crédito Scrapingdog).
  if (lead.whatsapp_phone && !force) {
    return json({ lead, skipped: true })
  }

  try {
    const { found, igBio, igExternalUrl } = await discover(lead, scrapingdogKey)

    const patch: Record<string, unknown> = found
      ? { whatsapp_phone: found.phone, whatsapp_source: found.source, whatsapp_status: 'found' }
      : { whatsapp_phone: null, whatsapp_source: null, whatsapp_status: 'missing' }

    // --- Sinais de qualificação ---
    // bio_ponto_fisico: derivado do Google Places (endereço presente no lead).
    const pontoFisico = !!(lead.endereco && lead.endereco.trim())
    patch.bio_ponto_fisico = pontoFisico

    if (igBio !== null) {
      // Instagram foi consultado — classificar os 3 sinais derivados da bio.
      const sinais = classificarBioSinais(igBio, igExternalUrl)
      patch.bio_linktree = sinais.linktree
      patch.bio_whatsapp_vendas = sinais.whatsappVendas
      patch.bio_delivery_proprio = sinais.deliveryProprio
      patch.lead_score = calcularLeadScore({
        pontoFisico,
        deliveryProprio: sinais.deliveryProprio,
        whatsappVendas: sinais.whatsappVendas,
      })
    } else {
      // Instagram não consultado (Google phone encontrado ou sem handle/chave):
      // usa os sinais já gravados no banco para não regredir um score anterior.
      const deliveryProprio = lead.bio_delivery_proprio ?? false
      const whatsappVendas = lead.bio_whatsapp_vendas ?? false
      patch.lead_score = calcularLeadScore({ pontoFisico, deliveryProprio, whatsappVendas })
    }

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
