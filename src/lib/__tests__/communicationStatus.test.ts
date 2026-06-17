import { describe, expect, it } from 'vitest'
import {
  canTriggerWhatsappWorkflow,
  hubspotContactUrl,
  hubspotDealUrl,
  meetingSummary,
  messageWorkflowSummary,
  preferredWhatsappNumber,
  whatsappDiscoverySummary,
  whatsappUrl,
} from '../communicationStatus'
import type { Lead } from '../types'

const lead = (over: Partial<Lead>): Lead =>
  ({
    id: 'lead-1',
    nome: 'Padaria Sol',
    whatsapp_phone: null,
    whatsapp_dono: null,
    whatsapp_source: null,
    whatsapp_status: null,
    whatsapp_send_status: null,
    whatsapp_sent_at: null,
    whatsapp_msg_id: null,
    hubspot_contact_id: null,
    hubspot_deal_id: null,
    hubspot_responsavel_contact_id: null,
    hubspot_synced_at: null,
    origem: 'google_places',
    google_place_id: 'google-place-1',
    ...over,
  }) as Lead

describe('HubSpot record URLs', () => {
  it('builds the correct HubSpot object paths for contacts and deals', () => {
    expect(hubspotContactUrl('12345')).toBe(
      'https://app.hubspot.com/contacts/50173893/record/0-1/12345',
    )
    expect(hubspotDealUrl('98765')).toBe(
      'https://app.hubspot.com/contacts/50173893/record/0-3/98765',
    )
  })

  it('does not build links for missing IDs', () => {
    expect(hubspotContactUrl(null)).toBeNull()
    expect(hubspotDealUrl('  ')).toBeNull()
  })
})

describe('WhatsApp number helpers', () => {
  it('prefers the manually confirmed owner number over the discovered store number', () => {
    expect(
      preferredWhatsappNumber(
        lead({ whatsapp_phone: '+5511988887777', whatsapp_dono: '+5511999990000' }),
      ),
    ).toBe('+5511999990000')
  })

  it('builds wa.me links from E.164 or formatted numbers', () => {
    expect(whatsappUrl('+55 (11) 99999-0000')).toBe('https://wa.me/5511999990000')
    expect(whatsappUrl(null)).toBeNull()
  })
})

describe('whatsappDiscoverySummary', () => {
  it('shows not started, running, found, missing, and invalid states clearly', () => {
    expect(whatsappDiscoverySummary(lead()).label).toBe('Busca não iniciada')
    expect(whatsappDiscoverySummary(lead(), true).label).toBe('Procurando agora')
    expect(
      whatsappDiscoverySummary(
        lead({ whatsapp_status: 'found', whatsapp_phone: '+5511988887777', whatsapp_source: 'google' }),
      ),
    ).toMatchObject({
      label: 'Número pronto',
      dot: 'ok',
      sourceLabel: 'Google',
      nextAction: 'Abrir WhatsApp ou acionar o workflow pelo HubSpot.',
    })
    expect(whatsappDiscoverySummary(lead({ whatsapp_status: 'missing' }))).toMatchObject({
      label: 'Número não encontrado',
      dot: 'missing',
    })
    expect(whatsappDiscoverySummary(lead({ whatsapp_status: 'invalid' }))).toMatchObject({
      label: 'Número inválido',
      dot: 'missing',
    })
  })

  it('does not label an invalid stored discovery number as ready', () => {
    expect(
      whatsappDiscoverySummary(
        lead({ whatsapp_status: 'invalid', whatsapp_phone: '+5511988887777', whatsapp_source: 'google' }),
      ),
    ).toMatchObject({
      label: 'Número inválido',
      dot: 'missing',
      nextAction: 'Corrigir manualmente ou procurar de novo.',
    })
  })

  it('allows a manually confirmed owner number to override an invalid discovered number', () => {
    expect(
      whatsappDiscoverySummary(
        lead({
          whatsapp_status: 'invalid',
          whatsapp_phone: '+5511000000000',
          whatsapp_dono: '+5511999990000',
        }),
      ),
    ).toMatchObject({
      label: 'Número pronto',
      dot: 'ok',
      sourceLabel: 'Manual (dona/o)',
    })
  })

  it('surfaces inconsistent found-without-phone data instead of hiding it', () => {
    expect(whatsappDiscoverySummary(lead({ whatsapp_status: 'found' }))).toMatchObject({
      label: 'Status inconsistente',
      dot: 'missing',
      nextAction: 'Procurar de novo ou informar um número manualmente.',
    })
  })
})

describe('messageWorkflowSummary', () => {
  it('labels HubSpot workflow-triggered separately from delivered/read evidence', () => {
    expect(messageWorkflowSummary(lead({ whatsapp_sent_at: '2026-06-11T12:00:00Z' }))).toMatchObject({
      label: 'Workflow acionado no HubSpot',
      dot: 'pending',
      nextAction: 'Abrir HubSpot ou acompanhar a aba Conversa.',
    })
  })

  it('maps webhook delivery states only when evidence exists', () => {
    expect(messageWorkflowSummary(lead({ whatsapp_send_status: 'sent' })).label).toBe('Mensagem enviada')
    expect(messageWorkflowSummary(lead({ whatsapp_send_status: 'delivered' })).label).toBe('Mensagem entregue')
    expect(messageWorkflowSummary(lead({ whatsapp_send_status: 'read' })).label).toBe('Mensagem lida')
    expect(messageWorkflowSummary(lead({ whatsapp_send_status: 'replied' }))).toMatchObject({
      label: 'Lead respondeu',
      dot: 'ok',
      nextAction: 'Abrir a conversa e continuar o atendimento.',
    })
  })

  it('explains failures and invalid numbers with the safest next action', () => {
    expect(messageWorkflowSummary(lead({ whatsapp_send_status: 'failed' }))).toMatchObject({
      label: 'Falha no envio',
      dot: 'missing',
      nextAction: 'Revisar o número e tentar acionar o workflow de novo.',
    })
    expect(messageWorkflowSummary(lead({ whatsapp_send_status: 'invalid' }))).toMatchObject({
      label: 'Não enviado: número inválido',
      dot: 'missing',
      nextAction: 'Corrigir o WhatsApp antes de reenviar.',
    })
  })

  it('distinguishes no number from ready-to-trigger leads', () => {
    expect(messageWorkflowSummary(lead()).nextAction).toBe('Encontrar ou informar um WhatsApp válido.')
    expect(
      messageWorkflowSummary(
        lead({ whatsapp_status: 'found', whatsapp_phone: '+5511988887777', hubspot_contact_id: '12345' }),
      ),
    ).toMatchObject({
      label: 'Pronto para enviar',
      nextAction: 'Acionar o workflow WhatsApp pelo HubSpot.',
    })
  })

  it('keeps inbound Squad Leads learning-only and not eligible for workflow trigger', () => {
    const inbound = lead({
      origem: 'squad_leads_form',
      google_place_id: null,
      whatsapp_status: 'found',
      whatsapp_phone: '+5511988887777',
    })

    expect(canTriggerWhatsappWorkflow(inbound)).toBe(false)
    expect(messageWorkflowSummary(inbound)).toMatchObject({
      label: 'Lead de aprendizado',
      dot: 'empty',
      nextAction: 'Não acionar WhatsApp pela Olivia.',
    })
  })

  it('requires a Google dedup key before showing the workflow trigger action', () => {
    expect(
      canTriggerWhatsappWorkflow(
        lead({ whatsapp_status: 'found', whatsapp_phone: '+5511988887777', google_place_id: 'place-1' }),
      ),
    ).toBe(true)
    expect(
      canTriggerWhatsappWorkflow(
        lead({ whatsapp_status: 'found', whatsapp_phone: '+5511988887777', google_place_id: null }),
      ),
    ).toBe(false)
  })
})

describe('meetingSummary', () => {
  it('exposes assigned Inner employee and calendar evidence when available', () => {
    expect(
      meetingSummary(
        lead({
          reuniao_at: '2026-06-15T17:00:00Z',
          reuniao_link: 'https://meet.google.com/abc-defg-hij',
          olivia_assigned_rep_nome: 'Ana Inner',
          olivia_assigned_rep_email: 'ana@innerai.com',
          reuniao_calendar_title: 'Pietra Pâtisserie <> Ana Inner',
          reuniao_calendar_link: 'https://calendar.google.com/event?eid=abc',
        }),
      ),
    ).toMatchObject({
      assignedEmployee: 'Ana Inner',
      assignedEmployeeEmail: 'ana@innerai.com',
      calendarTitle: 'Pietra Pâtisserie <> Ana Inner',
      calendarLink: 'https://calendar.google.com/event?eid=abc',
      meetLink: 'https://meet.google.com/abc-defg-hij',
      hasCalendarEvidence: true,
    })
  })

  it('falls back gracefully when a scheduled meeting has no persisted calendar evidence yet', () => {
    expect(
      meetingSummary(
        lead({
          reuniao_at: '2026-06-15T17:00:00Z',
          reuniao_link: 'https://meet.google.com/abc-defg-hij',
        }),
      ),
    ).toMatchObject({
      assignedEmployee: null,
      calendarTitle: null,
      calendarLink: null,
      meetLink: 'https://meet.google.com/abc-defg-hij',
      hasCalendarEvidence: false,
    })
  })
})
