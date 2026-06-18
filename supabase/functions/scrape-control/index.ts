// Edge Function: scrape-control
// =============================================================================
// Controle de um job de busca em massa: pausar / retomar / cancelar. O worker só
// drena jobs 'pending'/'running', então pausar/cancelar simplesmente os tira do
// alcance dele (e cancelar marca as tasks abertas como 'skipped' — terminal).
//   pause   → 'paused'    (só de pending/running; retomável)
//   resume  → 'running'   (só de paused)
//   cancel  → 'cancelled' + tasks abertas viram 'skipped' (definitivo)
// Auth: usuário logado. Deploy --no-verify-jwt.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  let jobId: string, action: string
  try {
    const b = await req.json()
    jobId = String(b.job_id ?? '').trim()
    action = String(b.action ?? '').trim()
    if (!jobId) return json({ error: 'Informe job_id.' }, 400)
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      return json({ error: 'action: pause | resume | cancel.' }, 400)
    }
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const now = new Date().toISOString()
  try {
    if (action === 'cancel') {
      // Tasks abertas viram 'skipped' (não voltam); job 'cancelled'.
      await supabase.from('scrape_tasks').update({ status: 'skipped', updated_at: now })
        .eq('job_id', jobId).in('status', ['pending', 'running'])
      const { data, error } = await supabase.from('scrape_jobs')
        .update({ status: 'cancelled', updated_at: now }).eq('id', jobId)
        .not('status', 'in', '(done,cancelled)').select('id,status').maybeSingle()
      if (error) throw error
      return json({ job_id: jobId, status: data?.status ?? 'cancelled' })
    }

    // pause só de pending/running; resume só de paused — transição condicional
    // pra não "ressuscitar" job done/cancelado.
    const novo = action === 'pause' ? 'paused' : 'running'
    const de = action === 'pause' ? ['pending', 'running'] : ['paused']
    const { data, error } = await supabase.from('scrape_jobs')
      .update({ status: novo, updated_at: now }).eq('id', jobId).in('status', de)
      .select('id,status').maybeSingle()
    if (error) throw error
    if (!data) return json({ error: `Transição inválida para ${action} (estado atual não permite).` }, 409)
    return json({ job_id: jobId, status: data.status })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, 502)
  }
})
