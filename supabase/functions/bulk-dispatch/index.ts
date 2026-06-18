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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const MAX_POR_LOTE = 40

interface LeadRow { id: string; nome: string | null; setor: string | null }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) return json({ error: 'Não autorizado.' }, 401)
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

  let q = supabase
    .from('leads')
    .select('id, nome, setor')
    .eq('origem', 'google_places')
    .eq('whatsapp_status', 'found')
    .is('whatsapp_sent_at', null)
    .or('whatsapp_ddd_mismatch.is.null,whatsapp_ddd_mismatch.eq.false')
    .order('created_at', { ascending: true })
    .limit(limite)
  if (setor) q = q.ilike('setor', `%${setor}%`)
  const { data: leads, error } = await q
  if (error) {
    console.error('bulk-dispatch: falha na seleção', error.message)
    return json({ error: 'Falha ao selecionar leads.' }, 502)
  }
  const lista = (leads ?? []) as LeadRow[]

  if (dryRun) {
    return json({ dry_run: true, selecionados: lista.length, leads: lista.map((l) => ({ id: l.id, nome: l.nome, setor: l.setor })) })
  }

  // SEQUENCIAL de propósito: trigger em rajada estressa o HubSpot e a reputação
  // do número. Quem dispara o envio de fato (com pacing) é o workflow do HubSpot.
  let disparados = 0
  const erros: { id: string; erro: string }[] = []
  for (const l of lista) {
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

  return json({ dry_run: false, selecionados: lista.length, disparados, erros: erros.length, erros_detalhe: erros })
})
