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
