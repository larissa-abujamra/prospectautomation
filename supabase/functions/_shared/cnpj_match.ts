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
  lead: { cidade: string | null },
  cand: { situacao: string | null; municipio: string | null },
): string | null {
  if (situacaoAtiva(cand.situacao) === false) {
    return `situação cadastral "${cand.situacao}" (não ATIVA)`
  }
  if (cidadeCompativel(lead.cidade, cand.municipio) === false) {
    return `município "${cand.municipio}" diverge de "${lead.cidade}"`
  }
  return null
}
