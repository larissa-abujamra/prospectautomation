// Edge Function: olivia-nudge
// =============================================================================
// Follow-up CONVERSACIONAL de 23h: retoma chats vivos que esfriaram. Diferente
// do olivia-followup (que mira quem NUNCA respondeu, via template). Aqui:
//   - é CHAT (>=1 mensagem do cliente);
//   - a Olivia falou por último e o cliente sumiu há >=23h;
//   - estado vivo ('conversando'/'agendando');
//   - re-armável (um nudge por silêncio; volta a valer se o cliente responder).
// Seleção via RPC olivia_chats_para_nudge (migration 0028). Para cada chat,
// decide pelo silêncio (horas_silencio):
//   - < 24h (janela aberta): chama olivia-responder { nudge: true } — gera UMA
//     mensagem livre, natural e contextual, e envia pelo canal ativo.
//   - >= 24h (janela fechada): mensagem livre é bloqueada pela Meta → dispara o
//     TEMPLATE de CONTINUAÇÃO via workflow do HubSpot (PATCH whatsapp_outreach =
//     OLIVIA_REENGAGE_STATUS), reabrindo a conversa de forma natural.
//
// SEGURANÇA: só servidor/cron — OLIVIA_TRIGGER_SECRET (header x-olivia-secret).
// Deploy SEM JWT. DRY-RUN por padrão: { "dry_run": false } dispara de verdade.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { NUDGE_MAX_POR_RUN, precisaTemplateReengajamento } from '../_shared/olivia_nudge.ts'
import { HUBSPOT_OUTREACH_PROPERTY } from '../_shared/hubspot.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const HUBSPOT_BASE = 'https://api.hubapi.com'
const HUBSPOT_TIMEOUT_MS = 12_000

// Valor de whatsapp_outreach que inscreve o contato no workflow de CONTINUAÇÃO do
// HubSpot (template que reabre a janela de 24h, ex.: squad_continuacao_1).
// Configurável por env caso o time use outro nome de branch/status.
const CONTINUACAO_STATUS = Deno.env.get('OLIVIA_REENGAGE_STATUS') ?? 'continuacao'

interface ChatRow {
  id: string
  nome: string | null
  olivia_estado: string | null
  horas_silencio: number | null
  hubspot_contact_id: string | null
}

// PATCH whatsapp_outreach no contato → inscreve no workflow de continuação do
// HubSpot (manda o template que reabre a conversa). Lança em erro (o chamador
// conta em `erros` e NÃO carimba olivia_nudge_em — volta na próxima execução).
async function patchOutreachContinuacao(token: string, contactId: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS)
  const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}`, {
    method: 'PATCH',
    signal: controller.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { [HUBSPOT_OUTREACH_PROPERTY]: CONTINUACAO_STATUS } }),
  }).finally(() => clearTimeout(timeout))
  if (!resp.ok) {
    const data = await resp.json().catch(() => null)
    throw new Error(data?.message ?? `HubSpot PATCH contato ${contactId} falhou (HTTP ${resp.status})`)
  }
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
      chats: lista.map((c) => ({
        lead_id: c.id,
        nome: c.nome,
        estado: c.olivia_estado,
        horas_silencio: c.horas_silencio,
        // < 24h → nudge LIVRE; >= 24h → template de CONTINUAÇÃO (reabre a janela).
        retomada: precisaTemplateReengajamento(c.horas_silencio) ? 'template' : 'livre',
      })),
    })
  }

  const hsToken = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')

  // Disparo real. Dois caminhos por chat, decididos pelo silêncio:
  //  - < 24h (dentro da janela): nudge LIVRE — delega à olivia-responder (modo
  //    nudge), que reusa LLM + pacing + canal.
  //  - >= 24h (janela fechada): mensagem livre é bloqueada pela Meta → dispara o
  //    TEMPLATE de continuação via workflow do HubSpot (PATCH whatsapp_outreach).
  // Sequencial (<=25/run, rate folgado).
  let disparados = 0 // nudges livres enviados
  let continuados = 0 // templates de continuação disparados (>=24h)
  let pulados = 0
  const erros: { lead_id: string; erro: string }[] = []
  for (const c of lista) {
    try {
      if (precisaTemplateReengajamento(c.horas_silencio)) {
        // Fora da janela de 24h → TEMPLATE de continuação (HubSpot). Sem contato
        // ou sem token (provider não-HubSpot) não dá pra disparar → pula.
        if (!c.hubspot_contact_id || !hsToken) {
          pulados++
          continue
        }
        await patchOutreachContinuacao(hsToken, c.hubspot_contact_id)
        // One-shot por silêncio: olivia_nudge_em re-arma a RPC (volta só se o
        // cliente responder). olivia_reengajar_em é o carimbo de relatório.
        const nowIso = new Date().toISOString()
        await supabase.from('leads').update({ olivia_nudge_em: nowIso, olivia_reengajar_em: nowIso }).eq('id', c.id)
        continuados++
        continue
      }
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

  return json({ dry_run: false, selecionados: lista.length, disparados, continuados, pulados, erros: erros.length, erros_detalhe: erros })
})
