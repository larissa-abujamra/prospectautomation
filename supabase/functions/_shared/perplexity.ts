// Enriquecimento via Perplexity Sonar (busca na web com citações).
// =============================================================================
// A parte PURA (parse/validação/escolha de provedor) é unit-testada no Vitest;
// o fetch fica em `consultarPerplexityLead`, usado pela Edge Function
// `encontrar-whatsapp` como última fonte do waterfall (Instagram + WhatsApp +
// site do negócio).
//
// PROVEDOR: o Sonar pode ser chamado direto na Perplexity OU via OpenRouter
// (mesmo formato OpenAI; o projeto já usa OpenRouter pra LLM). Preferência:
//   supabase secrets set PERPLEXITY_API_KEY=pplx-...     (direto, se houver)
//   supabase secrets set OPENROUTER_API_KEY=sk-or-...    (gateway, fallback)
//
// ANTI-INVENÇÃO: a resposta do LLM é uma PROPOSTA, nunca verdade. Cada campo
// passa por validação dura antes de ser aceito:
//   - instagram: handle sintaticamente válido (sem URLs reservadas);
//   - whatsapp: normalização BR (E.164) e SÓ celular conta como WhatsApp-able;
//   - website: só URL http(s) parseável.
// Campo que não validar vira null — nada de dado fabricado no banco.
// =============================================================================

import { normalizeBrazilPhone } from './phone.ts'

export interface PerplexityLeadInfo {
  instagram: string | null
  whatsapp: string | null // E.164 (+55...), só celular
  website: string | null
}

const VAZIO: PerplexityLeadInfo = { instagram: null, whatsapp: null, website: null }

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv'])

/** Valida/normaliza um handle do Instagram (aceita @handle ou URL completa). */
export function validarHandleInstagram(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let h = raw.trim()
  const url = h.match(/instagram\.com\/([A-Za-z0-9._]+)/i)
  if (url) h = url[1]
  h = h.replace(/^@/, '')
  if (!/^[A-Za-z0-9._]{2,30}$/.test(h)) return null
  if (IG_RESERVED.has(h.toLowerCase())) return null
  return h
}

function validarWebsite(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // Instagram não é "site do negócio" — já tem campo próprio.
    if (/(^|\.)instagram\.com$/i.test(u.hostname)) return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * Extrai e valida o JSON da resposta do Sonar. Tolerante a texto em volta e a
 * cerca de código (```json … ```); intolerante a dado inválido (vira null).
 */
export function parsePerplexityLeadInfo(content: unknown): PerplexityLeadInfo {
  if (typeof content !== 'string' || !content.trim()) return VAZIO
  const m = content.match(/\{[\s\S]*\}/)
  if (!m) return VAZIO
  let data: Record<string, unknown>
  try {
    data = JSON.parse(m[0])
  } catch {
    return VAZIO
  }

  const instagram = validarHandleInstagram(data.instagram)
  const phone = normalizeBrazilPhone(typeof data.whatsapp === 'string' ? data.whatsapp : null)
  // Só celular é WhatsApp-able (mesma régua do waterfall do encontrar-whatsapp).
  const whatsapp = phone && phone.kind === 'mobile' ? phone.e164 : null
  const website = validarWebsite(data.website)

  return { instagram, whatsapp, website }
}

// --- Escolha do provedor (puro, testável) --------------------------------------

export interface SonarProvider {
  apiKey: string
  url: string
  model: string
}

/**
 * Resolve o provedor do Sonar a partir dos secrets disponíveis. Perplexity
 * direto tem preferência; OpenRouter serve o MESMO modelo (perplexity/sonar-pro)
 * como gateway. Sem chave nenhuma → null (a fonte 4 simplesmente não roda).
 */
export function resolverProvedorSonar(keys: {
  perplexityKey?: string | null
  openrouterKey?: string | null
}): SonarProvider | null {
  if (keys.perplexityKey?.trim()) {
    return {
      apiKey: keys.perplexityKey.trim(),
      url: 'https://api.perplexity.ai/chat/completions',
      model: 'sonar-pro',
    }
  }
  if (keys.openrouterKey?.trim()) {
    return {
      apiKey: keys.openrouterKey.trim(),
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'perplexity/sonar-pro',
    }
  }
  return null
}

const PROMPT_SISTEMA = [
  'Você é um pesquisador de negócios locais brasileiros. Responda APENAS com um',
  'objeto JSON, sem texto em volta, no formato:',
  '{"instagram": string|null, "whatsapp": string|null, "website": string|null}',
  'Regras: instagram = só o handle (sem @, sem URL). whatsapp = número brasileiro',
  'com DDD usado pelo negócio para atendimento/pedidos no WhatsApp. website = site',
  'oficial do negócio (não Instagram, não agregador tipo iFood). Se não tiver',
  'CERTEZA de um campo a partir de fontes reais, use null. NUNCA invente.',
].join(' ')

/**
 * Consulta o Sonar para um lead (direto na Perplexity ou via OpenRouter — mesmo
 * formato OpenAI). Best-effort: qualquer falha (rede, HTTP, parse) degrada para
 * campos null — nunca lança nem bloqueia o waterfall.
 */
export async function consultarPerplexityLead(
  lead: { nome: string; endereco?: string | null; cidade?: string | null; setor?: string | null },
  provider: SonarProvider,
): Promise<PerplexityLeadInfo> {
  const local = [lead.endereco, lead.cidade].filter(Boolean).join(', ')
  const user = [
    `Negócio: "${lead.nome}"`,
    lead.setor ? `Segmento: ${lead.setor}` : null,
    local ? `Localização: ${local}` : null,
    'Encontre o Instagram, o WhatsApp de atendimento e o site oficial deste negócio.',
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const resp = await fetch(provider.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: 'system', content: PROMPT_SISTEMA },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!resp.ok) {
      console.error('perplexity: HTTP', resp.status, 'via', provider.url)
      return VAZIO
    }
    const data = await resp.json().catch(() => null)
    const content = (data as any)?.choices?.[0]?.message?.content
    return parsePerplexityLeadInfo(content)
  } catch (e) {
    console.error('perplexity: falha de rede', e instanceof Error ? e.message : e)
    return VAZIO
  }
}
