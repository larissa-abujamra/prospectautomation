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
  urgency?: 'normal' | 'urgent' | 'system'
  disabled?: boolean
  dryRun?: boolean
  testMode?: boolean
  urgentMinMs?: number
  urgentMaxMs?: number
  urgentMsPorChar?: number
  systemMinMs?: number
  systemMaxMs?: number
  systemMsPorChar?: number
  multipart?: boolean
  maxParts?: number
  partPauseMinMs?: number
  partPauseMaxMs?: number
  partPauseMsPorChar?: number
}

/**
 * Atraso (ms) que a Olivia "leva" pra responder uma mensagem de `texto`.
 * Proporcional ao tamanho + jitter, sempre dentro de [minMs, maxMs].
 */
export function pacingDelayMs(texto: string | null | undefined, opts: PacingOpts = {}): number {
  if (opts.disabled || opts.dryRun || opts.testMode) return 0
  const urgency = opts.urgency ?? 'normal'
  const minMs = urgency === 'system'
    ? opts.systemMinMs ?? 500
    : urgency === 'urgent'
      ? opts.urgentMinMs ?? 700
      : opts.minMs ?? 1800
  const maxMs = urgency === 'system'
    ? opts.systemMaxMs ?? 1800
    : urgency === 'urgent'
      ? opts.urgentMaxMs ?? 3200
      : opts.maxMs ?? 12000
  const msPorChar = urgency === 'system'
    ? opts.systemMsPorChar ?? 10
    : urgency === 'urgent'
      ? opts.urgentMsPorChar ?? 18
      : opts.msPorChar ?? 28
  const { jitter = 0.2, rand = Math.random } = opts
  const len = (texto ?? '').trim().length
  const base = minMs + len * msPorChar
  const fator = 1 + (rand() * 2 - 1) * jitter // ±jitter
  const comJitter = base * fator
  return Math.round(Math.max(minMs, Math.min(maxMs, comJitter)))
}

export function splitReplyParts(texto: string | null | undefined, opts: PacingOpts = {}): string[] {
  const full = (texto ?? '').trim()
  if (!full) return []
  if (!opts.multipart) return [full]

  const maxParts = opts.maxParts ?? 3
  const parts = full
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length <= 1 || parts.length > maxParts) return [full]
  return parts
}

function partPauseDelayMs(texto: string, opts: PacingOpts): number {
  if (opts.disabled || opts.dryRun || opts.testMode) return 0
  const minMs = opts.partPauseMinMs ?? 900
  const maxMs = opts.partPauseMaxMs ?? 3200
  const msPorChar = opts.partPauseMsPorChar ?? 8
  const { jitter = 0.2, rand = Math.random } = opts
  const base = minMs + texto.trim().length * msPorChar
  const fator = 1 + (rand() * 2 - 1) * jitter
  return Math.round(Math.max(minMs, Math.min(maxMs, base * fator)))
}

export interface ReplyPacingPlan {
  parts: string[]
  initialDelayMs: number
  betweenPartDelayMs: number[]
  totalDelayMs: number
}

export function buildReplyPacingPlan(
  texto: string | null | undefined,
  opts: PacingOpts = {},
): ReplyPacingPlan {
  const parts = splitReplyParts(texto, opts)
  const initialDelayMs = pacingDelayMs(parts[0] ?? '', opts)
  const betweenPartDelayMs = parts.slice(1).map((part) => partPauseDelayMs(part, opts))
  const totalDelayMs = initialDelayMs + betweenPartDelayMs.reduce((sum, ms) => sum + ms, 0)

  return { parts, initialDelayMs, betweenPartDelayMs, totalDelayMs }
}
