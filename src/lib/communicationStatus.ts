import type { Lead, WhatsappSource } from './types'

export type StatusDot = 'empty' | 'pending' | 'ok' | 'missing'

export interface CommunicationSummary {
  label: string
  detail: string
  nextAction: string
  dot: StatusDot
}

export interface WhatsappDiscoverySummary extends CommunicationSummary {
  sourceLabel: string | null
}

export interface MeetingSummary {
  scheduledAt: string | null
  meetLink: string | null
  assignedEmployee: string | null
  assignedEmployeeEmail: string | null
  calendarTitle: string | null
  calendarLink: string | null
  hasCalendarEvidence: boolean
}

export const HUBSPOT_PORTAL_ID = '50173893'

export const WHATSAPP_SOURCE_LABEL: Record<WhatsappSource, string> = {
  google: 'Google',
  instagram: 'Instagram',
  website: 'Site',
  manual: 'Manual',
  perplexity: 'Busca web',
}

function cleanId(id: string | null | undefined): string | null {
  const value = id?.trim()
  return value ? value : null
}

export function hubspotContactUrl(contactId: string | null | undefined): string | null {
  const id = cleanId(contactId)
  return id ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${id}` : null
}

export function hubspotDealUrl(dealId: string | null | undefined): string | null {
  const id = cleanId(dealId)
  return id ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${id}` : null
}

export function preferredWhatsappNumber(
  lead: Pick<Lead, 'whatsapp_dono' | 'whatsapp_phone'>,
): string | null {
  const owner = lead.whatsapp_dono?.trim()
  if (owner) return owner
  const discovered = lead.whatsapp_phone?.trim()
  return discovered || null
}

export function whatsappUrl(phone: string | null | undefined): string | null {
  const digits = phone?.replace(/\D/g, '')
  return digits ? `https://wa.me/${digits}` : null
}

export function meetingSummary(
  lead: Pick<
    Lead,
    | 'reuniao_at'
    | 'reuniao_link'
    | 'olivia_assigned_rep_nome'
    | 'olivia_assigned_rep_email'
    | 'reuniao_calendar_title'
    | 'reuniao_calendar_link'
    | 'reuniao_calendar_event_id'
  >,
): MeetingSummary {
  const assignedName = lead.olivia_assigned_rep_nome?.trim() || null
  const assignedEmail = lead.olivia_assigned_rep_email?.trim() || null
  const calendarTitle = lead.reuniao_calendar_title?.trim() || null
  const calendarLink = lead.reuniao_calendar_link?.trim() || null
  const hasCalendarEvidence = !!(calendarTitle || calendarLink || lead.reuniao_calendar_event_id?.trim())

  return {
    scheduledAt: lead.reuniao_at ?? null,
    meetLink: lead.reuniao_link?.trim() || null,
    assignedEmployee: assignedName,
    assignedEmployeeEmail: assignedEmail,
    calendarTitle,
    calendarLink,
    hasCalendarEvidence,
  }
}

export function whatsappDiscoverySummary(
  lead: Pick<Lead, 'whatsapp_phone' | 'whatsapp_dono' | 'whatsapp_source' | 'whatsapp_status'>,
  running = false,
): WhatsappDiscoverySummary {
  const phone = preferredWhatsappNumber(lead)
  const usingOwnerNumber = !!lead.whatsapp_dono?.trim()
  const sourceLabel = usingOwnerNumber
    ? 'Manual (dona/o)'
    : lead.whatsapp_source
      ? WHATSAPP_SOURCE_LABEL[lead.whatsapp_source] ?? lead.whatsapp_source
      : null

  if (running) {
    return {
      label: 'Procurando agora',
      detail: 'A busca está rodando. Aguarde antes de acionar o workflow.',
      nextAction: 'Aguardar a busca terminar.',
      dot: 'pending',
      sourceLabel,
    }
  }

  if (lead.whatsapp_status === 'invalid' && !usingOwnerNumber) {
    return {
      label: 'Número inválido',
      detail: 'O número disponível não passou na validação de WhatsApp brasileiro.',
      nextAction: 'Corrigir manualmente ou procurar de novo.',
      dot: 'missing',
      sourceLabel,
    }
  }

  if (phone) {
    return {
      label: 'Número pronto',
      detail: sourceLabel
        ? `WhatsApp salvo de ${sourceLabel}.`
        : 'WhatsApp salvo e pronto para uso.',
      nextAction: 'Abrir WhatsApp ou acionar o workflow pelo HubSpot.',
      dot: 'ok',
      sourceLabel,
    }
  }

  switch (lead.whatsapp_status) {
    case 'pending':
      return {
        label: 'Busca pendente',
        detail: 'O lead está marcado para descoberta de WhatsApp, mas ainda não há número confiável.',
        nextAction: 'Aguardar a busca ou rodar novamente.',
        dot: 'pending',
        sourceLabel,
      }
    case 'found':
      return {
        label: 'Status inconsistente',
        detail: 'O lead está marcado como encontrado, mas nenhum número foi salvo.',
        nextAction: 'Procurar de novo ou informar um número manualmente.',
        dot: 'missing',
        sourceLabel,
      }
    case 'missing':
      return {
        label: 'Número não encontrado',
        detail: 'A busca terminou sem um telefone confiável para WhatsApp.',
        nextAction: 'Informar manualmente ou procurar de novo.',
        dot: 'missing',
        sourceLabel,
      }
    case 'invalid':
      return {
        label: 'Número inválido',
        detail: 'O número disponível não passou na validação de WhatsApp brasileiro.',
        nextAction: 'Corrigir manualmente ou procurar de novo.',
        dot: 'missing',
        sourceLabel,
      }
    default:
      return {
        label: 'Busca não iniciada',
        detail: 'Ainda não tentamos descobrir um WhatsApp para este lead.',
        nextAction: 'Encontrar número ou informar manualmente.',
        dot: 'empty',
        sourceLabel,
      }
  }
}

export function canTriggerWhatsappWorkflow(
  lead: Pick<Lead, 'origem' | 'google_place_id' | 'whatsapp_phone' | 'whatsapp_dono' | 'whatsapp_status'>,
): boolean {
  // rf_cnpj: lead da Receita já resolvido no Google (tem place_id) — sendable.
  if (lead.origem !== 'google_places' && lead.origem !== 'manual_olivia' && lead.origem !== 'rf_cnpj') return false
  if (!lead.google_place_id) return false

  const hasOwnerNumber = !!lead.whatsapp_dono?.trim()
  const phone = preferredWhatsappNumber(lead)
  if (!phone) return false
  if (lead.whatsapp_status === 'invalid' && !hasOwnerNumber) return false

  return lead.whatsapp_status === 'found' || hasOwnerNumber
}

export function messageWorkflowSummary(
  lead: Pick<
    Lead,
    | 'whatsapp_send_status'
    | 'whatsapp_sent_at'
    | 'whatsapp_phone'
    | 'whatsapp_dono'
    | 'whatsapp_status'
    | 'hubspot_contact_id'
    | 'origem'
    | 'google_place_id'
  >,
  triggering = false,
): CommunicationSummary {
  if (lead.origem === 'squad_leads_form') {
    return {
      label: 'Lead de aprendizado',
      detail: 'Este lead veio do Squad Leads e não entra nos disparos da Olivia.',
      nextAction: 'Não acionar WhatsApp pela Olivia.',
      dot: 'empty',
    }
  }

  if (triggering) {
    return {
      label: 'Acionando HubSpot',
      detail: 'O app está criando/atualizando o contato e marcando o workflow WhatsApp como pronto.',
      nextAction: 'Aguardar a confirmação do HubSpot.',
      dot: 'pending',
    }
  }

  switch (lead.whatsapp_send_status) {
    case 'replied':
      return {
        label: 'Lead respondeu',
        detail: 'O webhook registrou uma resposta recebida para este lead.',
        nextAction: 'Abrir a conversa e continuar o atendimento.',
        dot: 'ok',
      }
    case 'read':
      return {
        label: 'Mensagem lida',
        detail: 'Há evidência de leitura reportada pelo webhook.',
        nextAction: 'Acompanhar a conversa ou preparar follow-up.',
        dot: 'ok',
      }
    case 'delivered':
      return {
        label: 'Mensagem entregue',
        detail: 'Há evidência de entrega reportada pelo webhook.',
        nextAction: 'Aguardar resposta ou abrir a conversa.',
        dot: 'ok',
      }
    case 'sent':
      return {
        label: 'Mensagem enviada',
        detail: 'Há evidência de envio. Ainda não há confirmação de entrega ou leitura.',
        nextAction: 'Aguardar HubSpot/webhook atualizar entrega ou resposta.',
        dot: 'pending',
      }
    case 'failed':
      return {
        label: 'Falha no envio',
        detail: 'HubSpot ou Meta reportou falha no envio do template.',
        nextAction: 'Revisar o número e tentar acionar o workflow de novo.',
        dot: 'missing',
      }
    case 'invalid':
      return {
        label: 'Não enviado: número inválido',
        detail: 'O envio foi bloqueado porque o número não é válido para WhatsApp.',
        nextAction: 'Corrigir o WhatsApp antes de reenviar.',
        dot: 'missing',
      }
    default:
      break
  }

  if (lead.whatsapp_sent_at) {
    return {
      label: 'Workflow acionado no HubSpot',
      detail: 'O app sabe que acionou o workflow. Entrega, leitura e resposta dependem de evidência do webhook.',
      nextAction: 'Abrir HubSpot ou acompanhar a aba Conversa.',
      dot: 'pending',
    }
  }

  const phone = preferredWhatsappNumber(lead)
  const hasOwnerNumber = !!lead.whatsapp_dono?.trim()
  if (!phone || (lead.whatsapp_status === 'invalid' && !hasOwnerNumber)) {
    return {
      label: 'Não disparado',
      detail: 'Ainda não há um WhatsApp válido para acionar o workflow.',
      nextAction: 'Encontrar ou informar um WhatsApp válido.',
      dot: 'empty',
    }
  }

  if ((lead.origem === 'google_places' || lead.origem === 'manual_olivia') && !lead.google_place_id) {
    return {
      label: 'Não sincronizável',
      detail: 'Falta o Google Place ID usado para deduplicar o contato no HubSpot.',
      nextAction: 'Corrigir os dados do lead antes de acionar o workflow.',
      dot: 'missing',
    }
  }

  return {
    label: 'Pronto para enviar',
    detail: lead.hubspot_contact_id
      ? 'Contato já existe no HubSpot. O workflow ainda não foi acionado.'
      : 'O clique cria/atualiza o contato no HubSpot e aciona o workflow.',
    nextAction: 'Acionar o workflow WhatsApp pelo HubSpot.',
    dot: 'pending',
  }
}
