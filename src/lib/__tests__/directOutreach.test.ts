import { describe, expect, it } from 'vitest'
import {
  buildDirectCompanySearchParams,
  directOutreachWarnings,
  hasValidBrWhatsappForDirectOutreach,
  parseDirectCompanyInput,
  scoreDirectCompanyMatch,
  selectBestDirectLead,
} from '../directOutreach'
import type { Lead } from '../types'

const lead = (overrides: Partial<Lead>): Lead =>
  ({
    id: 'lead-1',
    nome: 'Pietra Patisserie',
    origem: 'google_places',
    google_place_id: 'place-1',
    whatsapp_phone: '+5511999990000',
    whatsapp_dono: null,
    whatsapp_status: 'found',
    whatsapp_sent_at: null,
    whatsapp_send_status: null,
    hubspot_contact_id: null,
    hubspot_deal_id: null,
    ...overrides,
  }) as Lead

describe('parseDirectCompanyInput', () => {
  it('splits company and context from comma input', () => {
    expect(parseDirectCompanyInput('Pietra Patisserie, Pinheiros, SP')).toEqual({
      raw: 'Pietra Patisserie, Pinheiros, SP',
      company: 'Pietra Patisserie',
      context: 'Pinheiros, SP',
    })
  })

  it('keeps context optional and defaults search to Brazil', () => {
    const parsed = parseDirectCompanyInput('Pietra Patisserie')
    expect(parsed).toEqual({
      raw: 'Pietra Patisserie',
      company: 'Pietra Patisserie',
      context: null,
    })
    expect(buildDirectCompanySearchParams(parsed!)).toMatchObject({
      setor: 'Pietra Patisserie',
      local: 'Brasil',
      max: 5,
      comSeguidores: false,
    })
  })
})

describe('selectBestDirectLead', () => {
  it('selects the strongest company-name match among returned place ids', () => {
    const selection = selectBestDirectLead(
      [
        lead({ id: 'a', nome: 'Outra Doceria', google_place_id: 'place-a' }),
        lead({ id: 'b', nome: 'Pietra Patisserie Jardins', google_place_id: 'place-b' }),
      ],
      ['place-a', 'place-b'],
      'Pietra Patisserie',
    )

    expect(selection?.lead.id).toBe('b')
    expect(selection?.confidence).toBe('alta')
    expect(scoreDirectCompanyMatch('Pietra Patisserie', selection!.lead)).toBeGreaterThan(80)
  })

  it('uses Google result order as the tie breaker', () => {
    const selection = selectBestDirectLead(
      [
        lead({ id: 'a', nome: 'Padaria Sol', google_place_id: 'place-a' }),
        lead({ id: 'b', nome: 'Padaria Sol', google_place_id: 'place-b' }),
      ],
      ['place-b', 'place-a'],
      'Padaria Sol',
    )

    expect(selection?.lead.id).toBe('b')
  })
})

describe('hasValidBrWhatsappForDirectOutreach', () => {
  it('allows Google leads with valid BR WhatsApp and no previous outreach', () => {
    expect(hasValidBrWhatsappForDirectOutreach(lead({}))).toBe(true)
  })

  it('blocks no phone, invalid phone, previous outreach, and non-Google leads', () => {
    expect(hasValidBrWhatsappForDirectOutreach(lead({ whatsapp_phone: null }))).toBe(false)
    expect(hasValidBrWhatsappForDirectOutreach(lead({ whatsapp_phone: '+14155552671' }))).toBe(false)
    expect(hasValidBrWhatsappForDirectOutreach(lead({ whatsapp_sent_at: '2026-06-15T12:00:00Z' }))).toBe(false)
    expect(hasValidBrWhatsappForDirectOutreach(lead({ origem: 'squad_leads_form', google_place_id: null }))).toBe(false)
  })
})

describe('directOutreachWarnings', () => {
  it('surfaces duplicate HubSpot and already-contacted warnings', () => {
    const warnings = directOutreachWarnings(
      lead({
        hubspot_contact_id: '123',
        hubspot_deal_id: '456',
        whatsapp_sent_at: '2026-06-15T12:00:00Z',
      }),
      'alta',
    )

    expect(warnings.join('\n')).toContain('já teve disparo')
    expect(warnings.join('\n')).toContain('Contato/negócio já existe')
  })
})
