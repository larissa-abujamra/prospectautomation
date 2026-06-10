// Gates determinísticos para candidatos a CNPJ (módulo enriquecimento).
// =============================================================================
// Sem I/O — só lógica pura, unit-testada no Vitest e usada pela Edge Function
// `enriquecer-lead` (Deno).
//
// POR QUÊ: os 3 matches de candidato ÚNICO em produção (aceitos sem juiz, com
// confidence=1) estavam TODOS errados — um deles era uma empresa BAIXADA, outro
// um leiloeiro para uma padaria. A situação cadastral e o município já vinham
// nas respostas das fontes oficiais; agora são bloqueio explícito ANTES do
// juiz. Sinal desconhecido (null) não decide — passa adiante para o juiz.
// =============================================================================

const norm = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()

// CNPJ com máscara opcional (XX.XXX.XXX/XXXX-XX ou 14 dígitos corridos).
export const CNPJ_RE = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g

const onlyDigits = (s: string): string => s.replace(/\D/g, '')

/** Validação de CNPJ por dígito verificador (módulo 11). */
export function cnpjValido(cnpj: string): boolean {
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

/**
 * Extrai CNPJs VÁLIDOS do texto visível de um HTML (rodapé do site do próprio
 * negócio — a fonte mais direta que existe). Scripts/styles ficam de fora;
 * cada match passa pelo dígito verificador; dedupe; cap de 5.
 * Quem consome ainda confirma na fonte oficial + gates + juiz.
 */
export function extrairCnpjsDeHtml(html: string | null | undefined): string[] {
  if (!html) return []
  const text = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.match(CNPJ_RE) ?? []) {
    const c = onlyDigits(m)
    if (c.length === 14 && cnpjValido(c) && !seen.has(c)) {
      seen.add(c)
      out.push(c)
      if (out.length >= 5) break
    }
  }
  return out
}

/** ATIVA → true; BAIXADA/SUSPENSA/INAPTA/NULA → false; desconhecida → null. */
export function situacaoAtiva(situacao: string | null | undefined): boolean | null {
  if (situacao == null || String(situacao).trim() === '') return null
  return norm(String(situacao)).startsWith('ativ')
}

/** Mesma cidade (sem acento/caixa) → true; diferente → false; faltando → null. */
export function cidadeCompativel(
  leadCidade: string | null | undefined,
  candMunicipio: string | null | undefined,
): boolean | null {
  if (!leadCidade || !candMunicipio) return null
  return norm(leadCidade) === norm(candMunicipio)
}

/**
 * Aplica os gates a um candidato confirmado na fonte oficial.
 * Devolve o MOTIVO da rejeição, ou null se o candidato pode seguir pro juiz.
 * Só rejeita com sinal POSITIVO de incompatibilidade — dado faltante passa.
 */
export function gateCandidato(
  _lead: { cidade: string | null },
  cand: { situacao: string | null; municipio: string | null },
): string | null {
  if (situacaoAtiva(cand.situacao) === false) {
    return `situação cadastral "${cand.situacao}" (não ATIVA)`
  }
  // Município NÃO é mais bloqueio aqui: uma marca pode ter a MATRIZ registrada
  // em outra cidade e operar uma loja na cidade do lead (caso real: "PADOCA DO
  // GAEL LTDA" matriz em Dourados/MS, loja em Pinheiros/SP — o gate de cidade
  // matava o match certo). Virou sinal de score (ver scoreCandidato): cidade
  // diferente só reprova quando o NOME também é fraco.
  return null
}

// =============================================================================
// Scoring determinístico de candidato (Phase 1 — precisão do match)
// =============================================================================
// O juiz LLM sozinho (threshold 0.5) aceitava matches plausíveis-mas-errados:
// "Lellis Trattoria" → "BANANA BOAT BAR E LANCHES", "Criminal Burguer" → uma
// "ASSESSORIA E APOIO ADMINISTRATIVO". Estes sinais determinísticos — sobretudo
// o cruzamento de TELEFONE (o lead já traz o telefone do Google em 95% dos
// casos) — matam esses erros antes (ou ao invés) do juiz.

// Palavras genéricas de ramo/jurídicas que não distinguem um negócio do outro.
const STOPWORDS = new Set([
  'confeitaria', 'doceria', 'restaurante', 'bar', 'lanches', 'lanchonete', 'padaria',
  'pizzaria', 'pizzeria', 'pizza', 'hamburgueria', 'burger', 'burguer', 'pet', 'petshop', 'shop',
  'cafe', 'cafeteria', 'patisserie', 'patisserie', 'forneria', 'bistro', 'brasserie', 'boulangerie', 'trattoria', 'comercio',
  'comercial', 'alimentos', 'alimenticios', 'servicos', 'industria', 'eireli',
  'ltda', 'me', 'epp', 'sa', 'mei', 'de', 'da', 'do', 'das', 'dos', 'e', 'the',
])

function tokensSignificativos(s: string): string[] {
  return norm(s)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/**
 * Similaridade de nome (0..1): Jaccard sobre tokens significativos (sem palavras
 * genéricas de ramo/jurídicas). Usa o MELHOR entre razão social e nome fantasia.
 */
export function nomeSimilaridade(
  leadNome: string,
  razao: string | null | undefined,
  fantasia: string | null | undefined,
): number {
  const L = new Set(tokensSignificativos(leadNome))
  if (L.size === 0) return 0
  const sim = (cand: string | null | undefined): number => {
    if (!cand) return 0
    const C = new Set(tokensSignificativos(cand))
    if (C.size === 0) return 0
    let inter = 0
    for (const t of L) if (C.has(t)) inter++
    if (inter === 0) return 0
    // max(cobertura, jaccard): "cobertura" = quanto do nome do lead aparece no
    // candidato (resgata marca de 1 palavra cuja razão social tem muitos termos,
    // ex. "Selvvva" → "SELVVVA PLANTAS E OBJETOS…"); jaccard premia match justo.
    const union = new Set([...L, ...C]).size
    const cobertura = inter / L.size
    const jaccard = inter / union
    return Math.max(cobertura, jaccard)
  }
  return Math.max(sim(razao), sim(fantasia))
}

/** Quantos tokens significativos do nome do lead aparecem no candidato (máx
 * entre razão e fantasia). Usado para distinguir match de 1 token genérico
 * ("Central") de match de marca (≥2 tokens: "padoca"+"gael"). */
export function tokensComunsNome(
  leadNome: string,
  razao: string | null | undefined,
  fantasia: string | null | undefined,
): number {
  const L = new Set(tokensSignificativos(leadNome))
  const conta = (cand: string | null | undefined): number => {
    if (!cand) return 0
    const C = new Set(tokensSignificativos(cand))
    let n = 0
    for (const t of L) if (C.has(t)) n++
    return n
  }
  return Math.max(conta(razao), conta(fantasia))
}

const soDigitos = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '')
// Número nacional: tira o DDI 55 (mantém DDD + assinante).
const nacional = (d: string): string => (d.length >= 12 && d.startsWith('55') ? d.slice(2) : d)

/**
 * O telefone do lead (Google) bate com o telefone REGISTRADO do candidato na
 * Receita? Compara o número nacional (DDD+assinante), ignorando formatação/DDI.
 * Match exato = sinal fortíssimo de que é a empresa certa.
 */
export function telefonesBatem(
  leadTel: string | null | undefined,
  candTel: string | null | undefined,
): boolean {
  const a = nacional(soDigitos(leadTel))
  const b = nacional(soDigitos(candTel))
  if (a.length < 10 || b.length < 10) return false
  return a === b || a.slice(-8) === b.slice(-8)
}

// CNAE que quase nunca é o do estabelecimento de varejo/alimentação do lead
// (empresa de fachada/holding/assessoria — origem de matches errados).
const CNAE_IMPLAUSIVEL =
  /(assessoria|apoio administrativo|gestao de participa|holding|consultoria em gest|escritorio|locacao de|atividades de associacoes)/i

export function cnaeImplausivel(cnae: string | null | undefined): boolean {
  return !!cnae && CNAE_IMPLAUSIVEL.test(norm(cnae))
}

export interface CandSignals {
  nameSim: number
  phoneMatch: boolean
  cnaeBad: boolean
  score: number
  decision: 'accept' | 'reject' | 'judge'
}

/**
 * Combina os sinais determinísticos num score 0..1 + decisão:
 *  - accept: telefone bate OU nome muito forte (≥0.8) → dispensa o juiz.
 *  - reject: nome quase nulo sem telefone, OU CNAE de fachada sem nome forte.
 *  - judge: zona ambígua → vai pro juiz LLM (que recebe estes sinais).
 */
export function scoreCandidato(
  lead: { nome: string; telefone: string | null; cidade?: string | null },
  cand: { razao_social: string | null; nome_fantasia: string | null; telefone: string | null; cnae: string | null; municipio?: string | null },
): CandSignals {
  const nameSim = nomeSimilaridade(lead.nome, cand.razao_social, cand.nome_fantasia)
  const shared = tokensComunsNome(lead.nome, cand.razao_social, cand.nome_fantasia)
  const phoneMatch = telefonesBatem(lead.telefone, cand.telefone)
  const cnaeBad = cnaeImplausivel(cand.cnae)
  // Cidade divergente é um sinal NEGATIVO fraco — só pesa quando o nome não é
  // forte (marca com matriz em outra cidade ainda casa por nome/telefone).
  const cityDiff = cidadeCompativel(lead.cidade, cand.municipio) === false

  let score = nameSim
  if (phoneMatch) score = Math.max(score, 0.95)
  if (cnaeBad && !phoneMatch) score = Math.min(score, nameSim * 0.5)
  // Penalidade leve de cidade divergente (sem telefone): desempata a favor do
  // estabelecimento da MESMA cidade quando dois homônimos casam o nome (ex.:
  // "Margherita Pizzeria" SP vs "La Margherita" Macaé) — o de SP ganha.
  if (cityDiff && !phoneMatch) score *= 0.9

  // Aceite por nome forte exige que, em OUTRA cidade, haja ≥2 tokens em comum —
  // assim "Padoca do Gael" (padoca+gael) aceita mesmo matriz em Dourados, mas
  // "Padaria Central" (só "central") NÃO auto-aceita um homônimo de outra cidade.
  const nomeForteAceitavel = nameSim >= 0.8 && !(cityDiff && shared < 2)

  let decision: 'accept' | 'reject' | 'judge'
  if (phoneMatch || nomeForteAceitavel) decision = 'accept'
  else if (
    (nameSim < 0.3 && !phoneMatch) ||
    (cnaeBad && nameSim < 0.5) ||
    (cityDiff && nameSim < 0.6 && !phoneMatch) // outra cidade + nome fraco → não é match
  ) decision = 'reject'
  else decision = 'judge'

  return { nameSim, phoneMatch, cnaeBad, score, decision }
}
