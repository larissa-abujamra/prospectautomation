import { describe, expect, it } from 'vitest'
import type { Lead } from '../../lib/types'
import { EMPTY_FILTERS, applyFilters, hubspotFilterLabel, hubspotFilterMatches } from './filters'

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    nome: 'Pietra Patisserie',
    setor: 'Confeitaria',
    endereco: 'Rua das Flores, 123',
    bairro: 'Vila Andrade',
    cidade: 'Sao Paulo',
    lat: null,
    lng: null,
    google_place_id: 'place-123',
    telefone: null,
    website: 'https://pietrapatisserie.com.br',
    rating: null,
    reviews_count: null,
    horario_funcionamento: null,
    instagram_handle: 'pietrapatisserie',
    instagram_followers: null,
    cnpj: null,
    razao_social: null,
    socios: null,
    dono_nome: null,
    porte: null,
    mei: null,
    enrich_status: null,
    whatsapp_phone: null,
    whatsapp_source: null,
    whatsapp_status: null,
    nome_genero: null,
    hubspot_contact_id: null,
    hubspot_synced_at: null,
    hubspot_deal_id: null,
    whatsapp_send_status: null,
    whatsapp_sent_at: null,
    whatsapp_msg_id: null,
    olivia_estado: null,
    olivia_handoff_motivo: null,
    reuniao_at: null,
    reuniao_link: null,
    whatsapp_dono: null,
    bio_ponto_fisico: false,
    bio_linktree: false,
    bio_whatsapp_vendas: false,
    bio_delivery_proprio: false,
    lead_score: null,
    cliente_oculto_at: null,
    cliente_oculto_notas: null,
    status: 'enriquecido',
    notas: null,
    hubspot_exported_at: null,
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
    ...overrides,
  }
}

describe('HubSpot practical filters', () => {
  it('matches leads ready for HubSpot only when they are exportable and not exported', () => {
    expect(hubspotFilterMatches(lead(), 'ready')).toBe(true)
    expect(hubspotFilterMatches(lead({ google_place_id: null }), 'ready')).toBe(false)
    expect(hubspotFilterMatches(lead({ hubspot_contact_id: 'contact-1' }), 'ready')).toBe(false)
  })

  it('matches missing-data leads only when they are not exportable and not exported', () => {
    expect(hubspotFilterMatches(lead({ google_place_id: null }), 'missing')).toBe(true)
    expect(hubspotFilterMatches(lead(), 'missing')).toBe(false)
    expect(hubspotFilterMatches(lead({ google_place_id: null, hubspot_deal_id: 'deal-1' }), 'missing')).toBe(false)
  })

  it('matches already-exported leads from exported timestamp, contact id, or deal id', () => {
    expect(hubspotFilterMatches(lead({ hubspot_exported_at: '2026-06-10T10:00:00Z' }), 'exported')).toBe(true)
    expect(hubspotFilterMatches(lead({ hubspot_contact_id: 'contact-1' }), 'exported')).toBe(true)
    expect(hubspotFilterMatches(lead({ hubspot_deal_id: 'deal-1' }), 'exported')).toBe(true)
    expect(hubspotFilterMatches(lead(), 'exported')).toBe(false)
  })

  it('applies HubSpot filters together with existing filters without hiding existing qualificado leads by default', () => {
    const readyQualificado = lead({ id: 'ready-qualificado', status: 'qualificado' })
    const exported = lead({ id: 'exported', hubspot_exported_at: '2026-06-10T10:00:00Z' })
    const missing = lead({ id: 'missing', google_place_id: null })

    expect(applyFilters([readyQualificado, exported, missing], EMPTY_FILTERS).map((l) => l.id)).toEqual([
      'ready-qualificado',
      'exported',
      'missing',
    ])

    expect(
      applyFilters(
        [readyQualificado, exported, missing],
        { ...EMPTY_FILTERS, hubspot: ['ready'] },
      ).map((l) => l.id),
    ).toEqual(['ready-qualificado'])
  })

  it('uses the approved Portuguese labels for the practical filters', () => {
    expect(hubspotFilterLabel('ready')).toBe('Pronto para HubSpot')
    expect(hubspotFilterLabel('missing')).toBe('Faltando dados')
    expect(hubspotFilterLabel('exported')).toBe('Já exportado')
  })
})
