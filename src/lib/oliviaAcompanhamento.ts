import type { Lead } from './types'

const OLIVIA_ESTADOS_EM_ANDAMENTO = new Set<Lead['olivia_estado']>([
  'aguardando',
  'conversando',
  'agendando',
])

const WHATSAPP_STATUS_SEM_RESPOSTA = new Set<Lead['whatsapp_send_status']>([
  'sent',
  'delivered',
  'read',
])

const WHATSAPP_STATUS_FALHA = new Set<Lead['whatsapp_send_status']>([
  'failed',
  'invalid',
])

type LeadAcompanhamento = Pick<
  Lead,
  'olivia_estado' | 'whatsapp_sent_at' | 'whatsapp_send_status'
>

export function aguardandoRespostaOlivia(lead: LeadAcompanhamento): boolean {
  if (WHATSAPP_STATUS_FALHA.has(lead.whatsapp_send_status)) return false
  if (lead.olivia_estado && OLIVIA_ESTADOS_EM_ANDAMENTO.has(lead.olivia_estado)) return true
  if (lead.olivia_estado) return false
  if (lead.whatsapp_send_status === 'replied') return false
  if (WHATSAPP_STATUS_SEM_RESPOSTA.has(lead.whatsapp_send_status)) return true
  return !!lead.whatsapp_sent_at
}

export function leadsEmAcompanhamentoOlivia(leads: Lead[]): Lead[] {
  return leads
    .filter(aguardandoRespostaOlivia)
    .sort((a, b) => {
      const ta = a.whatsapp_sent_at ? Date.parse(a.whatsapp_sent_at) : 0
      const tb = b.whatsapp_sent_at ? Date.parse(b.whatsapp_sent_at) : 0
      return tb - ta
    })
}
