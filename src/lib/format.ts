// Formatação pt-BR + o traço do princípio anti-invenção.
// Dado ausente NUNCA é chutado: aparece como DASH ("—") na UI.

export const DASH = '—'

const intFmt = new Intl.NumberFormat('pt-BR')

export function fmtInt(n: number | null | undefined): string {
  return n == null ? DASH : intFmt.format(n)
}

// Nota do Google com vírgula decimal: 4.7 → "4,7".
export function fmtRating(n: number | null | undefined): string {
  return n == null
    ? DASH
    : n.toLocaleString('pt-BR', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
}

export function fmtText(s: string | null | undefined): string {
  return s == null || s === '' ? DASH : s
}
