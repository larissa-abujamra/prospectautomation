import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Lead } from './types'

// Acompanhamento de disparos (aba "Disparos" da Olivia).
// =============================================================================
// Responde as perguntas que hoje ficavam no escuro: a mensagem saiu? em que
// estado está? alguém respondeu?
//
// HONESTIDADE DO STATUS (anti-invenção): no fluxo atual o envio é feito pelo
// workflow do HubSpot. O app sabe com certeza que ACIONOU o workflow
// (whatsapp_sent_at); os estados sent/delivered/read só existem quando algum
// webhook os reporta; 'replied' vem do olivia-hubspot-webhook. Nunca mostramos
// "entregue" sem evidência.

export interface StatusDisparo {
  label: string
  dot: 'empty' | 'pending' | 'ok' | 'missing'
}

/** Status legível do disparo de um lead (puro, testável). */
export function statusDisparo(lead: Pick<Lead, 'whatsapp_send_status' | 'whatsapp_sent_at'>): StatusDisparo {
  switch (lead.whatsapp_send_status) {
    case 'replied':
      return { label: 'Respondeu', dot: 'ok' }
    case 'read':
      return { label: 'Lido', dot: 'ok' }
    case 'delivered':
      return { label: 'Entregue', dot: 'ok' }
    case 'sent':
      return { label: 'Enviado', dot: 'pending' }
    case 'failed':
      return { label: 'Falhou', dot: 'missing' }
    case 'invalid':
      return { label: 'Número inválido', dot: 'missing' }
    default:
      // Sem status de entrega: o que sabemos é que o workflow foi acionado.
      return lead.whatsapp_sent_at
        ? { label: 'Acionado no HubSpot', dot: 'pending' }
        : { label: 'Não disparado', dot: 'empty' }
  }
}

/** Leads com disparo iniciado, mais recente primeiro (puro, testável). */
export function leadsDisparados(leads: Lead[]): Lead[] {
  return leads
    .filter((l) => l.whatsapp_sent_at != null || l.whatsapp_send_status != null)
    .sort((a, b) => {
      const ta = a.whatsapp_sent_at ? Date.parse(a.whatsapp_sent_at) : 0
      const tb = b.whatsapp_sent_at ? Date.parse(b.whatsapp_sent_at) : 0
      return tb - ta
    })
}

// --- Respostas novas (notificação in-app) -------------------------------------

const VISTO_KEY = 'disparos:vistoEm'

/** Última vez que a aba Disparos foi vista (ISO) — null na primeira visita. */
export function lerVistoEm(): string | null {
  try {
    return localStorage.getItem(VISTO_KEY)
  } catch {
    return null
  }
}

export function marcarVistoAgora(): void {
  try {
    localStorage.setItem(VISTO_KEY, new Date().toISOString())
  } catch {
    /* storage indisponível (modo privado) — o badge só fica menos preciso */
  }
}

export interface RespostaRecente {
  lead_id: string | null
  enviada_em: string
}

/**
 * Mensagens RECEBIDAS (direcao 'in') desde `sinceIso`. Poll de 15s — mesmo ritmo
 * da aba Conversa. É a fonte do badge "novas respostas": chegou inbound depois
 * da última visita à aba Disparos → notifica.
 */
export function useRespostasDesde(sinceIso: string | null) {
  return useQuery({
    queryKey: ['respostas-novas', sinceIso ?? 'inicio'],
    queryFn: async (): Promise<RespostaRecente[]> => {
      let q = supabase
        .from('whatsapp_mensagens')
        .select('lead_id, enviada_em')
        .eq('direcao', 'in')
        .order('enviada_em', { ascending: false })
        .limit(100)
      if (sinceIso) q = q.gt('enviada_em', sinceIso)
      const { data, error } = await q
      if (error) throw error
      return (data ?? []) as RespostaRecente[]
    },
    refetchInterval: 15_000,
  })
}

/** Conta respostas novas por lead distinto (o que o badge mostra). */
export function contarLeadsComResposta(respostas: RespostaRecente[]): number {
  return new Set(respostas.filter((r) => r.lead_id).map((r) => r.lead_id)).size
}
