import { describe, it, expect } from 'vitest'
import { parseAutocompleteSuggestions } from '../../../supabase/functions/_shared/autocomplete_local.ts'

const sugestao = (placeId: string, texto: string, principal?: string, secundario?: string) => ({
  placePrediction: {
    placeId,
    text: { text: texto },
    ...(principal
      ? {
          structuredFormat: {
            mainText: { text: principal },
            ...(secundario ? { secondaryText: { text: secundario } } : {}),
          },
        }
      : {}),
  },
})

describe('parseAutocompleteSuggestions', () => {
  it('normaliza sugestões com texto estruturado (principal + contexto)', () => {
    const out = parseAutocompleteSuggestions({
      suggestions: [
        sugestao('p1', 'Alta Floresta, MT, Brasil', 'Alta Floresta', 'MT, Brasil'),
        sugestao('p2', 'Alta Floresta (bairro), Cuiabá - MT', 'Alta Floresta (bairro)', 'Cuiabá - MT'),
      ],
    })
    expect(out).toEqual([
      { place_id: 'p1', principal: 'Alta Floresta', secundario: 'MT, Brasil', descricao: 'Alta Floresta, MT, Brasil' },
      { place_id: 'p2', principal: 'Alta Floresta (bairro)', secundario: 'Cuiabá - MT', descricao: 'Alta Floresta (bairro), Cuiabá - MT' },
    ])
  })

  it('sem structuredFormat → principal cai na descrição completa', () => {
    const out = parseAutocompleteSuggestions({ suggestions: [sugestao('p1', 'Pinheiros, São Paulo')] })
    expect(out[0]).toMatchObject({ principal: 'Pinheiros, São Paulo', secundario: null })
  })

  it('descarta sugestão sem placeId/texto; respeita o teto; payload podre → []', () => {
    const out = parseAutocompleteSuggestions(
      {
        suggestions: [
          { placePrediction: { text: { text: 'sem id' } } },
          ...Array.from({ length: 10 }, (_, i) => sugestao(`p${i}`, `Lugar ${i}`)),
        ],
      },
      3,
    )
    expect(out.map((s) => s.place_id)).toEqual(['p0', 'p1', 'p2'])
    expect(parseAutocompleteSuggestions(null)).toEqual([])
    expect(parseAutocompleteSuggestions({ suggestions: 'x' })).toEqual([])
  })
})
