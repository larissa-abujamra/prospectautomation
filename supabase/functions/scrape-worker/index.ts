// Edge Function: scrape-worker
// =============================================================================
// Dreno da fila de busca em massa (cron). A cada tick: pega o job aberto mais
// antigo, processa um LOTE de tasks (municípios) — geocodifica (1ª vez) e roda a
// grade (buscar-grade) em um lote de células, avançando o cursor da task. Bounded
// por tick (timeout); o cron re-executa até esvaziar. Resumável: cada task guarda
// cursor/bbox/total_cells. Respeita o teto de leads novos do job (max_inserts).
//
// Reusa geocodar-local + buscar-grade server-to-server com OLIVIA_TRIGGER_SECRET.
// SEGURANÇA: só cron/servidor — exige o segredo. Deploy --no-verify-jwt.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { bboxDeCentroRaio, gerarGrade, type Retangulo } from '../_shared/geo_grid.ts'

type Supabase = ReturnType<typeof createClient>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const TASKS_POR_TICK = 4 // municípios por rodada (processados EM PARALELO)
const TILES_POR_TASK = 12 // células por chamada de buscar-grade dentro de uma task
// Orçamento de tempo por invocação: o worker DRENA em loop (várias rodadas) até
// o job acabar/atingir o teto OU estourar isto — depois encerra com folga pro
// timeout do edge. Sem isto, cada invocação fazia só 1 rodada e dependia do cron
// re-disparar; mas o cron do GitHub Actions atrasa muito (*/10 vira ~horário), o
// que deixava jobs grandes "presos" em 0%. Com o loop, um disparo só limpa o job.
const ORCAMENTO_MS = 90_000

async function chamarFuncao(
  base: string,
  secret: string,
  nome: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(`${base}/functions/v1/${nome}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
    body: JSON.stringify(body),
  })
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }
}

// Recalcula os agregados do job a partir das tasks (idempotente, sem corrida).
async function recomputarJob(supabase: Supabase, jobId: string): Promise<{ done: boolean }> {
  const { data: tasks } = await supabase
    .from('scrape_tasks')
    .select('status, found, inserted, requisicoes')
    .eq('job_id', jobId)
  const rows = tasks ?? []
  const terminal = (s: string) => s === 'done' || s === 'skipped' || s === 'failed'
  const tasksDone = rows.filter((t) => terminal(t.status as string)).length
  const found = rows.reduce((a, t) => a + (Number(t.found) || 0), 0)
  const inserted = rows.reduce((a, t) => a + (Number(t.inserted) || 0), 0)
  const reqs = rows.reduce((a, t) => a + (Number(t.requisicoes) || 0), 0)
  const done = rows.length > 0 && tasksDone >= rows.length
  await supabase
    .from('scrape_jobs')
    .update({
      tasks_done: tasksDone,
      found_total: found,
      inserted_total: inserted,
      requisicoes_total: reqs,
      status: done ? 'done' : 'running',
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
  return { done }
}

// Processa UMA task (município): geocode na 1ª vez + um lote de células da grade,
// avançando o cursor. Trata o próprio erro (não derruba as tasks irmãs em paralelo).
async function processarTask(
  supabase: Supabase,
  base: string,
  secret: string,
  // deno-lint-ignore no-explicit-any
  job: any,
  // deno-lint-ignore no-explicit-any
  task: any,
): Promise<Record<string, unknown>> {
  await supabase.from('scrape_tasks').update({ status: 'running' }).eq('id', task.id)
  try {
    let bbox = task.bbox as Retangulo | null
    let totalCells = task.total_cells as number | null
    if (!bbox) {
      const geo = await chamarFuncao(base, secret, 'geocodar-local', { local: task.local })
      if (!geo.ok || geo.data?.error || typeof geo.data?.centerLat !== 'number') {
        await supabase.from('scrape_tasks').update({
          status: 'skipped',
          erro: geo.data?.error ?? `geocode falhou (${geo.status})`,
          updated_at: new Date().toISOString(),
        }).eq('id', task.id)
        return { task: task.local, skipped: true }
      }
      bbox = geo.data.bbox ?? bboxDeCentroRaio(geo.data.centerLat, geo.data.centerLng, 12)
      totalCells = gerarGrade(bbox!, Number(job.cell_km)).length
      await supabase.from('scrape_tasks').update({ bbox, total_cells: totalCells }).eq('id', task.id)
    }

    const res = await chamarFuncao(base, secret, 'buscar-grade', {
      setor: job.setor,
      bbox,
      cellKm: Number(job.cell_km),
      cursor: Number(task.cursor) || 0,
      tilesPerCall: TILES_POR_TASK,
      maxTermos: Number(job.max_termos),
      maxPaginas: Number(job.max_paginas),
    })
    if (!res.ok || res.data?.error) {
      await supabase.from('scrape_tasks').update({
        status: 'failed',
        erro: res.data?.error ?? `buscar-grade falhou (${res.status})`,
        updated_at: new Date().toISOString(),
      }).eq('id', task.id)
      return { task: task.local, failed: true }
    }

    const novoCursor = Number(res.data.cursor) || 0
    const taskDone = !!res.data.done
    await supabase.from('scrape_tasks').update({
      cursor: novoCursor,
      found: (Number(task.found) || 0) + (Number(res.data.found) || 0),
      inserted: (Number(task.inserted) || 0) + (Number(res.data.inserted) || 0),
      requisicoes: (Number(task.requisicoes) || 0) + (Number(res.data.requisicoes) || 0),
      status: taskDone ? 'done' : 'running',
      updated_at: new Date().toISOString(),
    }).eq('id', task.id)
    return {
      task: task.local, cursor: novoCursor, total_cells: totalCells,
      inserted: res.data.inserted, found: res.data.found, done: taskDone,
    }
  } catch (e) {
    await supabase.from('scrape_tasks').update({
      status: 'failed', erro: e instanceof Error ? e.message : 'erro', updated_at: new Date().toISOString(),
    }).eq('id', task.id)
    return { task: task.local, failed: true }
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) {
    return json({ error: 'Não autorizado.' }, 401)
  }
  const base = Deno.env.get('SUPABASE_URL')
  if (!base) return json({ error: 'SUPABASE_URL ausente.' }, 500)

  const supabase = createClient(base, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Job aberto mais antigo (FIFO).
  const { data: jobs } = await supabase
    .from('scrape_jobs')
    .select('*')
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: true })
    .limit(1)
  const job = jobs?.[0]
  if (!job) return json({ idle: true })

  await supabase.from('scrape_jobs').update({ status: 'running' }).eq('id', job.id)

  // DRENA EM LOOP até o job acabar, atingir o teto, ou estourar o orçamento de
  // tempo. Re-checa cap/tasks a cada rodada (inserted_total cresce). Para de
  // ABRIR rodada nova quando passa do orçamento — a rodada em curso ainda fecha
  // com folga pro timeout do edge.
  const inicio = Date.now()
  const cap = job.max_inserts as number | null
  let rodadas = 0
  let done = false
  let ultimo: Record<string, unknown>[] = []

  while (Date.now() - inicio < ORCAMENTO_MS) {
    // Teto de leads novos: relê o agregado e encerra se já atingiu.
    let restanteCap = Number.POSITIVE_INFINITY
    if (cap) {
      const { data: jAtual } = await supabase.from('scrape_jobs').select('inserted_total').eq('id', job.id).single()
      const ins = (jAtual?.inserted_total as number) ?? 0
      if (ins >= cap) {
        await supabase.from('scrape_tasks').update({ status: 'skipped' }).eq('job_id', job.id).in('status', ['pending', 'running'])
        await recomputarJob(supabase, job.id)
        return json({ job_id: job.id, capped: true, rodadas })
      }
      restanteCap = cap - ins
    }

    // Perto do teto, encolhe a rodada para 1 município — cada município processa
    // ~12 células e pode inserir dezenas, então rodar 4 em paralelo estourava o
    // teto em 2-3x. Com 1 por vez no fim, o excedente fica em ~1 município.
    const tasksRodada = restanteCap <= 150 ? 1 : TASKS_POR_TICK

    // Lote de tasks abertas.
    const { data: tasks } = await supabase
      .from('scrape_tasks')
      .select('*')
      .eq('job_id', job.id)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: true })
      .limit(tasksRodada)

    if (!tasks || tasks.length === 0) {
      ;({ done } = await recomputarJob(supabase, job.id))
      break
    }

    // Tasks do lote EM PARALELO (geocode + grade são I/O independentes por
    // município). Cada uma cuida da própria gravação; erro de uma não derruba as
    // outras (Promise.all sobre funções que tratam o próprio catch).
    ultimo = await Promise.all(
      tasks.map((task) => processarTask(supabase, base, secret, job, task)),
    )
    rodadas++
    ;({ done } = await recomputarJob(supabase, job.id))
    if (done) break
  }

  return json({ job_id: job.id, done, rodadas, processed: ultimo })
})
