import { describe, it, expect } from 'vitest'
import {
  bboxDeCentroRaio,
  dimensoesKm,
  gerarGrade,
  estimarCusto,
  MAX_CELULAS,
} from '../../../supabase/functions/_shared/geo_grid'

// Centro aproximado da cidade de São Paulo.
const SP = { lat: -23.5505, lng: -46.6333 }

describe('bboxDeCentroRaio', () => {
  it('gera uma bbox ~quadrada de lado 2*raio centrada no ponto', () => {
    const bbox = bboxDeCentroRaio(SP.lat, SP.lng, 10)
    const { alturaKm, larguraKm } = dimensoesKm(bbox)
    // ~20 km de lado (2*raio), com tolerância pela curvatura.
    expect(alturaKm).toBeGreaterThan(19)
    expect(alturaKm).toBeLessThan(21)
    expect(larguraKm).toBeGreaterThan(19)
    expect(larguraKm).toBeLessThan(21)
    // centro preservado
    expect((bbox.low.lat + bbox.high.lat) / 2).toBeCloseTo(SP.lat, 4)
    expect((bbox.low.lng + bbox.high.lng) / 2).toBeCloseTo(SP.lng, 4)
  })
})

describe('gerarGrade', () => {
  it('ladrilha uma bbox de ~20km em células de ~2km (~10x10)', () => {
    const bbox = bboxDeCentroRaio(SP.lat, SP.lng, 10) // 20km de lado
    const celulas = gerarGrade(bbox, 2)
    // ~10 linhas × ~10 colunas. Tolerância pelo ceil/curvatura.
    expect(celulas.length).toBeGreaterThanOrEqual(90)
    expect(celulas.length).toBeLessThanOrEqual(121)
    // cobre a bbox: 1ª célula começa no canto low, última termina no canto high
    expect(celulas[0].low.lat).toBeCloseTo(bbox.low.lat, 6)
    expect(celulas[celulas.length - 1].high.lat).toBeCloseTo(bbox.high.lat, 6)
    expect(celulas[celulas.length - 1].high.lng).toBeCloseTo(bbox.high.lng, 6)
  })

  it('cada célula tem center dentro do seu próprio retângulo', () => {
    const bbox = bboxDeCentroRaio(SP.lat, SP.lng, 5)
    for (const c of gerarGrade(bbox, 1)) {
      expect(c.center.lat).toBeGreaterThanOrEqual(c.low.lat)
      expect(c.center.lat).toBeLessThanOrEqual(c.high.lat)
      expect(c.center.lng).toBeGreaterThanOrEqual(c.low.lng)
      expect(c.center.lng).toBeLessThanOrEqual(c.high.lng)
    }
  })

  it('determinística: mesma entrada → mesma grade', () => {
    const bbox = bboxDeCentroRaio(SP.lat, SP.lng, 8)
    expect(gerarGrade(bbox, 2)).toEqual(gerarGrade(bbox, 2))
  })

  it('cellKm >= bbox → 1 célula (a bbox inteira), nunca explode', () => {
    const bbox = bboxDeCentroRaio(SP.lat, SP.lng, 3)
    expect(gerarGrade(bbox, 50)).toHaveLength(1)
  })

  it('cellKm inválido (0/NaN) → 1 célula, sem loop infinito', () => {
    const bbox = bboxDeCentroRaio(SP.lat, SP.lng, 3)
    expect(gerarGrade(bbox, 0)).toHaveLength(1)
    expect(gerarGrade(bbox, NaN)).toHaveLength(1)
  })

  it('respeita o teto MAX_CELULAS mesmo pedindo células minúsculas num estado inteiro', () => {
    // bbox enorme (~500km) com células de 1km pediria 250k células → capado.
    const bbox = bboxDeCentroRaio(SP.lat, SP.lng, 250)
    const celulas = gerarGrade(bbox, 1)
    expect(celulas.length).toBeLessThanOrEqual(MAX_CELULAS)
    expect(celulas.length).toBeGreaterThan(0)
  })
})

describe('estimarCusto', () => {
  it('requisições = células × termos × páginas; usd por $32/mil', () => {
    const c = estimarCusto(100, { termosPorCelula: 2, paginasPorConsulta: 3, usdPorMil: 32 })
    expect(c.requisicoes).toBe(600) // 100*2*3
    expect(c.usd).toBeCloseTo(19.2, 2) // 600/1000*32
  })
  it('defaults sãos (1 termo, 2 páginas)', () => {
    expect(estimarCusto(50).requisicoes).toBe(100)
  })
})
