// Parser do formatted_address legado do Google Places (módulo sourcing).
// =============================================================================
// Sem I/O — só parsing puro, unit-testado no Vitest e usado pela Edge Function
// `buscar-negocios` (Deno).
//
// POR QUÊ: o bairro do lead vinha do TERMO DE BUSCA — o Google devolve
// resultados de bairros vizinhos e todos ganhavam o rótulo pesquisado
// (ISSUE-002). O endereço formatado carrega o bairro REAL:
//   "<rua>, <nº>[ - complemento] - <bairro>, <cidade> - <UF>, <CEP>, Brazil"
// =============================================================================

export interface EnderecoParseado {
  bairro: string | null
  cidade: string | null
}

/**
 * Extrai bairro e cidade reais do formatted_address. Devolve null quando o
 * formato não é reconhecido — o caller cai no fallback (termo pesquisado).
 */
export function parseEnderecoFormatado(
  endereco: string | null | undefined,
): EnderecoParseado | null {
  if (!endereco) return null

  // Âncora: ", <cidade> - <UF>," — só o par cidade-UF tem esse shape.
  const m = endereco.match(/,\s*([^,]+?)\s*-\s*([A-Z]{2})\s*,/)
  if (!m || m.index == null) return null
  const cidade = m[1].trim() || null

  // Tudo antes da âncora: "<rua>, <nº>[ - complemento] - <bairro>".
  // O bairro é o último segmento separado por " - " (complementos vêm antes).
  const antes = endereco.slice(0, m.index)
  const partes = antes.split(' - ').map((s) => s.trim()).filter(Boolean)
  let bairro: string | null = null
  if (partes.length > 1) {
    const cand = partes[partes.length - 1]
    // Número solto não é bairro (ex.: "Rua Augusta - 255").
    if (cand && !/^\d/.test(cand)) bairro = cand
  }

  return { bairro, cidade }
}
