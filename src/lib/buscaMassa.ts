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

// Erros TRANSITÓRIOS de invocação: as funções de busca em massa são chamadas com
// pouca frequência, então a 1ª chamada após ociosidade pega COLD START e pode
// estourar o timeout do fetch — o supabase-js devolve FunctionsFetchError
// ("Failed to send a request to the Edge Function"). Isso é re-tentável: numa 2ª
// tentativa a função já está quente. NÃO re-tentamos erro funcional (4xx/validação).
const ERRO_TRANSITORIO = /failed to send a request|fetch|network|time?d?\s*out|timeout|50[234]|52[012]|546|boot/i

export function ehTransitorio(error: { name?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError') return true
  return ERRO_TRANSITORIO.test(error.message ?? '')
}

// Invoca uma Edge Function com retry em falha transitória (cold start/timeout).
// Erro funcional (data.error) ou não-transitório sobe na hora; transitório
// re-tenta com backoff curto e, se esgotar, lança uma mensagem clara pro usuário.
async function invocarFn<T>(nome: string, body: Record<string, unknown>, tentativas = 3): Promise<T> {
  let ultimoErro: { name?: string; message?: string } | null = null
  for (let i = 0; i < tentativas; i++) {
    const { data, error } = await supabase.functions.invoke(nome, { body })
    if (!error) {
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      return data as T
    }
    ultimoErro = error
    if (!ehTransitorio(error) || i === tentativas - 1) break
    await new Promise((r) => setTimeout(r, 700 * (i + 1))) // 700ms, 1400ms: aquece o cold start
  }
  if (ehTransitorio(ultimoErro)) {
    throw new Error('Não consegui falar com o servidor (a função pode estar iniciando). Tente de novo em alguns segundos.')
  }
  throw new Error(ultimoErro?.message ?? 'Falha ao chamar a função.')
}

export async function geocodarLocal(local: string): Promise<GeoLocal> {
  return invocarFn<GeoLocal>('geocodar-local', { local })
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

// --- Jobs em background (Fase 2b: escopo estado/região via fila + worker) -----

export type EscopoTipo = 'cidade' | 'metro' | 'uf'

export interface EnqueueOpts {
  setor: string
  escopo: { tipo: EscopoTipo; valor: string }
  maxInserts?: number | null
  cellKm?: number
  maxTermos?: number
  maxPaginas?: number
}

export async function enfileirarMassa(o: EnqueueOpts): Promise<{ job_id: string; total_tasks: number }> {
  return invocarFn<{ job_id: string; total_tasks: number }>('scrape-enqueue', o as unknown as Record<string, unknown>)
}

export interface JobMassa {
  id: string
  created_at: string
  setor: string
  escopo_tipo: EscopoTipo
  escopo_valor: string
  status: 'pending' | 'running' | 'paused' | 'done' | 'cancelled'
  total_tasks: number
  tasks_done: number
  found_total: number
  inserted_total: number
}

export async function controlarJob(
  jobId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<{ status: string }> {
  return invocarFn<{ status: string }>('scrape-control', { job_id: jobId, action })
}

export async function listarJobsMassa(): Promise<JobMassa[]> {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('id,created_at,setor,escopo_tipo,escopo_valor,status,total_tasks,tasks_done,found_total,inserted_total')
    .order('created_at', { ascending: false })
    .limit(8)
  if (error) throw error
  return (data ?? []) as JobMassa[]
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
    const d = await invocarFn<{ done?: boolean; cursor?: number; total_tiles?: number; inserted?: number; requisicoes?: number }>(
      'buscar-grade',
      {
        setor: opts.setor,
        bbox: opts.bbox,
        cellKm: opts.cellKm,
        cursor,
        tilesPerCall,
        maxTermos: opts.maxTermos,
        maxPaginas: opts.maxPaginas,
      },
    )
    cursor = d.cursor ?? cursor
    totalTiles = d.total_tiles ?? totalTiles
    insertedTotal += d.inserted ?? 0
    requisicoesTotal += d.requisicoes ?? 0
    opts.onProgress({ tilesDone: cursor, totalTiles, insertedTotal, requisicoesTotal })
    if (d?.done) break
  }
  return { tilesDone: cursor, totalTiles, insertedTotal, requisicoesTotal }
}
