// Edge Function: bulk-dispatch  (dreno server-to-server — ENVIA mensagens)
// =============================================================================
// Aciona o disparo de WhatsApp em LOTE nos leads prontos: por lead, chama
// hubspot-sync(trigger=true) — que faz upsert do contato, grava
// whatsapp_outreach='ready' e marca whatsapp_sent_at; o WORKFLOW do HubSpot
// ("Squad Prospeccao WhatsApp F/M") é quem realmente envia o template. É o mesmo
// caminho do botão "Acionar workflow WhatsApp" da ficha — só que em lote.
//
// SELEÇÃO (espelha os guards do botão por lead, anti-spam/anti-invenção):
//   - origem google_places (descobertos)        - whatsapp_status='found' (tem nº)
//   - whatsapp_sent_at IS NULL (nunca disparado) - SEM whatsapp_ddd_mismatch
//   - filtro opcional por setor
// Quem já foi disparado ganha whatsapp_sent_at e sai da seleção (dedup natural).
//
// SEGURANÇA: só servidor — OLIVIA_TRIGGER_SECRET. DRY-RUN por padrão. SEQUENCIAL
// e limitado (lote pequeno) — protege a reputação do número e o rate do HubSpot.
// PRÉ-REQUISITO operacional: o workflow do HubSpot precisa estar LIGADO e os
// templates aprovados, senão 'ready' é gravado mas nada é enviado.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'

// CORS: a UI (botão "Disparar WhatsApp em lote") chama via supabase.functions.invoke
// com o JWT do usuário logado — precisa dos headers de preflight liberados.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-olivia-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// Teto por lote. O gargalo NÃO é a Meta (número em tier alto, 100k/dia) e sim o
// rate limit de invocação function->function do Supabase: cada lead chama o
// hubspot-sync, e rajadas grandes levam 429 ("Rate limit exceeded ... Retry
// after"). CONCORRENCIA baixa espalha as chamadas; o teto por lote evita estourar
// a janela de invocações num único disparo. Quem peia o envio real é o workflow.
const MAX_POR_LOTE = 100
const CONCORRENCIA = 3

interface LeadRow { id: string; nome: string | null; setor: string | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Membro logado (UI: botão "Disparar WhatsApp em lote") OU o segredo interno
  // (GH Action / cron server-to-server). Dispara ação de custo → auth no código.
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  const autorizado =
    (!!secret && req.headers.get('x-olivia-secret') === secret) ||
    (await requireAuthenticatedUser(req))
  if (!autorizado) return json({ error: 'Autenticação obrigatória.' }, 401)
  const base = Deno.env.get('SUPABASE_URL')
  if (!base) return json({ error: 'SUPABASE_URL ausente.' }, 500)

  let dryRun = true
  let limite = 20
  let setor: string | null = null
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object') {
      if ((b as { dry_run?: unknown }).dry_run === false) dryRun = false
      const l = Number((b as { limite?: unknown }).limite)
      if (Number.isFinite(l) && l > 0) limite = Math.min(Math.floor(l), MAX_POR_LOTE)
      const s = (b as { setor?: unknown }).setor
      if (typeof s === 'string' && s.trim()) setor = s.trim()
    }
  } catch {
    /* corpo vazio → dry-run */
  }

  const supabase = createClient(base, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Seleção + DEDUP por NÚMERO na RPC leads_disparaveis: (1) exclui números que
  // já receberam qualquer mensagem (whatsapp_sent_at) — redes com WhatsApp central
  // viram várias linhas de lead com o MESMO número; (2) dedup dentro do lote (um
  // por número, o mais antigo). O filtro whatsapp_sent_at por linha + o claim
  // atômico do hubspot-sync continuam como rede de segurança contra corrida.
  const { data: leads, error } = await supabase.rpc('leads_disparaveis', {
    p_setor: setor,
    p_limite: limite,
  })
  if (error) {
    console.error('bulk-dispatch: falha na seleção', error.message)
    return json({ error: 'Falha ao selecionar leads.' }, 502)
  }
  const lista = (leads ?? []) as LeadRow[]

  if (dryRun) {
    return json({ dry_run: true, selecionados: lista.length, leads: lista.map((l) => ({ id: l.id, nome: l.nome, setor: l.setor })) })
  }

  // Em CHUNKS paralelos (não sequencial puro): cada hubspot-sync leva ~2-3s
  // (upsert + classificação de gênero), então 100+ sequenciais estouravam o
  // timeout do edge. CONCORRENCIA baixa mantém o rate do HubSpot tranquilo
  // (~CONCORRENCIA*3 req/burst). Quem PACEIA o envio real é o workflow do HubSpot,
  // então disparar os triggers em ~1min não afeta a reputação do número.
  let disparados = 0
  const erros: { id: string; erro: string }[] = []

  async function dispararUm(l: LeadRow): Promise<void> {
    try {
      const r = await fetch(`${base}/functions/v1/hubspot-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
        body: JSON.stringify({ lead_id: l.id, trigger: true }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok && ((d as { workflow_triggered?: boolean }).workflow_triggered || (d as { triggered?: boolean }).triggered)) {
        disparados++
      } else {
        erros.push({ id: l.id, erro: (d as { error?: string }).error ?? `HTTP ${r.status}` })
      }
    } catch (e) {
      erros.push({ id: l.id, erro: e instanceof Error ? e.message : String(e) })
    }
  }

  for (let i = 0; i < lista.length; i += CONCORRENCIA) {
    await Promise.all(lista.slice(i, i + CONCORRENCIA).map(dispararUm))
  }

  return json({ dry_run: false, selecionados: lista.length, disparados, erros: erros.length, erros_detalhe: erros })
})
