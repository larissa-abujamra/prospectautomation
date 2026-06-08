// Edge Function: enriquecer-lead
// =============================================================================
// Waterfall de enriquecimento de UM lead: CNPJ → dono (QSA) → seguidores.
// Roda no servidor (Deno). As chaves NUNCA vão pro frontend — são secrets:
//   supabase secrets set OPENROUTER_API_KEY=...    (Perplexity Sonar p/ busca + Claude p/ juiz)
//   supabase secrets set SCRAPINGDOG_API_KEY=...   (opcional — só seguidores do Instagram)
// BrasilAPI (dados oficiais + QSA) é grátis e NÃO usa chave.
//
// Pipeline:
//   1) Candidatos a CNPJ via Perplexity Sonar (web search, pela OpenRouter):
//      o modelo PROPÕE os CNPJs que acha na web; extraímos por regex e validamos
//      por dígito verificador (módulo 11).
//   2) Dados oficiais + QSA via BrasilAPI (fallback open.cnpja.com) — só é aceito
//      o CNPJ que a fonte oficial CONFIRMA que existe.
//   3) Disambiguação por OpenRouter/Claude (temp 0, só JSON) entre os confirmados.
//   4) Dono a partir do QSA.
//   5) Seguidores do Instagram via Scrapingdog (best-effort).
//
// ANTI-INVENÇÃO: candidato não confiável → cnpj = null, status 'missing'. O LLM
// só escolhe entre candidatos reais ou retorna null — nunca produz um CNPJ novo.
// LGPD: grava só {nome, qualificacao} do sócio. Nunca CPF.
// Custo: 1 Perplexity Sonar (busca) + N BrasilAPI (grátis) + 1 Claude (juiz).
// Não re-enriquece quem já tem cnpj (salvo force).
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

const CONF_MIN = 0.5 // abaixo disso → não encontrado (fantasia × razão diverge em PME)
const MAX_CAND = 5 // cap de candidatos
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const onlyDigits = (s: string) => s.replace(/\D/g, '')

interface EnrichStatus {
  cnpj?: 'pending' | 'ok' | 'missing'
  dono?: 'pending' | 'ok' | 'missing'
  instagram?: 'pending' | 'ok' | 'missing'
  cnpj_confidence?: number
}

// Validação de CNPJ por dígito verificador (módulo 11). Descarta números que
// casam o regex mas não são CNPJ (telefone, CEP, etc.).
function cnpjValido(cnpj: string): boolean {
  const c = onlyDigits(cnpj)
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false
  const dv = (len: number): number => {
    let pos = len - 7
    let sum = 0
    for (let i = 0; i < len; i++) {
      sum += Number(c[i]) * pos--
      if (pos < 2) pos = 9
    }
    const r = sum % 11
    return r < 2 ? 0 : 11 - r
  }
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13])
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

interface Candidato {
  cnpj: string
  razao_social: string | null
  nome_fantasia: string | null
  endereco: string | null
  qsa: { nome_socio: string | null; qualificacao_socio: string | null }[]
}

// Extrai CNPJs válidos (mod-11) de um texto livre. Dedup + cap.
function extrairCnpjs(texto: string): string[] {
  const matches = texto.match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of matches) {
    const c = onlyDigits(m)
    if (c.length === 14 && cnpjValido(c) && !seen.has(c)) {
      seen.add(c)
      out.push(c)
      if (out.length >= MAX_CAND) break
    }
  }
  return out
}

// Passo 1 — candidatos a CNPJ via Perplexity Sonar (web search, pela OpenRouter).
// O modelo busca na web e PROPÕE CNPJs; quem valida/confirma é o mod-11 + BrasilAPI.
async function buscarCandidatosPerplexity(
  apiKey: string,
  lead: { nome: string; endereco: string | null; bairro: string | null },
): Promise<string[]> {
  const alvo = [
    `"${lead.nome}"`,
    lead.bairro ? `bairro ${lead.bairro}` : '',
    lead.endereco ?? '',
    'São Paulo, Brasil',
  ]
    .filter(Boolean)
    .join(', ')
  const prompt =
    `Encontre o CNPJ da empresa ${alvo}. ` +
    `Liste TODOS os CNPJs candidatos que encontrar (matriz e filiais), apenas os números, um por linha. ` +
    `Não invente: se não encontrar, responda "nenhum".`

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Squad Prospeccao',
      },
      body: JSON.stringify({
        model: 'perplexity/sonar',
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!resp.ok) {
      console.log('[enriquecer-lead] Perplexity Sonar HTTP', resp.status)
      return []
    }
    const data = await resp.json()
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    console.log('[enriquecer-lead] Perplexity Sonar:', content.slice(0, 400).replace(/\s+/g, ' '))
    return extrairCnpjs(content)
  } catch {
    return []
  }
}

function montarEndereco(parts: (string | null | undefined)[]): string | null {
  const s = parts.map((p) => (p == null ? '' : String(p)).trim()).filter(Boolean).join(', ')
  return s || null
}

// Passo 2 — dados oficiais + QSA via BrasilAPI (grátis, rate-limited).
async function consultarBrasilApi(cnpj: string): Promise<Candidato | null> {
  const url = `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url)
      if (resp.status === 429) {
        await sleep(800 * (attempt + 1)) // backoff
        continue
      }
      if (!resp.ok) return null
      const d = await resp.json()
      const qsa = Array.isArray(d.qsa)
        ? d.qsa.map((s: Record<string, unknown>) => ({
            nome_socio: s.nome_socio == null ? null : String(s.nome_socio),
            qualificacao_socio: s.qualificacao_socio == null ? null : String(s.qualificacao_socio),
          }))
        : []
      return {
        cnpj,
        razao_social: d.razao_social ?? null,
        nome_fantasia: d.nome_fantasia ?? null,
        endereco: montarEndereco([d.logradouro, d.numero, d.bairro, d.municipio, d.uf]),
        qsa,
      }
    } catch {
      return null
    }
  }
  return null
}

// Fallback opcional — open.cnpja.com (também grátis). Só nome + qualificação
// do sócio; o CPF mascarado que a fonte traz é deliberadamente ignorado (LGPD).
async function consultarCnpja(cnpj: string): Promise<Candidato | null> {
  try {
    const resp = await fetch(`https://open.cnpja.com/office/${cnpj}`)
    if (!resp.ok) return null
    const d = await resp.json()
    const addr = d.address ?? {}
    const members = Array.isArray(d.company?.members) ? d.company.members : []
    const qsa = members.map((m: Record<string, unknown>) => {
      const person = (m.person ?? {}) as Record<string, unknown>
      const role = (m.role ?? {}) as Record<string, unknown>
      return {
        nome_socio: person.name == null ? null : String(person.name),
        qualificacao_socio: role.text == null ? null : String(role.text),
      }
    })
    return {
      cnpj,
      razao_social: d.company?.name ?? null,
      nome_fantasia: d.alias ?? null,
      endereco: montarEndereco([addr.street, addr.number, addr.district, addr.city, addr.state]),
      qsa,
    }
  } catch {
    return null
  }
}

// Passo 3 — disambiguação via OpenRouter (Claude), temperatura 0, só JSON.
async function escolherCnpj(
  lead: { nome: string; endereco: string | null; bairro: string | null; telefone: string | null },
  candidatos: Candidato[],
  apiKey: string,
): Promise<{ best_cnpj: string | null; confidence: number; motivo: string }> {
  const validSet = new Set(candidatos.map((c) => c.cnpj))
  const lista = candidatos.map((c) => ({
    cnpj: c.cnpj,
    razao_social: c.razao_social,
    nome_fantasia: c.nome_fantasia,
    endereco: c.endereco,
  }))

  const system = [
    'Você desambigua qual empresa (CNPJ) corresponde a um estabelecimento real.',
    'Responda APENAS com um objeto JSON, sem texto fora dele, sem crases.',
    'Formato: {"best_cnpj": "<cnpj OU null>", "confidence": <0..1>, "motivo": "<curto>"}.',
    'REGRA ABSOLUTA: best_cnpj DEVE ser exatamente um dos CNPJs fornecidos na lista de candidatos, ou null.',
    'É PROIBIDO inventar, completar ou alterar qualquer número de CNPJ.',
    'Case por similaridade de nome fantasia/razão social com o nome do lead E proximidade de endereço/bairro.',
    'Se não houver match claro, retorne best_cnpj=null com confidence baixa. Na dúvida, prefira null.',
  ].join(' ')

  const user = JSON.stringify({
    lead: { nome: lead.nome, endereco: lead.endereco, bairro: lead.bairro, telefone: lead.telefone },
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

// Passo 4 — dono + sócios sanitizados (SEM CPF).
function extrairDonoESocios(match: Candidato): {
  dono_nome: string | null
  socios: { nome: string | null; qualificacao: string | null }[]
} {
  const socios = match.qsa
    .map((s) => ({ nome: s.nome_socio, qualificacao: s.qualificacao_socio }))
    .filter((s) => s.nome)

  const admin = socios.find((s) => /administrador/i.test(s.qualificacao ?? ''))
  if (admin?.nome) return { dono_nome: admin.nome, socios }
  if (socios.length === 1 && socios[0].nome) return { dono_nome: socios[0].nome, socios }
  return { dono_nome: null, socios } // nada claro → null (anti-invenção)
}

// Passo 5 — seguidores via Scrapingdog (best-effort, nunca trava o resto).
async function buscarSeguidores(handle: string, apiKey: string): Promise<number | null> {
  const username = handle.replace(/^@/, '').trim()
  if (!username) return null
  try {
    const url = `https://api.scrapingdog.com/instagram/profile?api_key=${apiKey}&username=${encodeURIComponent(username)}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
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

  const scrapingdogKey = Deno.env.get('SCRAPINGDOG_API_KEY') // só Instagram (opcional)
  const openrouterKey = Deno.env.get('OPENROUTER_API_KEY') // Perplexity (busca) + Claude (juiz)

  if (!openrouterKey) {
    return json({ error: 'Falta o secret OPENROUTER_API_KEY.' }, 500)
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

  // Já enriquecido e sem force → não re-consultar.
  if (lead.cnpj && !force) {
    return json({ lead, enrich_status: lead.enrich_status, skipped: true })
  }

  const status: EnrichStatus = { cnpj: 'pending', dono: 'pending', instagram: 'pending' }
  const patch: Record<string, unknown> = {}

  try {
    // --- Passo 1: candidatos via Perplexity Sonar (web search) ---
    const candidatosIds = await buscarCandidatosPerplexity(openrouterKey, lead)
    console.log(`[enriquecer-lead] ${candidatosIds.length} CNPJ(s) válido(s) extraído(s):`, candidatosIds)

    let matched: Candidato | null = null
    let confidence = 0

    if (candidatosIds.length > 0) {
      // --- Passo 2: dados oficiais via BrasilAPI (sequencial + fallback) ---
      const candidatos: Candidato[] = []
      for (const cnpj of candidatosIds) {
        let cand = await consultarBrasilApi(cnpj)
        if (!cand) cand = await consultarCnpja(cnpj) // fallback grátis
        if (cand) candidatos.push(cand)
        await sleep(300) // gentileza com o rate limit da BrasilAPI
      }

      // --- Passo 3: disambiguação (OpenRouter) ---
      if (candidatos.length > 0) {
        const escolha = await escolherCnpj(lead, candidatos, openrouterKey)
        confidence = escolha.confidence
        console.log(`[enriquecer-lead] OpenRouter → best=${escolha.best_cnpj} conf=${confidence} motivo="${escolha.motivo}"`)
        if (escolha.best_cnpj && confidence >= CONF_MIN) {
          matched = candidatos.find((c) => c.cnpj === escolha.best_cnpj) ?? null
        }
      }
    }

    if (matched) {
      // --- Passo 4: dono + sócios (sem CPF) ---
      const { dono_nome, socios } = extrairDonoESocios(matched)
      patch.cnpj = matched.cnpj
      patch.razao_social = matched.razao_social
      patch.socios = socios
      patch.dono_nome = dono_nome
      status.cnpj = 'ok'
      status.cnpj_confidence = confidence
      status.dono = dono_nome ? 'ok' : 'missing'
    } else {
      patch.cnpj = null
      patch.razao_social = null
      patch.socios = null
      patch.dono_nome = null
      status.cnpj = 'missing'
      status.dono = 'missing'
    }

    // --- Passo 5: seguidores (best-effort, isolado) ---
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
