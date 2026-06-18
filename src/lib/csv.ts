// Geração e download de CSV pronto pra abrir no Excel pt-BR.
// Usa separador ';' (padrão do Excel em português) + BOM UTF-8 (acentos corretos
// no duplo-clique). Cada célula é escapada: aspas/; /quebra de linha → entre aspas.

type Cell = string | number | null | undefined

const BOM = '﻿'

function escapeCell(v: Cell): string {
  if (v == null) return ''
  const s = String(v)
  if (/[";\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Monta o conteúdo CSV (cabeçalho + linhas). */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const linhas = [headers, ...rows].map((linha) => linha.map(escapeCell).join(';'))
  return BOM + linhas.join('\r\n')
}

/** Dispara o download do CSV no navegador. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
