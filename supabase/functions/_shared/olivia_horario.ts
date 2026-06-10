// Horário comercial da Olivia (Fase B — believability/timing).
// =============================================================================
// Parte PURA (sem I/O) — unit-testada no Vitest, usada pela olivia-responder e
// pela olivia-flush.
//
// POR QUÊ: responder uma cold-outreach às 3h da manhã denuncia o bot tanto quanto
// a velocidade. Fora do horário comercial a Olivia NÃO responde na hora — adia
// pra próxima abertura (a olivia-flush envia quando o expediente abre).
//
// Tudo calculado no fuso configurado (default America/Sao_Paulo) via Intl, sem
// depender do fuso do servidor (edge functions rodam em UTC).
// =============================================================================

export interface HorarioOpts {
  tz?: string // IANA tz; default 'America/Sao_Paulo'
  dias?: number[] // dias úteis: 0=Dom … 6=Sáb; default seg–sex
  inicio?: number // hora de abertura (0–23); default 9
  fim?: number // hora de fechamento (0–23, exclusiva); default 19
}

const PADRAO: Required<HorarioOpts> = {
  tz: 'America/Sao_Paulo',
  dias: [1, 2, 3, 4, 5],
  inicio: 9,
  fim: 19,
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// Dia-da-semana (0–6) e hora (0–23) LOCAIS no fuso `tz` — independente do fuso
// do servidor.
function partesLocais(d: Date, tz: string): { dow: number; hora: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  return { dow: DOW[wd] ?? 1, hora: hh % 24 }
}

/** true se `iso` cai dentro do horário comercial (dia útil + hora na janela). */
export function dentroDoHorario(iso: string | number | Date, opts: HorarioOpts = {}): boolean {
  const { tz, dias, inicio, fim } = { ...PADRAO, ...opts }
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  const { dow, hora } = partesLocais(d, tz)
  return dias.includes(dow) && hora >= inicio && hora < fim
}

/**
 * Próximo instante (ISO) DENTRO do horário comercial a partir de `iso`. Avança em
 * passos de 15min (correto no fuso via dentroDoHorario) — granularidade suficiente:
 * a olivia-flush roda periodicamente e pega o adiado na abertura. Só faz sentido
 * chamar quando `iso` está FORA do horário.
 */
export function proximaAbertura(iso: string | number | Date, opts: HorarioOpts = {}): string {
  const base = iso instanceof Date ? iso : new Date(iso)
  const passo = 15 * 60 * 1000
  let t = base.getTime()
  // Teto: ~8 dias de passos de 15min (cobre feriado prolongado improvável + folga).
  for (let i = 0; i < 8 * 24 * 4 + 8; i++) {
    t += passo
    if (dentroDoHorario(t, opts)) return new Date(t).toISOString()
  }
  // Fallback defensivo (nunca deve cair aqui com config sã): +24h.
  return new Date(base.getTime() + 24 * 60 * 60 * 1000).toISOString()
}
