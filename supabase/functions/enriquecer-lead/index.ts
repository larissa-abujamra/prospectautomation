// Edge Function: enriquecer-lead
// =============================================================================
// Waterfall de enriquecimento de UM lead: CNPJ → dono (QSA) → seguidores.
// Roda no servidor (Deno). As chaves NUNCA vão pro frontend — são secrets:
//   supabase secrets set SCRAPINGDOG_API_KEY=...   (Google Search + scrape + Instagram)
//   supabase secrets set OPENROUTER_API_KEY=...    (juiz Claude, só p/ desempate)
// BrasilAPI / cnpj.ws / cnpja (dados oficiais + QSA) são grátis e NÃO usam chave.
//
// Pipeline:
//   1a) CNPJ no site do próprio negócio (rodapé) — fonte mais direta; quando
//       acerta, pula SERP/scrape. Fetch via safeFetchHtml (anti-SSRF).
//   0) Limpa o nome do lead (tira sufixo "- bairro, SP…" e bairro solto no fim).
//   1) Scrapingdog Google Search: query `"<nome limpo>" cnpj <cidade>`.
//   2) Extrai o CNPJ da URL dos resultados (link → title → snippet), validando
//      por dígito verificador (mod-11). Fallback: scrape da página do agregador
//      (cnpj.biz/econodata/…) via Scrapingdog (passa pelo anti-bot).
//   3) Confirma cada candidato na fonte oficial (BrasilAPI → cnpj.ws → cnpja).
//   3.5) Gates determinísticos: situação cadastral ATIVA + município do lead
//        (sinais grátis das fontes oficiais; ver _shared/cnpj_match.ts).
//   4) Juiz (OpenRouter/Claude) para QUALQUER candidato — inclusive único.
//      (O atalho "1 candidato → conf=1" deu 3/3 matches errados em produção.)
//   5) Dono a partir do QSA. 6) Seguidores do Instagram (Scrapingdog).
//
// ANTI-INVENÇÃO: candidato que a fonte oficial não confirma, ou baixa confiança
// no desempate → cnpj = null, status 'missing'. Nunca chuta.
// LGPD: grava só {nome, qualificacao} do sócio. Nunca CPF.
// Não re-enriquece quem já tem cnpj (salvo force).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  gateCandidato,
  cnpjValido,
  extrairCnpjsDeHtml,
  CNPJ_RE,
  scoreCandidato,
  telefonesBatem,
  nomeSimilaridade,
} from '../_shared/cnpj_match.ts'
import { safeFetchHtml } from '../_shared/ssrf.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { handleFromHtml } from '../_shared/instagram.ts'
import { buscarCnpjLocal, type LocalCnpj } from '../_shared/cnpj_local_search.ts'
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

const CONF_MIN = 0.7 // abaixo disso, no desempate do juiz → não encontrado
const MAX_CAND = 5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const onlyDigits = (s: string) => s.replace(/\D/g, '')

interface EnrichStatus {
  cnpj?: 'pending' | 'ok' | 'missing'
  dono?: 'pending' | 'ok' | 'missing'
  instagram?: 'pending' | 'ok' | 'missing'
  cnpj_confidence?: number
  attempted_at?: string // ISO — última tentativa; base do cooldown anti-recobrança
}

// Lead que já ficou 'missing' não re-roda o pipeline pago (SERP+scrape+LLM) a
// cada clique/refetch dentro desta janela. force ignora o cooldown.
const ENRICH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000 // 7 dias

// (cnpjValido / CNPJ_RE / extrairCnpjsDeHtml agora vivem em _shared/cnpj_match.ts)

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
  // Sinais de gate/desempate (vêm de graça nas fontes oficiais — produção
  // mostrou matches errados com empresa BAIXADA e CNAE de leiloeiro):
  municipio: string | null
  situacao: string | null // situação cadastral (ATIVA/BAIXADA/…)
  cnae: string | null // descrição da atividade principal
  telefone: string | null // telefone REGISTRADO na Receita (p/ cruzar c/ o do Google)
  porte: string | null // faixa legal de porte (NÃO é faturamento medido)
  mei: boolean | null // optante pelo MEI
  qsa: { nome_socio: string | null; qualificacao_socio: string | null }[]
}

const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

function montarEndereco(parts: (string | null | undefined)[]): string | null {
  const s = parts.map((p) => (p == null ? '' : String(p)).trim()).filter(Boolean).join(', ')
  return s || null
}

// Linha do índice local (já oficial) → Candidato, no mesmo formato das fontes
// online. Assim cai direto no gate + score + juiz, sem reconfirmar.
function localToCandidato(l: LocalCnpj): Candidato {
  return {
    cnpj: l.cnpj,
    razao_social: l.razao_social,
    nome_fantasia: l.nome_fantasia,
    endereco: montarEndereco([l.bairro, l.municipio, l.uf]),
    municipio: l.municipio,
    situacao: l.situacao,
    cnae: l.cnae,
    telefone: l.telefone,
    porte: l.porte,
    mei: l.mei,
    qsa: (l.socios ?? []).map((s) => ({ nome_socio: s.nome, qualificacao_socio: s.qualificacao })),
  }
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
        municipio: d.municipio == null ? null : String(d.municipio),
        situacao: d.descricao_situacao_cadastral == null ? null : String(d.descricao_situacao_cadastral),
        cnae: d.cnae_fiscal_descricao == null ? null : String(d.cnae_fiscal_descricao),
        telefone: d.ddd_telefone_1 == null ? null : String(d.ddd_telefone_1),
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
      municipio: est.cidade?.nome == null ? null : String(est.cidade.nome),
      situacao: est.situacao_cadastral == null ? null : String(est.situacao_cadastral),
      cnae: est.atividade_principal?.descricao == null ? null : String(est.atividade_principal.descricao),
      telefone: est.ddd1 ? `${est.ddd1}${est.telefone1 ?? ''}` : null,
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
      municipio: addr.city == null ? null : String(addr.city),
      situacao: d.status?.text == null ? null : String(d.status.text),
      cnae: d.mainActivity?.text == null ? null : String(d.mainActivity.text),
      telefone: Array.isArray(d.phones) && d.phones[0]
        ? `${d.phones[0].area ?? ''}${d.phones[0].number ?? ''}` || null
        : null,
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

// Passo 4 — juiz (OpenRouter/Claude) para QUALQUER nº de candidatos ≥ 1.
// Candidato único SEM validação semântica deu 3/3 matches errados em produção
// (buffet MEI baixado p/ pizzaria, leiloeiro p/ padaria, calçados p/ restaurante).
async function escolherCnpj(
  lead: {
    nome: string
    endereco: string | null
    bairro: string | null
    telefone: string | null
    setor: string | null
  },
  candidatos: Candidato[],
  apiKey: string,
  origemSiteDoLead: boolean,
): Promise<{ best_cnpj: string | null; confidence: number; motivo: string }> {
  const validSet = new Set(candidatos.map((c) => c.cnpj))
  const lista = candidatos.map((c) => ({
    cnpj: c.cnpj,
    razao_social: c.razao_social,
    nome_fantasia: c.nome_fantasia,
    endereco: c.endereco,
    atividade_principal: c.cnae,
    situacao_cadastral: c.situacao,
  }))

  const system = [
    'Você desambigua qual empresa (CNPJ) corresponde a um estabelecimento real.',
    'Responda APENAS com um objeto JSON, sem texto fora dele, sem crases.',
    'Formato: {"best_cnpj": "<cnpj OU null>", "confidence": <0..1>, "motivo": "<curto>"}.',
    'REGRA ABSOLUTA: best_cnpj DEVE ser exatamente um dos CNPJs fornecidos, ou null.',
    'É PROIBIDO inventar, completar ou alterar qualquer número de CNPJ.',
    'Case por similaridade de nome fantasia/razão social com o nome do lead E proximidade de endereço/bairro.',
    'A atividade_principal (CNAE) deve ser compatível com o setor do lead — um leiloeiro não é uma padaria; loja de calçados não é restaurante. Incompatibilidade grosseira → não é match.',
    'Razão social diferente do nome fantasia é NORMAL (ex.: restaurante operando sob razão social antiga) — desde que endereço/atividade batam.',
    'MARCAS COM VÁRIAS UNIDADES: o endereço do candidato pode ser de OUTRA unidade (matriz ou filial) da MESMA marca. Se nome e atividade casam fortemente, ainda é match — confidence moderada (0.6–0.8) — mesmo com endereço de outra unidade na mesma cidade.',
    'Se cnpj_publicado_no_site_do_lead=true, o CNPJ veio do RODAPÉ do site do próprio negócio: evidência forte. Salvo contradição clara de atividade, é match com confidence alta (≥0.8).',
    'Mesmo com UM único candidato, avalie criticamente: vir do Google não é evidência. Se não houver match claro, retorne best_cnpj=null. Na dúvida, prefira null.',
  ].join(' ')

  const user = JSON.stringify({
    lead: {
      nome: lead.nome,
      endereco: lead.endereco,
      bairro: lead.bairro,
      telefone: lead.telefone,
      setor: lead.setor,
    },
    cnpj_publicado_no_site_do_lead: origemSiteDoLead,
    candidatos: lista,
  })

  // Erro transitório do OpenRouter (rede/5xx/JSON inválido) NÃO pode derrubar o
  // enriquecimento inteiro em 502 — degrada pra "sem match" (igual às outras
  // chamadas externas do arquivo). Sem CNPJ é só status 'missing', não erro.
  let data: Record<string, unknown>
  try {
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
    if (!resp.ok) {
      console.log('[enriquecer-lead] juiz OpenRouter HTTP', resp.status)
      return { best_cnpj: null, confidence: 0, motivo: `juiz HTTP ${resp.status}` }
    }
    data = await resp.json()
  } catch (e) {
    console.log('[enriquecer-lead] juiz OpenRouter falhou:', e instanceof Error ? e.message : e)
    return { best_cnpj: null, confidence: 0, motivo: 'juiz indisponível' }
  }

  const content: string = (data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? ''
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
  // Só um membro logado dispara (Scrapingdog + OpenRouter são COBRADOS). A anon
  // key do bundle é JWT sem usuário → rejeitada (ver _shared/auth.ts).
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

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

  // Cooldown anti-recobrança: já tentou e ficou sem CNPJ → não re-paga o
  // pipeline (SERP+scrape+LLM) a cada refetch/clique. Re-tenta após a janela ou
  // com force. (A maioria dos 'missing' são nomes que NENHUMA fonte acha; sem
  // isto, o auto-runner do front re-cobrava a cada visita à aba.)
  const tentadoEm = lead.enrich_status?.attempted_at ? Date.parse(lead.enrich_status.attempted_at) : 0
  if (!force && lead.enrich_status?.cnpj === 'missing' && tentadoEm > 0 && (Date.now() - tentadoEm) < ENRICH_COOLDOWN_MS) {
    return json({ lead, enrich_status: lead.enrich_status, skipped: true, reason: 'cooldown' })
  }

  const status: EnrichStatus = { cnpj: 'pending', dono: 'pending', instagram: 'pending', attempted_at: new Date().toISOString() }
  const patch: Record<string, unknown> = {}

  try {
    // --- Passo 1a: CNPJ publicado no SITE DO PRÓPRIO NEGÓCIO (rodapé) ---
    // Fonte mais direta que existe (o negócio declarando o próprio CNPJ);
    // quando acerta, economiza o SERP + scrape inteiros. O candidato ainda
    // passa por fonte oficial + gates + juiz como qualquer outro.
    const nomeLimpo = limparNome(lead.nome, lead.bairro)
    let cnpjs: string[] = []
    let origemSiteDoLead = false
    let handleDoSite: string | null = null // @ do IG achado no HTML do site (custo zero)
    if (lead.website) {
      // maxBytes alto: o CNPJ mora no RODAPÉ, e páginas de e-commerce passam
      // fácil de 500 KB (caso real: chocolatdujour.com.br tem 3,5 MB e o CNPJ
      // no offset ~2,3 MB — o cap default truncava antes do rodapé).
      const siteHtml = await safeFetchHtml(lead.website, { maxBytes: 4_000_000 })
      if (siteHtml) {
        cnpjs = extrairCnpjsDeHtml(siteHtml)
        // Aproveita o MESMO HTML pra achar o @ do Instagram (link no header/rodapé)
        // quando o lead ainda não tem handle — sem nenhuma chamada extra.
        if (!lead.instagram_handle) handleDoSite = handleFromHtml(siteHtml)
      }
      origemSiteDoLead = cnpjs.length > 0
      if (origemSiteDoLead) console.log('[enriquecer-lead] CNPJ no site do lead:', cnpjs)
      if (handleDoSite) console.log('[enriquecer-lead] @instagram no site do lead:', handleDoSite)
    }

    if (cnpjs.length === 0) {
      // --- Passos 0+1: Google Search ---
      const cidade = lead.cidade ?? 'São Paulo'
      const query = `"${nomeLimpo}" cnpj ${cidade}`
      const results = await buscarGoogle(scrapingdogKey, query)
      console.log(`[enriquecer-lead] query=${query} | ${results.length} resultados`)
      console.log('[enriquecer-lead] links:', results.map((r) => r.link).filter(Boolean).slice(0, 6))

      // --- Passo 2: extrair CNPJs (URL → título → snippet) ---
      cnpjs = extrairCnpjs(results)

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
    }
    console.log('[enriquecer-lead] CNPJs candidatos (SERP/site):', cnpjs)

    let matched: Candidato | null = null
    let confidence = 0

    // --- Passo 3: confirmar na fonte oficial os candidatos do SERP/site ---
    const confirmados: Candidato[] = []
    for (const cnpj of cnpjs) {
      const conf = await confirmarOficial(cnpj)
      if (conf) {
        confirmados.push(conf.cand)
        console.log(`[enriquecer-lead] ${cnpj} confirmado por ${conf.fonte}`)
      }
      await sleep(300)
    }

    // --- Passo 3b: ÍNDICE LOCAL da Receita (fonte primária; já oficial) ---
    // Aumenta o pool com candidatos achados por nome+cidade no banco — resolve
    // os nomes que o Google não devolve (1 query, sem Scrapingdog). Dedupe por
    // cnpj. Vazio antes do ETL → no-op (cai no comportamento atual).
    const locais = await buscarCnpjLocal(supabase, nomeLimpo, lead.cidade)
    for (const lc of locais) {
      if (!confirmados.some((c) => c.cnpj === lc.cnpj)) confirmados.push(localToCandidato(lc))
    }
    if (locais.length) console.log(`[enriquecer-lead] índice local → ${locais.length} candidato(s)`)

    if (confirmados.length > 0) {
      // --- Passo 3.5: gates determinísticos (situação ATIVA + município) ---
      // Sinais que já vêm das fontes oficiais; empresa baixada ou de outra
      // cidade nunca chega ao juiz.
      const candidatos: Candidato[] = []
      for (const cand of confirmados) {
        // Telefone do lead (Google) batendo com o da Receita = prova de identidade
        // (colisão entre empresas distintas é praticamente impossível). Nesse caso
        // ignoramos o gate de situação: um ESTABELECIMENTO baixado cujo telefone
        // ainda é o do negócio no Google é o negócio certo (ex.: Criminal Burguer,
        // filial baixada mas fantasia + telefone idênticos). O score decide depois.
        // Mesma lógica vale p/ NOME muito forte (fantasia ≈ exata): um
        // estabelecimento baixado cuja fantasia bate com o lead é a identidade
        // certa (ex.: "Margherita Pizzeria", filial baixada). Limite alto (0.85)
        // pra não deixar empresa baixada qualquer passar.
        const phoneHit = telefonesBatem(lead.telefone, cand.telefone)
        const nomeForte = nomeSimilaridade(lead.nome, cand.razao_social, cand.nome_fantasia) >= 0.85
        const motivo = (phoneHit || nomeForte) ? null : gateCandidato(lead, cand)
        if (motivo) {
          console.log(`[enriquecer-lead] gate reprovou ${cand.cnpj}: ${motivo}`)
        } else {
          candidatos.push(cand)
        }
      }

      // --- Passo 4: scoring determinístico → juiz só na zona ambígua ---
      // Sinais grátis (nome-sim + cruzamento de TELEFONE Google×Receita + CNAE)
      // decidem a maioria: telefone batendo OU nome forte = aceita sem juiz;
      // nome quase-nulo sem telefone ou CNAE de fachada = rejeita antes do juiz.
      // Só o meio ambíguo vai pro LLM — e ainda com piso de nome/telefone, pra
      // ele não aceitar "Banana Boat" como "Lellis" (erro real em produção).
      if (candidatos.length > 0) {
        const leadSig = { nome: lead.nome, telefone: lead.telefone, cidade: lead.cidade }
        const scored = candidatos.map((c) => ({ cand: c, sig: scoreCandidato(leadSig, c) }))
        const aceitos = scored.filter((s) => s.sig.decision === 'accept').sort((a, b) => b.sig.score - a.sig.score)

        if (aceitos.length > 0) {
          matched = aceitos[0].cand
          confidence = aceitos[0].sig.score
          console.log(`[enriquecer-lead] AUTO-ACEITE ${matched.cnpj} nameSim=${aceitos[0].sig.nameSim.toFixed(2)} phone=${aceitos[0].sig.phoneMatch}`)
        } else {
          for (const s of scored.filter((s) => s.sig.decision === 'reject')) {
            console.log(`[enriquecer-lead] REJEITA ${s.cand.cnpj} nameSim=${s.sig.nameSim.toFixed(2)} cnaeBad=${s.sig.cnaeBad}`)
          }
          const paraJuiz = scored.filter((s) => s.sig.decision === 'judge').map((s) => s.cand)
          if (paraJuiz.length > 0) {
            const escolha = await escolherCnpj(lead, paraJuiz, openrouterKey, origemSiteDoLead)
            confidence = escolha.confidence
            console.log(`[enriquecer-lead] juiz (${paraJuiz.length} cand., site=${origemSiteDoLead}) → best=${escolha.best_cnpj} conf=${confidence} (${escolha.motivo})`)
            if (escolha.best_cnpj && confidence >= CONF_MIN) {
              const cand = paraJuiz.find((c) => c.cnpj === escolha.best_cnpj) ?? null
              // Piso anti-invenção: o juiz não pode aceitar nome quase-nulo sem
              // telefone batendo (foi assim que "Lellis"→"Banana Boat" passou).
              if (cand) {
                const sig = scoreCandidato(leadSig, cand)
                if (sig.nameSim >= 0.35 || sig.phoneMatch) matched = cand
                else console.log(`[enriquecer-lead] juiz escolheu ${cand.cnpj} mas nameSim=${sig.nameSim.toFixed(2)} sem telefone → barrado`)
              }
            }
          }
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

    // --- Passo 6: Instagram (handle do site, se faltava) + seguidores ---
    // Handle efetivo = o que o lead já tinha OU o descoberto no HTML do site.
    // Persistimos o handle novo e buscamos os seguidores dele na mesma rodada.
    const handleEfetivo = lead.instagram_handle ?? handleDoSite
    if (handleDoSite) patch.instagram_handle = handleDoSite
    if (handleEfetivo && scrapingdogKey) {
      const followers = await buscarSeguidores(handleEfetivo, scrapingdogKey)
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

    // --- Sinais de qualificação (Macro 1) ---
    // bio_ponto_fisico: derivado do endereço do Google Places (ponto físico real).
    const pontoFisico = !!(lead.endereco && lead.endereco.trim())
    patch.bio_ponto_fisico = pontoFisico
    // Os sinais de bio (delivery, whatsapp_vendas) são definidos por
    // encontrar-whatsapp quando o Instagram é consultado. Lemos o que já está
    // gravado para não regredir um score anterior (e.g. re-enrich após whatsapp já rodou).
    const deliveryProprio = lead.bio_delivery_proprio ?? false
    const whatsappVendas = lead.bio_whatsapp_vendas ?? false
    // donoIdentificado usa o valor recém-resolvido nesta execução (patch.dono_nome)
    // ou o que já estava no banco, para incluir o sinal mesmo em re-enriches parciais.
    const donoNome = typeof patch.dono_nome === 'string' ? patch.dono_nome : (lead.dono_nome ?? null)
    const donoIdentificado = !!(donoNome && donoNome.trim())
    patch.lead_score = calcularLeadScore({ pontoFisico, deliveryProprio, whatsappVendas, donoIdentificado })

    const { data: updated, error: updErr } = await supabase
      .from('leads')
      .update(patch)
      .eq('id', leadId)
      .select('*')
      .single()
    if (updErr) throw updErr

    return json({ lead: updated, enrich_status: status })
  } catch (e) {
    console.error('[enriquecer-lead] erro:', e instanceof Error ? e.message : e)
    return json({ error: 'Falha ao enriquecer o lead.' }, 502)
  }
})
