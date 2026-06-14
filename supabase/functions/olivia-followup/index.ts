// Edge Function: olivia-followup
// =============================================================================
// Fase D — follow-up ÚNICO de 48h sem resposta. Plano:
// .claude/plans/2026-06-10-olivia-autonoma.md (Fase D).
//
// FLUXO: seleciona leads cuja intro foi acionada há >=48h (whatsapp_sent_at,
// gravado pelo hubspot-sync com trigger=true) e que NUNCA responderam
// (whatsapp_send_status != 'replied'; olivia_estado nulo/'aguardando') nem
// receberam follow-up (followup_enviado_em nulo) → PATCH no contato do HubSpot
// (whatsapp_outreach='followup') → o WORKFLOW do HubSpot (manual, ver
// supabase/README.md) envia o template `squad_followup_1` → marca
// followup_enviado_em SÓ após o PATCH ok ("follow-up disparado").
//
// GUARD anti-spam (já existente): quem responde vira whatsapp_outreach='replied'
// no HubSpot (olivia-hubspot-webhook) + whatsapp_send_status='replied' aqui —
// dupla barreira: a seleção exclui, e a inscrição do workflow exige 'followup'.
//
// SEGURANÇA: chamada só por servidor/cron — exige OLIVIA_TRIGGER_SECRET
// (header x-olivia-secret), igual à olivia-agendar. Deploy SEM JWT:
//   supabase functions deploy olivia-followup --no-verify-jwt
//
// DRY-RUN por padrão: o body precisa dizer { "dry_run": false } pra disparar de
// verdade (mesma filosofia das irmãs). O cron do GitHub Actions
// (.github/workflows/olivia-followup.yml) chama com dry_run=false.
//
// Secrets: OLIVIA_TRIGGER_SECRET, HUBSPOT_PRIVATE_APP_TOKEN, SUPABASE_URL,
//          SUPABASE_SERVICE_ROLE_KEY.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  elegivelParaFollowup,
  filtrarElegiveis,
  FOLLOWUP_JANELA_MS,
  FOLLOWUP_MAX_POR_RUN,
  HUBSPOT_OUTREACH_FOLLOWUP,
  type FollowupLead,
} from '../_shared/olivia_followup.ts'
import {
  HUBSPOT_OUTREACH_PROPERTY,
  HUBSPOT_STAGE_TENTATIVA_CONTATO,
  queueHubspotDealStageSync,
} from '../_shared/hubspot.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const HUBSPOT_BASE = 'https://api.hubapi.com'
const HUBSPOT_TIMEOUT_MS = 12_000

// PATCH whatsapp_outreach='followup' no contato → inscreve no workflow de
// follow-up do HubSpot. Lança em erro (o chamador conta em `erros` e NÃO
// marca followup_enviado_em — o lead volta na próxima execução).
async function patchOutreachFollowup(token: string, contactId: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS)
  const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}`, {
    method: 'PATCH',
    signal: controller.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { [HUBSPOT_OUTREACH_PROPERTY]: HUBSPOT_OUTREACH_FOLLOWUP },
    }),
  }).finally(() => clearTimeout(timeout))
  if (!resp.ok) {
    const data = await resp.json().catch(() => null)
    throw new Error(data?.message ?? `HubSpot PATCH contato ${contactId} falhou (HTTP ${resp.status})`)
  }
}

type LeadRow = FollowupLead & { nome: string | null; hubspot_deal_id: string | null }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  // Só servidor: segredo interno obrigatório (mesmo padrão da olivia-agendar).
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) {
    return json({ error: 'Não autorizado.' }, 401)
  }

  // DRY-RUN por padrão: só { "dry_run": false } explícito dispara de verdade.
  let dryRun = true
  try {
    const body = await req.json().catch(() => ({}))
    if (body && typeof body === 'object' && (body as { dry_run?: unknown }).dry_run === false) {
      dryRun = false
    }
  } catch {
    /* corpo vazio/ausente → dry-run */
  }

  const token = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')
  if (!dryRun && !token) {
    return json({ error: 'Falta o secret HUBSPOT_PRIVATE_APP_TOKEN.' }, 503)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const agoraMs = Date.now()
  const cutoffIso = new Date(agoraMs - FOLLOWUP_JANELA_MS).toISOString()

  // Pré-filtro em SQL (índice parcial da 0021); a palavra final é da lógica
  // pura (filtrarElegiveis) — defesa em profundidade. Mais antigos primeiro,
  // pra ninguém ficar pra trás se houver mais elegíveis que o teto.
  const { data: candidatos, error: selErr } = await supabase
    .from('leads')
    .select(
      'id, nome, hubspot_contact_id, hubspot_deal_id, whatsapp_sent_at, whatsapp_send_status, olivia_estado, followup_enviado_em',
    )
    .is('followup_enviado_em', null)
    .not('hubspot_contact_id', 'is', null)
    .not('whatsapp_sent_at', 'is', null)
    .lte('whatsapp_sent_at', cutoffIso)
    .or('whatsapp_send_status.is.null,whatsapp_send_status.in.(sent,delivered,read)')
    .or('olivia_estado.is.null,olivia_estado.eq.aguardando')
    .order('whatsapp_sent_at', { ascending: true })
    .limit(FOLLOWUP_MAX_POR_RUN)
  if (selErr) {
    console.error('olivia-followup: falha na seleção', selErr.message)
    return json({ error: 'Falha ao selecionar leads.' }, 502)
  }

  const elegiveis = filtrarElegiveis(
    (candidatos ?? []) as unknown as LeadRow[],
    agoraMs,
  ) as LeadRow[]

  const relatorio = elegiveis.map((l) => ({
    lead_id: l.id,
    nome: l.nome,
    hubspot_contact_id: l.hubspot_contact_id,
    intro_acionada_em: l.whatsapp_sent_at,
    horas_sem_resposta: Math.floor((agoraMs - Date.parse(l.whatsapp_sent_at!)) / 3_600_000),
  }))

  if (dryRun) {
    // Auditoria: também mostra por que cada candidato pré-filtrado ficou de fora.
    const descartados = ((candidatos ?? []) as unknown as LeadRow[])
      .filter((c) => !elegiveis.some((e) => e.id === c.id))
      .map((c) => ({ lead_id: c.id, motivo: elegivelParaFollowup(c, agoraMs).motivo }))
    return json({
      dry_run: true,
      selecionados: elegiveis.length,
      disparados: 0,
      erros: 0,
      leads: relatorio,
      descartados,
    })
  }

  // Disparo real: PATCH primeiro, marca depois — falha no PATCH não consome o
  // one-shot (re-tenta na próxima execução). Sequencial: 25/run não justifica
  // paralelismo e mantém o rate do HubSpot folgado.
  let disparados = 0
  const erros: { lead_id: string; erro: string }[] = []
  for (const lead of elegiveis) {
    try {
      await patchOutreachFollowup(token!, lead.hubspot_contact_id!)
      const { error: updErr } = await supabase
        .from('leads')
        .update({ followup_enviado_em: new Date().toISOString() })
        .eq('id', lead.id)
        .is('followup_enviado_em', null) // CAS: execução concorrente não re-marca
      if (updErr) {
        // PATCH ok mas marcação falhou → loga ALTO: sem o carimbo, a próxima
        // execução re-patchearia (o workflow do HubSpot re-inscreve? Não: a
        // re-inscrição exige o valor MUDAR; 'followup'→'followup' não re-dispara).
        console.error('olivia-followup: PATCH ok mas followup_enviado_em falhou', lead.id, updErr.message)
        erros.push({ lead_id: lead.id, erro: `marcação falhou: ${updErr.message}` })
        continue
      }
      queueHubspotDealStageSync(
        lead.hubspot_deal_id,
        HUBSPOT_STAGE_TENTATIVA_CONTATO,
        'olivia-followup',
      )
      disparados++
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erro desconhecido'
      console.error('olivia-followup: PATCH falhou', lead.id, msg)
      erros.push({ lead_id: lead.id, erro: msg })
    }
  }

  return json({
    dry_run: false,
    selecionados: elegiveis.length,
    disparados,
    erros: erros.length,
    leads: relatorio,
    erros_detalhe: erros,
  })
})
