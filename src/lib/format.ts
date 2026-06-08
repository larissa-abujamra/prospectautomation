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

// Data ISO → "08/06/2026". Vazio → "—".
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleDateString('pt-BR')
}

// CNPJ "12345678000190" → "12.345.678/0001-90". Vazio/ inválido → "—".
export function fmtCnpj(cnpj: string | null | undefined): string {
  if (!cnpj) return DASH
  const d = cnpj.replace(/\D/g, '')
  if (d.length !== 14) return cnpj
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}
