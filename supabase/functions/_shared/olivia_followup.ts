// Fase D — follow-up de 48h sem resposta (lógica pura, sem I/O).
// =============================================================================
// Unit-testada no Vitest (src/lib/__tests__/olivia_followup.test.ts) e usada
// pela Edge Function `olivia-followup`. Decide QUEM é elegível ao follow-up
// único; o disparo real é do workflow do HubSpot (whatsapp_outreach='followup').
//
// Semântica dos campos no fluxo HubSpot-cêntrico (ver src/lib/disparos.ts):
//   - whatsapp_sent_at      = instante em que o workflow de intro foi ACIONADO
//                             (gravado pelo hubspot-sync com trigger=true).
//   - whatsapp_send_status  = NULL até algum webhook reportar; 'replied' é
//                             gravado pelo olivia-hubspot-webhook na resposta.
//   - olivia_estado         = NULL/'aguardando' enquanto o lead nunca conversou.
//   - followup_enviado_em   = one-shot (migration 0021): não-nulo → nunca mais.
// =============================================================================

/** Janela mínima entre o disparo da intro e o follow-up. */
export const FOLLOWUP_JANELA_MS = 48 * 60 * 60 * 1000

/** Teto de leads por execução (segurança contra disparo em massa acidental). */
export const FOLLOWUP_MAX_POR_RUN = 25

/** Valor que re-dispara o workflow de follow-up no HubSpot (whatsapp_outreach). */
export const HUBSPOT_OUTREACH_FOLLOWUP = 'followup'

// Estados de envio compatíveis com "recebeu e NÃO respondeu". NULL conta: no
// caminho HubSpot nenhum webhook reporta sent/delivered/read — só 'replied'
// chega (e 'failed'/'invalid' vêm do caminho Meta legado, que excluímos).
const STATUS_SEM_RESPOSTA = new Set<string | null>([null, 'sent', 'delivered', 'read'])

// Únicos estados da Olivia em que o lead NUNCA interagiu. Qualquer outro
// (conversando/agendando/agendado/handoff/optout) = houve conversa ou bloqueio
// → follow-up seria spam (ou violação de opt-out/LGPD).
const ESTADOS_NUNCA_RESPONDEU = new Set<string | null>([null, 'aguardando'])

/** Subset do lead que a elegibilidade precisa (a Edge Function seleciona isto). */
export interface FollowupLead {
  id: string
  hubspot_contact_id: string | null
  whatsapp_sent_at: string | null
  whatsapp_send_status: string | null
  olivia_estado: string | null
  followup_enviado_em: string | null
}

export interface Elegibilidade {
  elegivel: boolean
  /** Motivo legível quando NÃO elegível (debug/dry-run); null quando elegível. */
  motivo: string | null
}

/**
 * Um lead é elegível ao follow-up quando TODAS valem:
 *  1. tem contato no HubSpot (sem contato não há o que patchear);
 *  2. a intro foi acionada (whatsapp_sent_at) há >= 48h;
 *  3. nunca respondeu (status NULL/sent/delivered/read — nunca 'replied');
 *  4. a Olivia nunca conversou com ele (estado NULL/'aguardando');
 *  5. nunca recebeu follow-up (followup_enviado_em NULL — one-shot).
 */
export function elegivelParaFollowup(lead: FollowupLead, agoraMs: number): Elegibilidade {
  if (!lead.hubspot_contact_id) {
    return { elegivel: false, motivo: 'sem hubspot_contact_id' }
  }
  if (!lead.whatsapp_sent_at) {
    return { elegivel: false, motivo: 'intro nunca acionada (whatsapp_sent_at nulo)' }
  }
  const sentMs = Date.parse(lead.whatsapp_sent_at)
  if (!Number.isFinite(sentMs)) {
    return { elegivel: false, motivo: 'whatsapp_sent_at inválido' }
  }
  if (agoraMs - sentMs < FOLLOWUP_JANELA_MS) {
    return { elegivel: false, motivo: 'janela de 48h ainda aberta' }
  }
  if (lead.followup_enviado_em) {
    return { elegivel: false, motivo: 'follow-up já disparado (one-shot)' }
  }
  if (!STATUS_SEM_RESPOSTA.has(lead.whatsapp_send_status)) {
    return { elegivel: false, motivo: `status '${lead.whatsapp_send_status}' (respondeu ou falhou)` }
  }
  if (!ESTADOS_NUNCA_RESPONDEU.has(lead.olivia_estado)) {
    return { elegivel: false, motivo: `olivia_estado '${lead.olivia_estado}' (interagiu ou bloqueado)` }
  }
  return { elegivel: true, motivo: null }
}

/**
 * Filtra os elegíveis e aplica o teto por execução. A query SQL já pré-filtra;
 * isto é a defesa em profundidade (a decisão final é SEMPRE da lógica pura).
 */
export function filtrarElegiveis(
  leads: FollowupLead[],
  agoraMs: number,
  max: number = FOLLOWUP_MAX_POR_RUN,
): FollowupLead[] {
  const ok: FollowupLead[] = []
  for (const lead of leads) {
    if (ok.length >= max) break
    if (elegivelParaFollowup(lead, agoraMs).elegivel) ok.push(lead)
  }
  return ok
}
