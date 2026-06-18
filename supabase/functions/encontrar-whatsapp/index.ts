// Edge Function: encontrar-whatsapp
// =============================================================================
// Módulo WhatsApp (Parte A): descobre um número WhatsApp-able de UM lead, com
// waterfall e provenance. Roda no servidor (Deno). As chaves NUNCA vão pro
// frontend — são secrets:
//   supabase secrets set SCRAPINGDOG_API_KEY=...   (opcional; só p/ bio do Insta)
//   supabase secrets set PERPLEXITY_API_KEY=...    (opcional; fonte 4, Sonar direto)
//   supabase secrets set OPENROUTER_API_KEY=...    (fallback da fonte 4: o mesmo
//                                                   sonar-pro servido via OpenRouter)
//
// Waterfall (para na primeira fonte confiável):
//   1. telefone do Google  → só se for CELULAR (fixo não é whatsapp-able aqui)
//   2. bio/link do Instagram (Scrapingdog, best-effort)
//   3. site (varre HTML por links wa.me / api.whatsapp.com)
//   4. Perplexity Sonar (busca web; resposta validada — só celular BR conta).
//      De brinde, o Sonar pode achar o @instagram/site de quem não tinha.
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
  findWhatsappInHtml,
  findWhatsappNearKeyword,
  extrairDddE164,
} from '../_shared/phone.ts'
import { extractContactLinks } from '../_shared/contact_pages.ts'
import { safeFetchHtml } from '../_shared/ssrf.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { calcularLeadScore } from '../_shared/lead_score.ts'
import {
  consultarPerplexityLead,
  resolverProvedorSonar,
  type SonarProvider,
} from '../_shared/perplexity.ts'
import { classificarBioSinais } from '../_shared/bio_sinais.ts'
import { isWhatsappDiscoveryStale } from '../_shared/whatsapp_rediscovery.ts'

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

type WhatsappSource = 'google' | 'instagram' | 'website' | 'perplexity'

interface Found {
  phone: string
  source: WhatsappSource
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
    // TODOS os bio_links (perfis comerciais costumam ter vários; o wa.me pode
    // não ser o primeiro) + o external_url legado.
    const bioLinks: unknown[] = Array.isArray(data?.bio_links) ? data.bio_links : []
    let linkPhone: string | null = null
    for (const l of bioLinks) {
      const u = (l as { url?: unknown } | null)?.url
      const hit = whatsappFromUrl(typeof u === 'string' ? u : null)
      if (hit) {
        linkPhone = hit
        break
      }
    }
    const externalUrl: string | null =
      data?.external_url ??
      (typeof (bioLinks[0] as { url?: unknown } | null)?.url === 'string'
        ? String((bioLinks[0] as { url?: unknown }).url)
        : null) ??
      data?.user?.external_url ??
      data?.data?.external_url ??
      null
    const phone = linkPhone ?? whatsappFromUrl(externalUrl) ?? findWhatsappInText(String(bio))
    return { phone, bio: String(bio), externalUrl }
  } catch {
    return { phone: null, bio: '', externalUrl: null }
  }
}

// --- Fonte 3: site (links explícitos + texto visível com palavra-chave) ------
// safeFetchHtml (em _shared/ssrf.ts) faz a guarda anti-SSRF: allowlist de
// protocolo, resolução de DNS barrando IPs internos/loopback/link-local, e
// revalidação de cada redirect. `website` é entrada NÃO confiável (tabela leads).
//
// Ordem por confiabilidade, na home e em até 2 páginas de contato (mesma origem):
//   a) findWhatsappInHtml — links wa.me/api.whatsapp/whatsapp://, tel: celular
//   b) findWhatsappNearKeyword — celular em texto VISÍVEL perto de "whatsapp/
//      wpp/zap" (scripts/styles descartados; floats/UUIDs barrados)
// NUNCA varre o texto cru do HTML (findWhatsappInText é só p/ bio do Instagram):
// floats de JS viravam celulares fabricados que recebiam template real.
async function fromWebsite(website: string): Promise<string | null> {
  // maxBytes alto: links wa.me e telefones moram no RODAPÉ, e páginas de
  // e-commerce passam fácil de 500 KB — o cap default truncava antes do fim.
  const FETCH_OPTS = { maxBytes: 4_000_000 }
  try {
    const html = await safeFetchHtml(website, FETCH_OPTS)
    if (!html) return null

    const direct = findWhatsappInHtml(html) ?? findWhatsappNearKeyword(html)
    if (direct) return direct

    // wa.me costuma morar em /contato, não na home. Mesma origem; cada fetch
    // revalida SSRF. Cap de 2 páginas para não estourar o tempo da função.
    for (const link of extractContactLinks(html, website).slice(0, 2)) {
      const sub = await safeFetchHtml(link, FETCH_OPTS)
      if (!sub) continue
      const found = findWhatsappInHtml(sub) ?? findWhatsappNearKeyword(sub)
      if (found) return found
    }
    return null
  } catch {
    return null
  }
}

// Resultado de discover: número WA + bio do Instagram (quando buscada) + extras
// que o Sonar pode ter achado (handle/site de quem não tinha).
interface DiscoverResult {
  found: Found | null
  // Definido quando o Instagram foi consultado (ramo 2 do waterfall).
  igBio: string | null
  igExternalUrl: string | null
  // Achados do Sonar (ramo 4) — só preenchidos quando ele rodou e validou.
  pplxInstagram: string | null
  pplxWebsite: string | null
}

async function discover(
  lead: {
    nome: string
    telefone: string | null
    instagram_handle: string | null
    website: string | null
    endereco: string | null
    cidade?: string | null
    setor?: string | null
  },
  scrapingdogKey: string | undefined,
  sonar: SonarProvider | null,
): Promise<DiscoverResult> {
  const vazio = { igBio: null, igExternalUrl: null, pplxInstagram: null, pplxWebsite: null }

  // 1) Google: só celular conta como WhatsApp-able.
  const g = normalizeBrazilPhone(lead.telefone)
  if (g && g.kind === 'mobile') {
    return { found: { phone: g.e164, source: 'google' }, ...vazio }
  }

  // 2) Instagram (best-effort, só com chave).
  let igBio: string | null = null
  let igExternalUrl: string | null = null
  if (lead.instagram_handle && scrapingdogKey) {
    const ig = await fromInstagram(lead.instagram_handle, scrapingdogKey)
    igBio = ig.bio
    igExternalUrl = ig.externalUrl
    if (ig.phone) {
      return { found: { phone: ig.phone, source: 'instagram' }, ...vazio, igBio, igExternalUrl }
    }
  }

  // 3) Site.
  if (lead.website) {
    const w = await fromWebsite(lead.website)
    if (w) return { found: { phone: w, source: 'website' }, ...vazio, igBio, igExternalUrl }
  }

  // 4) Perplexity Sonar (busca web; direto ou via OpenRouter). Resposta é
  // PROPOSTA: o módulo valida handle/URL e só aceita celular BR — nada
  // inventado passa.
  if (sonar) {
    const pplx = await consultarPerplexityLead(lead, sonar)
    const found = pplx.whatsapp ? { phone: pplx.whatsapp, source: 'perplexity' as const } : null
    return {
      found,
      igBio,
      igExternalUrl,
      pplxInstagram: pplx.instagram,
      pplxWebsite: pplx.website,
    }
  }

  return { found: null, ...vazio, igBio, igExternalUrl }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Só um membro logado dispara (gasta créditos de scraping).
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const scrapingdogKey = Deno.env.get('SCRAPINGDOG_API_KEY')
  // Fonte 4 (Sonar): Perplexity direto se houver chave; senão via OpenRouter.
  const sonar = resolverProvedorSonar({
    perplexityKey: Deno.env.get('PERPLEXITY_API_KEY'),
    openrouterKey: Deno.env.get('OPENROUTER_API_KEY'),
  })

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

  // Inclui endereco (bio_ponto_fisico), dono_nome (donoIdentificado) e os sinais
  // já gravados (para não regredir score caso este ramo não consulte Instagram).
  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select(
      'id, nome, cidade, setor, telefone, instagram_handle, website, whatsapp_phone, whatsapp_status, status, endereco, dono_nome, ' +
      'whatsapp_checked_at, bio_ponto_fisico, bio_delivery_proprio, bio_whatsapp_vendas, bio_linktree',
    )
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // Já tem número e sem force → não reprocessa (economiza crédito Scrapingdog).
  if (lead.whatsapp_phone && !force) {
    return json({ lead, skipped: true, whatsapp_status: lead.whatsapp_status })
  }

  // Já verificado como 'missing'/'invalid' e sem force → só reprocessa se ficou
  // stale. Sem isto, todo lote re-pagaria Scrapingdog + Sonar; com TTL, um
  // resultado antigo não bloqueia o lead para sempre.
  if (
    (lead.whatsapp_status === 'missing' || lead.whatsapp_status === 'invalid') &&
    !force &&
    !isWhatsappDiscoveryStale(lead.whatsapp_checked_at)
  ) {
    return json({ lead, skipped: true, whatsapp_status: lead.whatsapp_status })
  }

  try {
    const { found, igBio, igExternalUrl, pplxInstagram, pplxWebsite } = await discover(
      lead,
      scrapingdogKey,
      sonar,
    )

    // Cross-check de região: o DDD do número achado bate com a praça do lead?
    // Referência = DDD do telefone do Google Places (forte sinal regional, mesmo
    // quando é fixo). Negócios LOCAIS (nosso público) têm WhatsApp no mesmo DDD;
    // um DDD distante num número achado em site/Sonar costuma ser fornecedor/
    // agência (número errado). Não AUTO-rejeita (pode ser matriz fora do estado)
    // — sinaliza para revisão humana antes do disparo. 'google' é o próprio
    // telefone, então nunca diverge de si mesmo.
    const refDdd = extrairDddE164(lead.telefone)
    const foundDdd = found ? extrairDddE164(found.phone) : null
    const dddMismatch = !!(
      found && found.source !== 'google' && refDdd && foundDdd && refDdd !== foundDdd
    )

    const patch: Record<string, unknown> = found
      ? {
          whatsapp_phone: found.phone,
          whatsapp_source: found.source,
          whatsapp_status: 'found',
          whatsapp_checked_at: new Date().toISOString(),
          whatsapp_ddd_mismatch: dddMismatch,
        }
      : {
          whatsapp_phone: null,
          whatsapp_source: null,
          whatsapp_status: 'missing',
          whatsapp_checked_at: new Date().toISOString(),
          whatsapp_ddd_mismatch: false,
        }

    // Extras do Sonar: só preenchem o que estava VAZIO (nunca sobrescrevem dado
    // existente — o que já foi achado/curado tem precedência).
    if (pplxInstagram && !lead.instagram_handle) patch.instagram_handle = pplxInstagram
    if (pplxWebsite && !lead.website) patch.website = pplxWebsite

    // --- Sinais de qualificação ---
    // bio_ponto_fisico: derivado do Google Places (endereço presente no lead).
    const pontoFisico = !!(lead.endereco && lead.endereco.trim())
    patch.bio_ponto_fisico = pontoFisico

    // DESACOPLAMENTO bio↔telefone: a bio é buscada SEMPRE que existe handle,
    // independente do path pelo qual o telefone foi resolvido (Google/site/Instagram).
    // Se o waterfall já consultou o Instagram (igBio !== null), reusa — sem 2ª chamada.
    let bioFinal: string | null = igBio
    let extUrlFinal: string | null = igExternalUrl

    if (bioFinal === null && lead.instagram_handle && scrapingdogKey) {
      const igData = await fromInstagram(lead.instagram_handle, scrapingdogKey)
      if (igData.bio) {
        bioFinal = igData.bio
        extUrlFinal = igData.externalUrl
      }
    }

    const donoIdentificado = !!(lead.dono_nome && lead.dono_nome.trim())

    if (bioFinal) {
      // Bio disponível (Instagram consultado nesta execução ou no waterfall):
      // classifica os 3 sinais e calcula score com todos os 4 sinais.
      const sinais = classificarBioSinais(bioFinal, extUrlFinal)
      patch.bio_linktree = sinais.linktree
      patch.bio_whatsapp_vendas = sinais.whatsappVendas
      patch.bio_delivery_proprio = sinais.deliveryProprio
      patch.lead_score = calcularLeadScore({
        pontoFisico,
        deliveryProprio: sinais.deliveryProprio,
        whatsappVendas: sinais.whatsappVendas,
        donoIdentificado,
      })
    } else {
      // Sem bio (sem handle ou Scrapingdog falhou): usa sinais já gravados no banco
      // para não regredir um score anterior.
      const deliveryProprio = lead.bio_delivery_proprio ?? false
      const whatsappVendas = lead.bio_whatsapp_vendas ?? false
      patch.lead_score = calcularLeadScore({ pontoFisico, deliveryProprio, whatsappVendas, donoIdentificado })
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
