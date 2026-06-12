// Autocomplete de localidade (Google Places Autocomplete, New API).
// =============================================================================
// Parte PURA (sem I/O), unit-testada no Vitest e usada pela Edge Function
// `autocomplete-local`.
//
// POR QUÊ: digitar "Alta Floresta" é ambíguo (cidade no MT, bairros homônimos
// em outros estados). O dropdown deixa o usuário ESCOLHER o lugar certo; a
// descrição completa ("Alta Floresta, MT, Brasil") vai como `local` da busca e
// desambigua o textQuery do Places.
// =============================================================================

export interface LocalSugestao {
  place_id: string
  /** Texto principal (ex.: "Alta Floresta"). */
  principal: string
  /** Contexto que desambigua (ex.: "Mato Grosso, Brasil"). */
  secundario: string | null
  /** Descrição completa — é o que vira o `local` da busca. */
  descricao: string
}

/**
 * Normaliza a resposta do POST places:autocomplete. Tolerante a formato
 * inesperado (devolve []) e intolerante a sugestão sem id/texto (descartada).
 */
export function parseAutocompleteSuggestions(body: unknown, max = 6): LocalSugestao[] {
  const sugestoes = (body as Record<string, any>)?.suggestions
  if (!Array.isArray(sugestoes)) return []
  const out: LocalSugestao[] = []
  for (const s of sugestoes) {
    const p = s?.placePrediction
    const placeId = typeof p?.placeId === 'string' ? p.placeId : null
    const descricao = typeof p?.text?.text === 'string' ? p.text.text.trim() : ''
    if (!placeId || !descricao) continue
    const principal =
      typeof p?.structuredFormat?.mainText?.text === 'string'
        ? p.structuredFormat.mainText.text.trim()
        : descricao
    const secundario =
      typeof p?.structuredFormat?.secondaryText?.text === 'string'
        ? p.structuredFormat.secondaryText.text.trim() || null
        : null
    out.push({ place_id: placeId, principal, secundario, descricao })
    if (out.length >= max) break
  }
  return out
}
