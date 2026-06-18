// Follow-up conversacional (nudge) — lógica pura, sem I/O.
// =============================================================================
// Unit-testada (src/lib/__tests__/olivia_nudge.test.ts) e usada pela Edge
// Function olivia-nudge. Decide se um CHAT VIVO esfriou e merece um empurrãozinho.
//
// Regras (TODAS precisam valer):
//  1. estado é chat vivo: 'conversando' ou 'agendando' (não terminal/frio);
//  2. o cliente já mandou >=1 mensagem (lastInMs != null) — só então é "chat";
//  3. a Olivia falou por último (lastDir == 'out') — o cliente é quem sumiu;
//  4. o último inbound foi há >= janela (23h por padrão);
//  5. re-armado: nunca cutucado neste silêncio (nudgeEmMs nulo ou < lastInMs).
//
// JANELA DO WHATSAPP: < 24h desde o último inbound → pode mandar mensagem LIVRE
// (natural, contextual). >= 24h → só template aprovado (squad_followup_1).
// =============================================================================

export const NUDGE_JANELA_MS = 23 * 60 * 60 * 1000
export const WHATSAPP_JANELA_MS = 24 * 60 * 60 * 1000
export const NUDGE_MAX_POR_RUN = 25

const ESTADOS_CHAT_VIVO = new Set<string | null>(['conversando', 'agendando'])

export interface NudgeLead {
  olivia_estado: string | null
  /** Epoch ms do último inbound (mensagem do cliente). null = nunca respondeu. */
  lastInMs: number | null
  /** Direção da última mensagem da conversa. */
  lastDir: 'in' | 'out' | null
  /** Epoch ms do último nudge enviado (olivia_nudge_em). null = nunca. */
  nudgeEmMs: number | null
}

export interface Elegibilidade {
  elegivel: boolean
  motivo: string | null
}

export function elegivelParaNudge(
  lead: NudgeLead,
  agoraMs: number,
  janelaMs: number = NUDGE_JANELA_MS,
): Elegibilidade {
  if (!ESTADOS_CHAT_VIVO.has(lead.olivia_estado)) {
    return { elegivel: false, motivo: `estado '${lead.olivia_estado}' não é chat vivo` }
  }
  if (lead.lastInMs == null) {
    return { elegivel: false, motivo: 'cliente nunca mandou mensagem (não é chat)' }
  }
  if (lead.lastDir !== 'out') {
    return { elegivel: false, motivo: 'última mensagem não é da Olivia (aguardando resposta dela, não do cliente)' }
  }
  if (agoraMs - lead.lastInMs < janelaMs) {
    return { elegivel: false, motivo: 'silêncio menor que a janela (ainda cedo)' }
  }
  if (lead.nudgeEmMs != null && lead.nudgeEmMs >= lead.lastInMs) {
    return { elegivel: false, motivo: 'já cutucado neste período de silêncio (re-arma só se o cliente responder)' }
  }
  return { elegivel: true, motivo: null }
}

/**
 * Dentro da janela de 24h do WhatsApp (desde o último inbound) → pode mandar
 * mensagem LIVRE (natural). Fora → só template. Default: dentro só se houver
 * inbound recente.
 */
export function podeMensagemLivre(lastInMs: number | null, agoraMs: number): boolean {
  return lastInMs != null && agoraMs - lastInMs < WHATSAPP_JANELA_MS
}
