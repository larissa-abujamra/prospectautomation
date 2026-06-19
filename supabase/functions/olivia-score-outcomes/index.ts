// Edge Function: olivia-score-outcomes
// =============================================================================
// Scoring de DESFECHOS (Fase 4, goal 8 — "treinar depois de cada cliente").
// Pega conversas já finalizadas em conversation_outcomes que ainda NÃO têm
// quality_score, reconstrói o transcript (whatsapp_mensagens) e pede ao LLM uma
// nota 1-5 + tags de tema (parseScore, anti-lixo). Atualiza a linha do desfecho.
// É só INSUMO pro dashboard — NUNCA muda o prompt da Olivia (decisão é humana).
//
// Roda em LOTE por um cron de baixa frequência (diário) — desfecho é evento raro
// e o scoring não tem pressa; respeita a regra de custo (cron >= 15min/batched).
//
// SEGURANÇA: só servidor/cron — OLIVIA_TRIGGER_SECRET (header x-olivia-secret).
// Deploy SEM JWT. DRY-RUN por padrão: { "dry_run": false } pontua de verdade.
//
// Secrets: OPENROUTER_API_KEY, OLIVIA_TRIGGER_SECRET, SUPABASE_URL,
//          SUPABASE_SERVICE_ROLE_KEY. OLIVIA_SCORING_MODEL (opcional).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { historicoParaMensagens, montarRequestScore, parseScore } from '../_shared/olivia_brain.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4'
const MAX_POR_RUN = 25 // teto por execução (custo + timeout do edge)

interface OutcomeRow {
  id: number
  lead_id: string | null
}

interface MsgRow {
  direcao: 'in' | 'out'
  corpo: string | null
  tipo: string | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) {
    return json({ error: 'Não autorizado.' }, 401)
  }

  let dryRun = true
  let limite = MAX_POR_RUN
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object') {
      if ((b as { dry_run?: unknown }).dry_run === false) dryRun = false
      const l = Number((b as { limite?: unknown }).limite)
      if (Number.isFinite(l) && l > 0) limite = Math.min(Math.floor(l), MAX_POR_RUN)
    }
  } catch {
    /* corpo vazio → dry-run */
  }

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) return json({ error: 'Falta OPENROUTER_API_KEY.' }, 500)
  const model = Deno.env.get('OLIVIA_SCORING_MODEL') ?? Deno.env.get('OLIVIA_MODEL') ?? DEFAULT_MODEL

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Desfechos ainda não pontuados, mais recentes primeiro.
  const { data: pendentes, error: selErr } = await supabase
    .from('conversation_outcomes')
    .select('id, lead_id')
    .is('quality_score', null)
    .not('lead_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limite)
  if (selErr) {
    console.error('olivia-score-outcomes: falha na seleção', selErr.message)
    return json({ error: 'Falha ao selecionar desfechos.' }, 502)
  }
  const lista = (pendentes ?? []) as OutcomeRow[]

  if (dryRun) {
    return json({ dry_run: true, model, pendentes: lista.length, ids: lista.map((o) => o.id) })
  }

  let pontuados = 0
  let pulados = 0
  let erros = 0

  for (const outcome of lista) {
    try {
      const { data: msgs } = await supabase
        .from('whatsapp_mensagens')
        .select('direcao, corpo, tipo')
        .eq('lead_id', outcome.lead_id!)
        .order('enviada_em', { ascending: true })
        .limit(40)
      const mensagens = historicoParaMensagens((msgs ?? []) as MsgRow[])
      if (mensagens.length === 0) {
        pulados++
        continue
      }
      const transcript = mensagens
        .map((m) => `${m.role === 'user' ? 'LEAD' : 'OLIVIA'}: ${m.content}`)
        .join('\n')

      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Squad Olivia (scoring)' },
        body: JSON.stringify(montarRequestScore(transcript, model)),
      })
      if (!resp.ok) {
        console.error('olivia-score-outcomes: LLM HTTP', resp.status, 'outcome', outcome.id)
        erros++
        continue
      }
      const { quality_score, theme_tags } = parseScore(await resp.json())
      if (quality_score == null) {
        pulados++
        continue
      }
      const { error: updErr } = await supabase
        .from('conversation_outcomes')
        .update({ quality_score, theme_tags })
        .eq('id', outcome.id)
      if (updErr) {
        console.error('olivia-score-outcomes: falha ao gravar score', outcome.id, updErr.message)
        erros++
        continue
      }
      pontuados++
    } catch (e) {
      console.error('olivia-score-outcomes: erro no outcome', outcome.id, e instanceof Error ? e.message : e)
      erros++
    }
  }

  return json({ model, selecionados: lista.length, pontuados, pulados, erros })
})
