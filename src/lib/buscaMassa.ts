// Cliente da BUSCA EM MASSA por grade (Fase 2a).
// Geocodifica o local escolhido, calcula o preview de custo (reusando o módulo
// puro geo_grid) e roda buscar-grade em LOOP por cursor até varrer a área toda.
import { supabase } from './supabase'
import {
  gerarGrade,
  bboxDeCentroRaio,
  estimarCusto,
  type Retangulo,
  type CustoEstimado,
} from '../../supabase/functions/_shared/geo_grid'

export interface GeoLocal {
  centerLat: number
  centerLng: number
  bbox: Retangulo | null
  nome?: string | null
}

export async function geocodarLocal(local: string): Promise<GeoLocal> {
  const { data, error } = await supabase.functions.invoke('geocodar-local', { body: { local } })
  if (error) throw error
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
  return data as GeoLocal
}

export interface PlanoMassa {
  bbox: Retangulo
  totalCelulas: number
  custo: CustoEstimado
}

// Resolve a área (bbox geocodificada da cidade, ou círculo de raio ao redor do
// centro como fallback) e estima células + custo para o preview ANTES de rodar.
export function planejarMassa(
  geo: GeoLocal,
  opts: { cellKm: number; raioKmFallback?: number; maxTermos: number; maxPaginas: number },
): PlanoMassa {
  const bbox = geo.bbox ?? bboxDeCentroRaio(geo.centerLat, geo.centerLng, opts.raioKmFallback ?? 15)
  const totalCelulas = gerarGrade(bbox, opts.cellKm).length
  const custo = estimarCusto(totalCelulas, {
    termosPorCelula: opts.maxTermos,
    paginasPorConsulta: opts.maxPaginas,
  })
  return { bbox, totalCelulas, custo }
}

export interface ProgressoMassa {
  tilesDone: number
  totalTiles: number
  insertedTotal: number
  requisicoesTotal: number
}

// Roda a varredura em lotes (cursor) até `done`. Reporta progresso a cada lote.
// `insertedTotal` (leads NOVOS) é o número confiável — `found` por lote tem
// sobreposição entre células, então não é somado como "únicos".
export async function rodarBuscaMassa(opts: {
  setor: string
  bbox: Retangulo
  cellKm: number
  maxTermos: number
  maxPaginas: number
  tilesPerCall?: number
  onProgress: (p: ProgressoMassa) => void
  cancelRef?: { cancelado: boolean }
}): Promise<ProgressoMassa> {
  let cursor = 0
  let insertedTotal = 0
  let requisicoesTotal = 0
  let totalTiles = 0
  const tilesPerCall = opts.tilesPerCall ?? 12

  for (;;) {
    if (opts.cancelRef?.cancelado) break
    const { data, error } = await supabase.functions.invoke('buscar-grade', {
      body: {
        setor: opts.setor,
        bbox: opts.bbox,
        cellKm: opts.cellKm,
        cursor,
        tilesPerCall,
        maxTermos: opts.maxTermos,
        maxPaginas: opts.maxPaginas,
      },
    })
    if (error) throw error
    const d = data as { error?: string; done?: boolean; cursor?: number; total_tiles?: number; inserted?: number; requisicoes?: number }
    if (d?.error) throw new Error(d.error)
    cursor = d.cursor ?? cursor
    totalTiles = d.total_tiles ?? totalTiles
    insertedTotal += d.inserted ?? 0
    requisicoesTotal += d.requisicoes ?? 0
    opts.onProgress({ tilesDone: cursor, totalTiles, insertedTotal, requisicoesTotal })
    if (d?.done) break
  }
  return { tilesDone: cursor, totalTiles, insertedTotal, requisicoesTotal }
}
