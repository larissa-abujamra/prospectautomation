// Edge Function: enriquecer-lead
// =============================================================================
// Waterfall de enriquecimento de UM lead: CNPJ → dono (QSA) → seguidores.
// Roda no servidor (Deno). As chaves NUNCA vão pro frontend — são secrets:
//   supabase secrets set CPFCNPJ_TOKEN=...
//   supabase secrets set SCRAPINGDOG_API_KEY=...
//   supabase secrets set OPENROUTER_API_KEY=...
// Opcionais (dependem do seu plano cpfcnpj):
//   CPFCNPJ_PACOTE_BUSCA   (default '4'  — busca reversa por razão social)
//   CPFCNPJ_PACOTE_CNPJ    (default '6'  — consulta de CNPJ que retorna QSA)
//
// ANTI-INVENÇÃO (crítico): todo dado não encontrado ou de baixa confiança vira
// null + status 'missing'. O LLM SÓ escolhe entre CNPJs reais candidatos ou
// retorna null — nunca produz um número novo. Nenhum CPF é gravado (trava LGPD).
//
// Custo: cada consulta cpfcnpj gasta saldo; Scrapingdog gasta ~15 créditos. Por
// isso: cap de 5 candidatos, e não re-enriquece quem já tem cnpj (salvo force).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

const CONF_MIN = 0.6 // abaixo disso → não encontrado
const MAX_CAND = 5 // cap de custo

interface EnrichStatus {
  cnpj?: 'pending' | 'ok' | 'missing'
  dono?: 'pending' | 'ok' | 'missing'
  instagram?: 'pending' | 'ok' | 'missing'
  cnpj_confidence?: number
}

const onlyDigits = (s: string) => s.replace(/\D/g, '')

// Limpa o nome para a busca reversa (tira termos de segmento e espaços extras).
function cleanRazao(nome: string): string {
  return nome
    .replace(/\b(confeitaria|doceria|docer[ií]a|padaria|caf[eé]|bakery|sweets?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Extrai um objeto JSON de um texto que pode vir com crases/ruído.
function safeJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

const CPFCNPJ_BASE = 'https://api.cpfcnpj.com.br'

// Etapa 1 — candidatos a CNPJ por razão social.
async function buscarCandidatos(
  nome: string,
  token: string,
  pacote: string,
): Promise<string[]> {
  const termo = cleanRazao(nome) || nome
  // O param documentado é razao_social; alguns planos aceitam rzsocial — tentamos ambos.
  for (const param of ['razao_social', 'rzsocial']) {
    const url = `${CPFCNPJ_BASE}/${token}/${pacote}/?${param}=${encodeURIComponent(termo)}`
    try {
      const resp = await fetch(url)
      const data = await resp.json()
      const arr = data?.resultado
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((c: string) => onlyDigits(String(c))).filter((c) => c.length === 14)
      }
    } catch {
      // tenta o próximo param
    }
  }
  return []
}

interface Candidato {
  cnpj: string
  razao: string | null
  fantasia: string | null
  endereco: string | null
  responsavel: string | null
  responsavelQualificacao: string | null
  sociosRaw: unknown[]
}

function fmtEndereco(e: unknown): string | null {
  if (!e || typeof e !== 'object') return null
  const o = e as Record<string, unknown>
  const parts = [o.logradouro, o.numero, o.bairro, o.cidade, o.uf]
    .map((p) => (p == null ? '' : String(p)))
    .filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

function asText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v || null
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const d = o.descricao ?? o.qualificacao ?? o.nome
    return d == null ? null : String(d)
  }
  return String(v)
}

// Etapa 2 — dados oficiais de um candidato (inclui QSA).
async function consultarCnpj(
  cnpj: string,
  token: string,
  pacote: string,
): Promise<Candidato | null> {
  const url = `${CPFCNPJ_BASE}/${token}/${pacote}/?cnpj=${cnpj}`
  try {
    const resp = await fetch(url)
    const data = await resp.json()
    if (!data || (data.status != null && Number(data.status) < 1 && !data.razao)) return null
    return {
      cnpj,
      razao: asText(data.razao),
      fantasia: asText(data.fantasia),
      endereco: fmtEndereco(data.matrizEndereco),
      responsavel: asText(data.responsavel),
      responsavelQualificacao: asText(data.responsavelQualificacao),
      sociosRaw: Array.isArray(data.socios) ? data.socios : [],
    }
  } catch {
    return null
  }
}

// Etapa 3 — disambiguação via OpenRouter (Claude), temperatura 0, só JSON.
async function escolherCnpj(
  lead: { nome: string; endereco: string | null; bairro: string | null; telefone: string | null },
  candidatos: Candidato[],
  apiKey: string,
): Promise<{ best_cnpj: string | null; confidence: number; motivo: string }> {
  const validSet = new Set(candidatos.map((c) => c.cnpj))
  const lista = candidatos.map((c) => ({
    cnpj: c.cnpj,
    razao: c.razao,
    fantasia: c.fantasia,
    endereco: c.endereco,
  }))

  const system = [
    'Você desambigua qual empresa (CNPJ) corresponde a um estabelecimento real.',
    'Responda APENAS com um objeto JSON, sem texto fora dele, sem crases.',
    'Formato: {"best_cnpj": "<cnpj OU null>", "confidence": <0..1>, "motivo": "<curto>"}.',
    'REGRA ABSOLUTA: best_cnpj DEVE ser exatamente um dos CNPJs fornecidos na lista de candidatos, ou null.',
    'É PROIBIDO inventar, completar ou alterar qualquer número de CNPJ.',
    'Case por similaridade de nome fantasia/razão com o nome do lead E proximidade de endereço/bairro.',
    'Se não houver match claro, retorne best_cnpj=null com confidence baixa. Na dúvida, prefira null.',
  ].join(' ')

  const user = JSON.stringify({
    lead: {
      nome: lead.nome,
      endereco: lead.endereco,
      bairro: lead.bairro,
      telefone: lead.telefone,
    },
    candidatos: lista,
  })

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Squad Prospeccao',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.6',
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })

  const data = await resp.json()
  const content: string = data?.choices?.[0]?.message?.content ?? ''
  const parsed = safeJson(content)
  if (!parsed) return { best_cnpj: null, confidence: 0, motivo: 'sem resposta válida' }

  let best = parsed.best_cnpj == null ? null : onlyDigits(String(parsed.best_cnpj))
  const confidence = Number(parsed.confidence) || 0
  const motivo = String(parsed.motivo ?? '')

  // TRAVA dura: só aceita CNPJ que está entre os candidatos reais.
  if (best && !validSet.has(best)) best = null

  return { best_cnpj: best, confidence, motivo }
}

// Etapa 4 — dono + sócios sanitizados (SEM CPF).
function extrairDonoESocios(match: Candidato): {
  dono_nome: string | null
  socios: { nome: string | null; qualificacao: string | null }[]
} {
  // socios: só nome + qualificacao; qualquer CPF/cpf_cnpj_socio é descartado aqui.
  const socios = match.sociosRaw
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>
      const nome = asText(o.nome ?? o.nomeSocio ?? o.razaoSocial)
      const qualificacao = asText(o.qualificacao ?? o.qual ?? o.qualificacaoSocio ?? o.qualificacao_socio)
      return { nome, qualificacao }
    })
    .filter((s) => s.nome)

  // Dono: responsável se a qualificação indicar sócio/administrador…
  const respQual = (match.responsavelQualificacao ?? '').toLowerCase()
  if (match.responsavel && /(s[oó]cio|administrador|titular|propriet[aá]rio)/.test(respQual)) {
    return { dono_nome: match.responsavel, socios }
  }
  // …senão, um sócio com qualificação de administrador…
  const admin = socios.find((s) => /administrador/i.test(s.qualificacao ?? ''))
  if (admin?.nome) return { dono_nome: admin.nome, socios }
  // …senão, se houver um único sócio, ele.
  if (socios.length === 1 && socios[0].nome) return { dono_nome: socios[0].nome, socios }
  // Nada claro → null (anti-invenção).
  return { dono_nome: null, socios }
}

// Etapa 5 — seguidores via Scrapingdog (best-effort, nunca trava o resto).
async function buscarSeguidores(handle: string, apiKey: string): Promise<number | null> {
  const username = handle.replace(/^@/, '').trim()
  if (!username) return null
  try {
    const url = `https://api.scrapingdog.com/instagram/profile?api_key=${apiKey}&username=${encodeURIComponent(username)}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    // O nome do campo varia entre versões da API — tentamos os caminhos prováveis.
    const candidates = [
      data?.followers,
      data?.follower_count,
      data?.followers_count,
      data?.edge_followed_by?.count,
      data?.user?.edge_followed_by?.count,
      data?.data?.followers,
    ]
    for (const c of candidates) {
      const n = typeof c === 'string' ? Number(c.replace(/\D/g, '')) : Number(c)
      if (Number.isFinite(n) && n > 0) return n
    }
    return null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const cpfcnpjToken = Deno.env.get('CPFCNPJ_TOKEN')
  const scrapingdogKey = Deno.env.get('SCRAPINGDOG_API_KEY')
  const openrouterKey = Deno.env.get('OPENROUTER_API_KEY')
  const pacoteBusca = Deno.env.get('CPFCNPJ_PACOTE_BUSCA') ?? '4'
  const pacoteCnpj = Deno.env.get('CPFCNPJ_PACOTE_CNPJ') ?? '6'

  if (!cpfcnpjToken || !openrouterKey) {
    return json({ error: 'Faltam secrets CPFCNPJ_TOKEN e/ou OPENROUTER_API_KEY.' }, 500)
  }

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
    .select('*')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // Já enriquecido e sem force → não re-consultar (economiza saldo/créditos).
  if (lead.cnpj && !force) {
    return json({ lead, enrich_status: lead.enrich_status, skipped: true })
  }

  const status: EnrichStatus = { cnpj: 'pending', dono: 'pending', instagram: 'pending' }
  const patch: Record<string, unknown> = {}

  try {
    // --- CNPJ + dono ---
    const candidatosIds = (await buscarCandidatos(lead.nome, cpfcnpjToken, pacoteBusca)).slice(
      0,
      MAX_CAND,
    )

    let matched: Candidato | null = null
    let confidence = 0

    if (candidatosIds.length > 0) {
      const candidatos: Candidato[] = []
      for (const c of candidatosIds) {
        const det = await consultarCnpj(c, cpfcnpjToken, pacoteCnpj)
        if (det) candidatos.push(det)
      }

      if (candidatos.length > 0) {
        const escolha = await escolherCnpj(lead, candidatos, openrouterKey)
        confidence = escolha.confidence
        if (escolha.best_cnpj && confidence >= CONF_MIN) {
          matched = candidatos.find((c) => c.cnpj === escolha.best_cnpj) ?? null
        }
      }
    }

    if (matched) {
      const { dono_nome, socios } = extrairDonoESocios(matched)
      patch.cnpj = matched.cnpj
      patch.razao_social = matched.razao
      patch.socios = socios // só {nome, qualificacao} — sem CPF
      patch.dono_nome = dono_nome
      status.cnpj = 'ok'
      status.cnpj_confidence = confidence
      status.dono = dono_nome ? 'ok' : 'missing'
    } else {
      // Não encontrado / baixa confiança → null, sem palpite.
      patch.cnpj = null
      patch.razao_social = null
      patch.socios = null
      patch.dono_nome = null
      status.cnpj = 'missing'
      status.dono = 'missing'
    }

    // --- Seguidores (best-effort, isolado) ---
    if (lead.instagram_handle && scrapingdogKey) {
      const followers = await buscarSeguidores(lead.instagram_handle, scrapingdogKey)
      if (followers != null) {
        patch.instagram_followers = followers
        status.instagram = 'ok'
      } else {
        status.instagram = 'missing'
      }
    } else {
      status.instagram = 'missing'
    }

    // --- Gravação final ---
    patch.enrich_status = status
    if (status.cnpj === 'ok' && lead.status === 'descoberto') {
      patch.status = 'enriquecido'
    }

    const { data: updated, error: updErr } = await supabase
      .from('leads')
      .update(patch)
      .eq('id', leadId)
      .select('*')
      .single()
    if (updErr) throw updErr

    return json({ lead: updated, enrich_status: status })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Erro desconhecido'
    return json({ error: message }, 502)
  }
})
