// Pacing humano da Olivia (Fase B — believability).
// =============================================================================
// Parte PURA (sem I/O) — unit-testada no Vitest, usada pela olivia-responder.
//
// POR QUÊ: o maior "isto é um robô" não é o TEXTO (o prompt já é bom) — é o
// RITMO. Uma resposta que chega em <1s, 24h por dia, denuncia o bot. Aqui
// calculamos um atraso proporcional ao tamanho da resposta (simula ler + digitar)
// com piso, teto e jitter. O teto mantém a função dentro do limite de execução;
// o atraso é espera ociosa (não consome CPU — barato no modelo de Active CPU).
// =============================================================================

export interface PacingOpts {
  minMs?: number      // piso: ninguém responde instantâneo
  maxMs?: number      // teto: segura dentro do limite da edge function
  msPorChar?: number  // "velocidade de digitação"
  jitter?: number     // variação aleatória ±fração (0.25 = ±25%)
  rand?: () => number // injeção p/ teste determinístico (default Math.random)
}

/**
 * Atraso (ms) que a Olivia "leva" pra responder uma mensagem de `texto`.
 * Proporcional ao tamanho + jitter, sempre dentro de [minMs, maxMs].
 */
export function pacingDelayMs(texto: string | null | undefined, opts: PacingOpts = {}): number {
  const { minMs = 4000, maxMs = 22000, msPorChar = 45, jitter = 0.25, rand = Math.random } = opts
  const len = (texto ?? '').trim().length
  const base = minMs + len * msPorChar
  const fator = 1 + (rand() * 2 - 1) * jitter // ±jitter
  const comJitter = base * fator
  return Math.round(Math.max(minMs, Math.min(maxMs, comJitter)))
}
