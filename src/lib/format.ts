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

// Data + hora curtas (transcript da conversa, horário de reunião). Ex.: "10/06 15:42".
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? DASH
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// Pluralização pt-BR simples (cobre os setores usados: pizzaria→pizzarias,
// restaurante→restaurantes, salão→salões…).
function pluralizar(s: string): string {
  if (s.endsWith('s')) return s
  if (s.endsWith('ão')) return s.slice(0, -2) + 'ões'
  if (s.endsWith('r') || s.endsWith('z')) return s + 'es'
  if (s.endsWith('m')) return s.slice(0, -1) + 'ns'
  return s + 's'
}

// Substantivo de contagem conforme o setor filtrado. Sem setor → "negócio(s)".
// Ex.: ("Pizzaria", 5) → "pizzarias"; (null, 1) → "negócio".
export function nounSetor(setor: string | null | undefined, count: number): string {
  const singular = setor && setor.trim() ? setor.trim().toLowerCase() : 'negócio'
  return count === 1 ? singular : pluralizar(singular)
}

// Faixa de faturamento ESTIMADA pelo porte legal (não é receita medida).
// MEI é checado antes do porte (MEI vem com porte "MICRO EMPRESA").
export function faixaFaturamento(
  porte: string | null | undefined,
  mei: boolean | null | undefined,
): string {
  if (mei === true) return 'MEI · até R$ 81 mil/ano'
  if (!porte) return DASH
  const p = porte.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  if (p.includes('PEQUENO')) return 'Pequeno porte · R$ 360 mil – 4,8 mi/ano'
  if (p.includes('MICRO')) return 'Microempresa · até R$ 360 mil/ano'
  return 'Demais · acima de R$ 4,8 mi/ano'
}

// CNPJ "12345678000190" → "12.345.678/0001-90". Vazio/ inválido → "—".
export function fmtCnpj(cnpj: string | null | undefined): string {
  if (!cnpj) return DASH
  const d = cnpj.replace(/\D/g, '')
  if (d.length !== 14) return cnpj
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}
