// Grade geográfica para busca em massa (tiling).
// =============================================================================
// Partes PURAS (sem I/O), unit-testadas no Vitest e usadas pela Edge Function
// `buscar-grade`.
//
// PROBLEMA QUE RESOLVE: o Google Places Text Search devolve no MÁXIMO 60
// resultados por consulta (20×3 páginas). Uma cidade inteira tem milhares de
// negócios — então uma única busca "docerias em São Paulo" nunca passa de 60.
// A solução é LADRILHAR a área (cidade/região) numa grade de células pequenas e
// rodar uma consulta POR CÉLULA, com `locationRestriction` (retângulo), dedupando
// por place_id no caller. Cada célula densa rende até 60; a soma escala pra
// milhares.
//
// Anti-custo: a grade tem TETO de células (MAX_CELULAS) e o caller estima o
// custo (estimarCusto) antes de rodar — Places é cobrado por requisição.
// =============================================================================

export interface LatLng {
  lat: number
  lng: number
}

// Retângulo no formato que a Places API (New) espera em locationRestriction.
export interface Retangulo {
  low: LatLng
  high: LatLng
}

export interface Celula {
  low: LatLng
  high: LatLng
  center: LatLng
}

// km por grau. Latitude é ~constante; longitude encolhe com o cosseno da latitude.
const KM_POR_GRAU_LAT = 110.574
const KM_POR_GRAU_LNG_EQUADOR = 111.320
const rad = (g: number) => (g * Math.PI) / 180

// Teto duro de células por grade — trava anti-runaway/custo. Uma grade maior que
// isto deve ser quebrada em várias regiões pelo caller (ex.: por município).
export const MAX_CELULAS = 2000

function kmPorGrauLng(lat: number): number {
  // Em latitudes extremas o cosseno → 0; clamp pra não estourar a divisão.
  return Math.max(KM_POR_GRAU_LNG_EQUADOR * Math.cos(rad(lat)), 1e-6)
}

/**
 * Bounding box QUADRADA (em km) ao redor de um centro: lado = 2*raioKm. Usada
 * quando o usuário escolhe "centro + raio" (ex.: 25 km ao redor do centro de SP).
 */
export function bboxDeCentroRaio(lat: number, lng: number, raioKm: number): Retangulo {
  const dLat = raioKm / KM_POR_GRAU_LAT
  const dLng = raioKm / kmPorGrauLng(lat)
  return {
    low: { lat: lat - dLat, lng: lng - dLng },
    high: { lat: lat + dLat, lng: lng + dLng },
  }
}

/** Dimensões aproximadas (km) de uma bbox: altura (N-S) e largura (L-O na latitude média). */
export function dimensoesKm(bbox: Retangulo): { alturaKm: number; larguraKm: number } {
  const alturaKm = (bbox.high.lat - bbox.low.lat) * KM_POR_GRAU_LAT
  const latMedia = (bbox.high.lat + bbox.low.lat) / 2
  const larguraKm = (bbox.high.lng - bbox.low.lng) * kmPorGrauLng(latMedia)
  return { alturaKm: Math.abs(alturaKm), larguraKm: Math.abs(larguraKm) }
}

/**
 * Ladrilha uma bbox em células de ~cellKm de lado. Determinística (mesma entrada
 * → mesma grade) pra ser testável e pra um job poder retomar pelo índice. Respeita
 * MAX_CELULAS: se a grade pedida passar do teto, aumenta a célula proporcionalmente
 * (degrada a granularidade em vez de estourar o custo). cellKm inválido → 1 célula
 * (a bbox inteira), nunca explode.
 */
export function gerarGrade(bbox: Retangulo, cellKm: number): Celula[] {
  const { alturaKm, larguraKm } = dimensoesKm(bbox)
  if (!(cellKm > 0) || !Number.isFinite(cellKm)) {
    return [celula(bbox.low, bbox.high)]
  }

  let linhas = Math.max(1, Math.ceil(alturaKm / cellKm))
  let colunas = Math.max(1, Math.ceil(larguraKm / cellKm))
  // Teto de custo: se passar de MAX_CELULAS, reduz a resolução mantendo a proporção.
  if (linhas * colunas > MAX_CELULAS) {
    const fator = Math.sqrt((linhas * colunas) / MAX_CELULAS)
    linhas = Math.max(1, Math.floor(linhas / fator))
    colunas = Math.max(1, Math.floor(colunas / fator))
  }

  const passoLat = (bbox.high.lat - bbox.low.lat) / linhas
  const passoLng = (bbox.high.lng - bbox.low.lng) / colunas
  const celulas: Celula[] = []
  for (let r = 0; r < linhas; r++) {
    for (let c = 0; c < colunas; c++) {
      const low = { lat: bbox.low.lat + r * passoLat, lng: bbox.low.lng + c * passoLng }
      const high = { lat: bbox.low.lat + (r + 1) * passoLat, lng: bbox.low.lng + (c + 1) * passoLng }
      celulas.push(celula(low, high))
    }
  }
  return celulas
}

function celula(low: LatLng, high: LatLng): Celula {
  return {
    low,
    high,
    center: { lat: (low.lat + high.lat) / 2, lng: (low.lng + high.lng) / 2 },
  }
}

export interface CustoEstimado {
  celulas: number
  /** Requisições cobradas estimadas (cada página de cada termo de cada célula). */
  requisicoes: number
  /** Custo estimado em USD (Places Text Search ~ $32/1000 por padrão). */
  usd: number
}

/**
 * Estima o custo de uma grade ANTES de rodar (Places é cobrado por requisição).
 * requisicoes ≈ células × termos por célula × páginas médias por consulta.
 * Honesto por construção: o caller passa o nº real de termos e um teto de páginas.
 */
export function estimarCusto(
  celulas: number,
  opts: { termosPorCelula?: number; paginasPorConsulta?: number; usdPorMil?: number } = {},
): CustoEstimado {
  const termos = Math.max(1, opts.termosPorCelula ?? 1)
  const paginas = Math.max(1, opts.paginasPorConsulta ?? 2)
  const usdPorMil = opts.usdPorMil ?? 32
  const requisicoes = Math.round(celulas * termos * paginas)
  return {
    celulas,
    requisicoes,
    usd: Math.round((requisicoes / 1000) * usdPorMil * 100) / 100,
  }
}
