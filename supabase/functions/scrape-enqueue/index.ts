// Edge Function: scrape-enqueue
// =============================================================================
// Cria um JOB de busca em massa a partir de um ESCOPO (UF inteira / região
// metropolitana / cidade) e o quebra em TASKS — uma por município. O
// scrape-worker (cron) drena as tasks depois. Não scrapeia nada aqui; só enfileira.
//
// Escopo:
//   { tipo: 'uf',     valor: 'SP' }                  → todos os municípios (IBGE)
//   { tipo: 'metro',  valor: 'grande_sp'|'grande_rio'} → lista curada
//   { tipo: 'cidade', valor: 'Pinheiros, São Paulo' } → 1 município
//
// Auth: usuário logado. Deploy: supabase functions deploy scrape-enqueue --no-verify-jwt
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import {
  ehUF,
  IBGE_MUNICIPIOS_URL,
  municipiosMetro,
  parseMunicipiosIBGE,
  type Municipio,
} from '../_shared/ibge.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function resolverMunicipios(tipo: string, valor: string): Promise<Municipio[]> {
  if (tipo === 'cidade') return valor.trim() ? [{ local: valor.trim(), uf: null }] : []
  if (tipo === 'metro') return municipiosMetro(valor)
  if (tipo === 'uf') {
    const uf = valor.toUpperCase().trim()
    if (!ehUF(uf)) return []
    const resp = await fetch(IBGE_MUNICIPIOS_URL(uf))
    if (!resp.ok) throw new Error(`IBGE HTTP ${resp.status}`)
    return parseMunicipiosIBGE(await resp.json(), uf)
  }
  return []
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  let setor: string, tipo: string, valor: string
  let cellKm: number, maxTermos: number, maxPaginas: number
  let maxInserts: number | null
  try {
    const b = await req.json()
    setor = String(b.setor ?? '').trim()
    tipo = String(b?.escopo?.tipo ?? '').trim()
    valor = String(b?.escopo?.valor ?? '').trim()
    cellKm = Math.min(Math.max(Number(b.cellKm) || 2, 0.5), 50)
    maxTermos = Math.min(Math.max(Number(b.maxTermos) || 2, 1), 3)
    maxPaginas = Math.min(Math.max(Number(b.maxPaginas) || 2, 1), 3)
    maxInserts = b.maxInserts == null ? null : Math.max(Number(b.maxInserts) || 0, 0) || null
    if (!setor) return json({ error: 'Informe um setor.' }, 400)
    if (!['uf', 'metro', 'cidade'].includes(tipo) || !valor) {
      return json({ error: 'Escopo inválido (tipo: uf|metro|cidade, valor).' }, 400)
    }
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    const municipios = await resolverMunicipios(tipo, valor)
    if (municipios.length === 0) return json({ error: 'Escopo não resolveu nenhum município.' }, 422)

    const { data: job, error: jobErr } = await supabase
      .from('scrape_jobs')
      .insert({
        setor,
        escopo_tipo: tipo,
        escopo_valor: valor,
        cell_km: cellKm,
        max_termos: maxTermos,
        max_paginas: maxPaginas,
        max_inserts: maxInserts,
        status: 'pending',
        total_tasks: municipios.length,
      })
      .select('id')
      .single()
    if (jobErr || !job) throw jobErr ?? new Error('Falha ao criar job.')

    // Insere tasks em lotes (uma por município).
    const tasks = municipios.map((m) => ({ job_id: job.id, local: m.local, uf: m.uf, status: 'pending' }))
    for (let i = 0; i < tasks.length; i += 500) {
      const { error } = await supabase.from('scrape_tasks').insert(tasks.slice(i, i + 500))
      if (error) throw error
    }

    return json({ job_id: job.id, total_tasks: municipios.length, escopo: { tipo, valor } })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, 502)
  }
})
