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
import { requireAuthenticatedUser } from '../_shared/auth.ts'

// CORS: a UI (botão "Enriquecer em lote") chama via supabase.functions.invoke
// com o JWT do usuário logado — precisa dos headers de preflight liberados.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-olivia-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// Teto de leads por INVOCAÇÃO. Manda LOTES de IDs ao encontrar-whatsapp (que agora
// processa o lote internamente em paralelo), então uma execução faz POUCAS
// invocações (~teto/LOTE) e processa centenas — sem estourar o rate de invocação
// function->function (~30/janela) que limitava o per-lead a ~30. Re-rode p/ milhares.
const MAX_POR_TICK = 250
const LOTE = 20 // leads por chamada ao encontrar-whatsapp (batch interno)
const ORCAMENTO_MS = 85_000

interface LeadRow { id: string; nome: string | null; setor: string | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Membro logado (UI) OU o segredo interno (GH Action/cron). Gasta crédito de
  // scraping/Places → auth no código. O segredo segue sendo usado p/ as chamadas
  // server-to-server a encontrar-whatsapp/enriquecer-lead abaixo.
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  const autorizado =
    (!!secret && req.headers.get('x-olivia-secret') === secret) ||
    (await requireAuthenticatedUser(req))
  if (!autorizado) return json({ error: 'Autenticação obrigatória.' }, 401)
  const base = Deno.env.get('SUPABASE_URL')
  if (!base) return json({ error: 'SUPABASE_URL ausente.' }, 500)

  let dryRun = true
  let limite = 150
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
  const pendentes = (n: number) => {
    let q = supabase
      .from('leads')
      .select('id, nome, setor')
      .eq('origem', 'google_places')
      .or('whatsapp_status.is.null,whatsapp_status.eq.pending')
      .or('website.not.is.null,instagram_handle.not.is.null,telefone.not.is.null')
      .order('created_at', { ascending: true })
      .limit(n)
    if (setor) q = q.ilike('setor', `%${setor}%`)
    return q
  }

  if (dryRun) {
    const { data: leads, error } = await pendentes(limite)
    if (error) {
      console.error('bulk-enrich: falha na seleção', error.message)
      return json({ error: 'Falha ao selecionar leads.' }, 502)
    }
    const lista = (leads ?? []) as LeadRow[]
    return json({ dry_run: true, selecionados: lista.length, enriquecer: comEnriquecer, leads: lista.map((l) => ({ id: l.id, nome: l.nome, setor: l.setor })) })
  }

  // SELF-DRAIN por LOTES: a cada rodada pega LOTE pendentes e manda os IDs em UMA
  // chamada ao encontrar-whatsapp (batch). Processados saem da fila (viram
  // found/missing), então a próxima rodada pega os próximos. Para no teto `limite`,
  // no orçamento de tempo, ou quando a fila esvazia. enriquecer-lead (CNPJ/dono/
  // Instagram) NÃO roda aqui — bulk-enrich é descoberta de WhatsApp (gate do
  // disparo); enriquecimento fica na ficha do lead, sob demanda.
  const inicio = Date.now()
  let processados = 0
  let found = 0
  let missing = 0
  let erros = 0
  let skipped = 0
  let rodadas = 0
  while (processados < limite && Date.now() - inicio < ORCAMENTO_MS) {
    const restante = Math.min(LOTE, limite - processados)
    const { data: leads, error } = await pendentes(restante)
    if (error) {
      console.error('bulk-enrich: falha na seleção', error.message)
      break
    }
    const lote = (leads ?? []) as LeadRow[]
    if (lote.length === 0) break

    try {
      const r = await fetch(`${base}/functions/v1/encontrar-whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
        body: JSON.stringify({ lead_ids: lote.map((l) => l.id) }),
      })
      const d = await r.json().catch(() => ({} as Record<string, number>))
      if (!r.ok) {
        // Lote falhou (rate/auth/erro) — os leads seguem pendentes p/ a próxima
        // execução. Não insiste na mesma janela: encerra com o que já fez.
        erros += lote.length
        break
      }
      processados += Number(d.processados) || lote.length
      found += Number(d.found) || 0
      missing += Number(d.missing) || 0
      erros += Number(d.erros) || 0
      skipped += Number(d.skipped) || 0
    } catch (e) {
      console.error('bulk-enrich: falha no lote', e instanceof Error ? e.message : e)
      erros += lote.length
      break
    }
    rodadas++
  }

  return json({ dry_run: false, processados, found, missing, erros, skipped, rodadas, atingiu_teto: processados >= limite })
})
