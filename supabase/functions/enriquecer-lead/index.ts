// Edge Function: enriquecer-lead
// =============================================================================
// Waterfall de enriquecimento de UM lead: CNPJ → dono (QSA) → seguidores.
// Roda no servidor (Deno). As chaves NUNCA vão pro frontend — são secrets:
//   supabase secrets set SCRAPINGDOG_API_KEY=...   (Google Search + scrape + Instagram)
//   supabase secrets set OPENROUTER_API_KEY=...    (juiz Claude, só p/ desempate)
// BrasilAPI / cnpj.ws / cnpja (dados oficiais + QSA) são grátis e NÃO usam chave.
//
// Pipeline:
//   0) Limpa o nome do lead (tira sufixo "- bairro, SP…" e bairro solto no fim).
//   1) Scrapingdog Google Search: query `"<nome limpo>" cnpj <cidade>`.
//   2) Extrai o CNPJ da URL dos resultados (link → title → snippet), validando
//      por dígito verificador (mod-11). Fallback: scrape da página do agregador
//      (cnpj.biz/econodata/…) via Scrapingdog (passa pelo anti-bot).
//   3) Confirma cada candidato na fonte oficial (BrasilAPI → cnpj.ws → cnpja).
//   4) Juiz (OpenRouter/Claude) só se houver >1 candidato confirmado.
//   5) Dono a partir do QSA. 6) Seguidores do Instagram (Scrapingdog).
//
// ANTI-INVENÇÃO: candidato que a fonte oficial não confirma, ou baixa confiança
// no desempate → cnpj = null, status 'missing'. Nunca chuta.
// LGPD: grava só {nome, qualificacao} do sócio. Nunca CPF.
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

const CONF_MIN = 0.5 // abaixo disso, no desempate → não encontrado
const MAX_CAND = 5
const CNPJ_RE = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const onlyDigits = (s: string) => s.replace(/\D/g, '')

interface EnrichStatus {
  cnpj?: 'pending' | 'ok' | 'missing'
  dono?: 'pending' | 'ok' | 'missing'
  instagram?: 'pending' | 'ok' | 'missing'
  cnpj_confidence?: number
}

// Validação de CNPJ por dígito verificador (módulo 11).
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

// Passo 0 — limpa o nome pra busca. Tira o sufixo "- bairro, São Paulo - SP, …"
// que o Google Places gruda, e o bairro solto no fim do nome.
function limparNome(nome: string, bairro: string | null): string {
  let n = nome.split(' - ')[0].trim()
  if (bairro) {
    const esc = bairro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    n = n.replace(new RegExp('\\s+' + esc + '\\s*$', 'i'), '').trim()
  }
  return n.replace(/\s+/g, ' ').trim()
}

interface OrganicResult {
  title?: string
  link?: string
  displayed_link?: string
  snippet?: string
}

// Passo 1 — Scrapingdog Google Search.
async function buscarGoogle(apiKey: string, query: string): Promise<OrganicResult[]> {
  const url = `https://api.scrapingdog.com/google/?api_key=${apiKey}&query=${encodeURIComponent(query)}&country=br&results=10`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.log('[enriquecer-lead] Google Search HTTP', resp.status)
      return []
    }
    const data = await resp.json()
    return Array.isArray(data?.organic_results) ? data.organic_results : []
  } catch {
    return []
  }
}

// Scrape de uma página (passa pelo anti-bot dos agregadores).
async function scrapePagina(apiKey: string, target: string): Promise<string> {
  const url = `https://api.scrapingdog.com/scrape?api_key=${apiKey}&dynamic=true&url=${encodeURIComponent(target)}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) return ''
    return await resp.text()
  } catch {
    return ''
  }
}

const onlyValid = (texts: string[], into: string[], seen: Set<string>) => {
  for (const t of texts) {
    for (const m of t.match(CNPJ_RE) ?? []) {
      const c = onlyDigits(m)
      if (c.length === 14 && cnpjValido(c) && !seen.has(c)) {
        seen.add(c)
        into.push(c)
        if (into.length >= MAX_CAND) return
      }
    }
  }
}

// Passo 2 — extrai CNPJs dos resultados na ordem URL → título → snippet
// (o snippet nunca é fonte primária).
function extrairCnpjs(results: OrganicResult[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  onlyValid(results.flatMap((r) => [r.link ?? '', r.displayed_link ?? '']), out, seen)
  if (out.length < MAX_CAND) onlyValid(results.map((r) => r.title ?? ''), out, seen)
  if (out.length < MAX_CAND) onlyValid(results.map((r) => r.snippet ?? ''), out, seen)
  return out.slice(0, MAX_CAND)
}

const AGREGADORES = /(cnpj\.biz|econodata|casadosdados|cnpja|consultas\.plus|cnpjagora|empresascnpj|solutudo)/i

interface Candidato {
  cnpj: string
  razao_social: string | null
  nome_fantasia: string | null
  endereco: string | null
  porte: string | null // faixa legal de porte (NÃO é faturamento medido)
  mei: boolean | null // optante pelo MEI
  qsa: { nome_socio: string | null; qualificacao_socio: string | null }[]
}

const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

function montarEndereco(parts: (string | null | undefined)[]): string | null {
  const s = parts.map((p) => (p == null ? '' : String(p)).trim()).filter(Boolean).join(', ')
  return s || null
}

// Passo 3 — fonte oficial. Tenta BrasilAPI → cnpj.ws → cnpja (todas grátis).
async function consultarBrasilApi(cnpj: string): Promise<Candidato | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`)
      if (resp.status === 429) {
        await sleep(800 * (attempt + 1))
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
        // MEI tem que ser checado pelo flag: MEI vem com porte "MICRO EMPRESA".
        porte: d.porte == null ? null : String(d.porte),
        mei: asBool(d.opcao_pelo_mei),
        qsa,
      }
    } catch {
      return null
    }
  }
  return null
}

async function consultarCnpjWs(cnpj: string): Promise<Candidato | null> {
  try {
    const resp = await fetch(`https://publica.cnpj.ws/cnpj/${cnpj}`)
    if (!resp.ok) return null
    const d = await resp.json()
    const est = d.estabelecimento ?? {}
    const qsa = Array.isArray(d.socios)
      ? d.socios.map((s: Record<string, unknown>) => {
          const q = s.qualificacao_socio as Record<string, unknown> | string | undefined
          return {
            nome_socio: s.nome == null ? null : String(s.nome),
            qualificacao_socio:
              typeof q === 'object' && q ? String(q.descricao ?? '') || null : (q as string) ?? null,
          }
        })
      : []
    return {
      cnpj,
      razao_social: d.razao_social ?? null,
      nome_fantasia: est.nome_fantasia ?? null,
      endereco: montarEndereco([est.logradouro, est.numero, est.bairro, est.cidade?.nome, est.estado?.sigla]),
      porte: d.porte?.descricao ?? (d.porte == null ? null : String(d.porte)),
      mei: asBool(d.simei?.optante) ?? asBool(est.simei?.optante),
      qsa,
    }
  } catch {
    return null
  }
}

// Fallback: open.cnpja.com. CPF mascarado da fonte é deliberadamente ignorado.
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
      porte: d.company?.size?.text ?? null,
      mei: asBool(d.company?.simei?.optant),
      qsa,
    }
  } catch {
    return null
  }
}

async function confirmarOficial(cnpj: string): Promise<{ cand: Candidato; fonte: string } | null> {
  const brasil = await consultarBrasilApi(cnpj)
  if (brasil) return { cand: brasil, fonte: 'brasilapi' }
  const ws = await consultarCnpjWs(cnpj)
  if (ws) return { cand: ws, fonte: 'cnpj.ws' }
  const cnpja = await consultarCnpja(cnpj)
  if (cnpja) return { cand: cnpja, fonte: 'cnpja' }
  return null
}

// Passo 4 — juiz (OpenRouter/Claude), só quando há mais de um candidato.
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
    'REGRA ABSOLUTA: best_cnpj DEVE ser exatamente um dos CNPJs fornecidos, ou null.',
    'É PROIBIDO inventar, completar ou alterar qualquer número de CNPJ.',
    'Case por similaridade de nome fantasia/razão social com o nome do lead E proximidade de endereço/bairro.',
    'Se não houver match claro, retorne best_cnpj=null. Na dúvida, prefira null.',
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
  if (best && !validSet.has(best)) best = null // trava: só da lista
  return { best_cnpj: best, confidence, motivo }
}

// Passo 5 — dono + sócios sanitizados (SEM CPF).
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
  return { dono_nome: null, socios }
}

// Passo 6 — seguidores via Scrapingdog (best-effort, nunca trava o resto).
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

  const scrapingdogKey = Deno.env.get('SCRAPINGDOG_API_KEY')
  const openrouterKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!scrapingdogKey || !openrouterKey) {
    return json({ error: 'Faltam secrets SCRAPINGDOG_API_KEY e/ou OPENROUTER_API_KEY.' }, 500)
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

  if (lead.cnpj && !force) {
    return json({ lead, enrich_status: lead.enrich_status, skipped: true })
  }

  const status: EnrichStatus = { cnpj: 'pending', dono: 'pending', instagram: 'pending' }
  const patch: Record<string, unknown> = {}

  try {
    // --- Passos 0+1: nome limpo + Google Search ---
    const nomeLimpo = limparNome(lead.nome, lead.bairro)
    const cidade = lead.cidade ?? 'São Paulo'
    const query = `"${nomeLimpo}" cnpj ${cidade}`
    const results = await buscarGoogle(scrapingdogKey, query)
    console.log(`[enriquecer-lead] query=${query} | ${results.length} resultados`)
    console.log('[enriquecer-lead] links:', results.map((r) => r.link).filter(Boolean).slice(0, 6))

    // --- Passo 2: extrair CNPJs (URL → título → snippet) ---
    let cnpjs = extrairCnpjs(results)

    // Fallback: scrape das 1ª–2ª páginas de agregador.
    if (cnpjs.length === 0) {
      const alvos = results
        .map((r) => r.link)
        .filter((l): l is string => !!l && AGREGADORES.test(l))
        .slice(0, 2)
      const seen = new Set<string>()
      const out: string[] = []
      for (const alvo of alvos) {
        const html = await scrapePagina(scrapingdogKey, alvo)
        onlyValid([html], out, seen)
        if (out.length > 0) break
      }
      cnpjs = out
      console.log('[enriquecer-lead] fallback scrape →', cnpjs)
    }
    console.log('[enriquecer-lead] CNPJs candidatos:', cnpjs)

    let matched: Candidato | null = null
    let confidence = 0

    if (cnpjs.length > 0) {
      // --- Passo 3: confirmar na fonte oficial ---
      const candidatos: Candidato[] = []
      for (const cnpj of cnpjs) {
        const conf = await confirmarOficial(cnpj)
        if (conf) {
          candidatos.push(conf.cand)
          console.log(`[enriquecer-lead] ${cnpj} confirmado por ${conf.fonte}`)
        }
        await sleep(300)
      }

      // --- Passo 4: juiz só se houver >1 ---
      if (candidatos.length === 1) {
        matched = candidatos[0]
        confidence = 1
      } else if (candidatos.length > 1) {
        const escolha = await escolherCnpj(lead, candidatos, openrouterKey)
        confidence = escolha.confidence
        console.log(`[enriquecer-lead] juiz → best=${escolha.best_cnpj} conf=${confidence} (${escolha.motivo})`)
        if (escolha.best_cnpj && confidence >= CONF_MIN) {
          matched = candidatos.find((c) => c.cnpj === escolha.best_cnpj) ?? null
        }
      }
    }

    if (matched) {
      const { dono_nome, socios } = extrairDonoESocios(matched)
      patch.cnpj = matched.cnpj
      patch.razao_social = matched.razao_social
      patch.socios = socios
      patch.dono_nome = dono_nome
      patch.porte = matched.porte // faixa legal de porte (não é faturamento medido)
      patch.mei = matched.mei
      status.cnpj = 'ok'
      status.cnpj_confidence = confidence
      status.dono = dono_nome ? 'ok' : 'missing'
    } else {
      patch.cnpj = null
      patch.razao_social = null
      patch.socios = null
      patch.dono_nome = null
      patch.porte = null
      patch.mei = null
      status.cnpj = 'missing'
      status.dono = 'missing'
    }

    // --- Passo 6: seguidores (best-effort, isolado) ---
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
