// Edge Function: bulk-enrich  (dreno server-to-server)
// =============================================================================
// Processa em LOTE os leads pendentes (ex.: descobertos pela busca-massa, que
// só insere nome/place_id): roda encontrar-whatsapp (acha o número — gate do
// disparo) e, opcionalmente, enriquecer-lead (CNPJ/dono/Instagram/gênero) em
// cada um. Bounded por tick; um cron re-executa até esvaziar a fila. Resumável:
// quem foi processado deixa de ser 'pending'/null (vira 'found'/'missing') e
// sai da seleção — sem marcador extra.
//
// NÃO dispara WhatsApp. Só descobre/enriquece (passo seguro antes do disparo).
//
// Seleção: origem=google_places, whatsapp pendente, e COM fonte (site/Instagram/
// telefone) — sem fonte, encontrar-whatsapp não tem de onde achar, então pula
// pra não gastar chamada à toa. Filtro opcional por setor.
//
// AUTH: só servidor/cron — OLIVIA_TRIGGER_SECRET. DRY-RUN por padrão.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const MAX_POR_TICK = 20

interface LeadRow { id: string; nome: string | null; setor: string | null }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) return json({ error: 'Não autorizado.' }, 401)
  const base = Deno.env.get('SUPABASE_URL')
  if (!base) return json({ error: 'SUPABASE_URL ausente.' }, 500)

  let dryRun = true
  let limite = 12
  let setor: string | null = null
  let comEnriquecer = true
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object') {
      if ((b as { dry_run?: unknown }).dry_run === false) dryRun = false
      const l = Number((b as { limite?: unknown }).limite)
      if (Number.isFinite(l) && l > 0) limite = Math.min(Math.floor(l), MAX_POR_TICK)
      const s = (b as { setor?: unknown }).setor
      if (typeof s === 'string' && s.trim()) setor = s.trim()
      if ((b as { enriquecer?: unknown }).enriquecer === false) comEnriquecer = false
    }
  } catch {
    /* corpo vazio → dry-run */
  }

  const supabase = createClient(base, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Pendentes COM fonte de descoberta (site/Instagram/telefone). Dois .or() =
  // AND dos dois grupos. Mais antigos primeiro (FIFO).
  let q = supabase
    .from('leads')
    .select('id, nome, setor')
    .eq('origem', 'google_places')
    .or('whatsapp_status.is.null,whatsapp_status.eq.pending')
    .or('website.not.is.null,instagram_handle.not.is.null,telefone.not.is.null')
    .order('created_at', { ascending: true })
    .limit(limite)
  if (setor) q = q.ilike('setor', `%${setor}%`)
  const { data: leads, error } = await q
  if (error) {
    console.error('bulk-enrich: falha na seleção', error.message)
    return json({ error: 'Falha ao selecionar leads.' }, 502)
  }
  const lista = (leads ?? []) as LeadRow[]

  if (dryRun) {
    return json({ dry_run: true, selecionados: lista.length, enriquecer: comEnriquecer, leads: lista.map((l) => ({ id: l.id, nome: l.nome, setor: l.setor })) })
  }

  const chamar = async (fn: string, leadId: string): Promise<{ ok: boolean; data: any }> => {
    try {
      const r = await fetch(`${base}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
        body: JSON.stringify({ lead_id: leadId }),
      })
      return { ok: r.ok, data: await r.json().catch(() => ({})) }
    } catch (e) {
      return { ok: false, data: { error: e instanceof Error ? e.message : String(e) } }
    }
  }

  // Leads em PARALELO; por lead, encontrar-whatsapp e depois (opcional) enriquecer.
  const resultados = await Promise.all(
    lista.map(async (l) => {
      const wa = await chamar('encontrar-whatsapp', l.id)
      let enr: { ok: boolean; data: any } | null = null
      if (comEnriquecer) enr = await chamar('enriquecer-lead', l.id)
      return {
        id: l.id,
        whatsapp: wa.ok ? (wa.data?.whatsapp_status ?? '?') : `ERR(${wa.data?.error ?? '?'})`,
        enriquecido: enr ? (enr.ok ? true : `ERR(${enr.data?.error ?? '?'})`) : 'pulado',
      }
    }),
  )

  const found = resultados.filter((r) => r.whatsapp === 'found').length
  const missing = resultados.filter((r) => r.whatsapp === 'missing').length
  const erros = resultados.filter((r) => String(r.whatsapp).startsWith('ERR')).length
  return json({ dry_run: false, processados: resultados.length, found, missing, erros, detalhe: resultados })
})
