// Edge Function: olivia-nudge
// =============================================================================
// Follow-up CONVERSACIONAL de 23h: retoma chats vivos que esfriaram. Diferente
// do olivia-followup (que mira quem NUNCA respondeu, via template). Aqui:
//   - é CHAT (>=1 mensagem do cliente);
//   - a Olivia falou por último e o cliente sumiu há >=23h;
//   - estado vivo ('conversando'/'agendando');
//   - re-armável (um nudge por silêncio; volta a valer se o cliente responder).
// Seleção via RPC olivia_chats_para_nudge (migration 0028). Para cada chat,
// chama a olivia-responder em modo { nudge: true } — que gera UMA mensagem
// natural e contextual (dentro da janela de 24h do WhatsApp) e a envia pelo
// canal ativo. Fora da janela de 24h, a responder pula (cabe ao template).
//
// SEGURANÇA: só servidor/cron — OLIVIA_TRIGGER_SECRET (header x-olivia-secret).
// Deploy SEM JWT. DRY-RUN por padrão: { "dry_run": false } dispara de verdade.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { NUDGE_MAX_POR_RUN } from '../_shared/olivia_nudge.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

interface ChatRow {
  id: string
  nome: string | null
  olivia_estado: string | null
  horas_silencio: number | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) {
    return json({ error: 'Não autorizado.' }, 401)
  }

  let dryRun = true
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object' && (b as { dry_run?: unknown }).dry_run === false) dryRun = false
  } catch {
    /* corpo vazio → dry-run */
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: chats, error } = await supabase.rpc('olivia_chats_para_nudge', {
    janela_horas: 23,
    limite: NUDGE_MAX_POR_RUN,
  })
  if (error) {
    console.error('olivia-nudge: falha na seleção (RPC)', error.message)
    return json({ error: 'Falha ao selecionar chats.' }, 502)
  }
  const lista = (chats ?? []) as ChatRow[]

  if (dryRun) {
    return json({
      dry_run: true,
      selecionados: lista.length,
      chats: lista.map((c) => ({ lead_id: c.id, nome: c.nome, estado: c.olivia_estado, horas_silencio: c.horas_silencio })),
    })
  }

  // Disparo real: delega a geração+envio pra olivia-responder (modo nudge), que
  // reusa o LLM, o pacing e o canal ativo. Sequencial (<=25/run, rate folgado).
  let disparados = 0
  let pulados = 0
  const erros: { lead_id: string; erro: string }[] = []
  for (const c of lista) {
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/olivia-responder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
        body: JSON.stringify({ lead_id: c.id, nudge: true }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok && (d as { enviado?: boolean }).enviado) disparados++
      else if ((d as { skipped?: boolean }).skipped) pulados++
      else erros.push({ lead_id: c.id, erro: (d as { error?: string; reason?: string }).error ?? (d as { reason?: string }).reason ?? `HTTP ${r.status}` })
    } catch (e) {
      erros.push({ lead_id: c.id, erro: e instanceof Error ? e.message : String(e) })
    }
  }

  return json({ dry_run: false, selecionados: lista.length, disparados, pulados, erros: erros.length, erros_detalhe: erros })
})
