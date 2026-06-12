import { describe, expect, it } from 'vitest'
import type { Lead } from '../types'
import { buildHubspotPreview, websiteInstagramMismatchWarning } from '../hubspotPreview'

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
    squad_leads_id: null,
    origem: 'google_places',
    telefone: null,
    website: 'https://pietrapatisserie.com.br',
    rating: null,
    reviews_count: null,
    horario_funcionamento: null,
    instagram_handle: 'pietrapatisserie',
    instagram_followers: null,
    cnpj: '12.345.678/0001-90',
    razao_social: null,
    socios: null,
    dono_nome: 'Maria Silva',
    porte: null,
    mei: null,
    enrich_status: null,
    whatsapp_phone: '+5511999998888',
    whatsapp_source: 'google',
    whatsapp_status: 'found',
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
    inbound_score: null,
    inbound_classification: null,
    inbound_revenue_range: null,
    inbound_ready_to_implement: null,
    inbound_created_at: null,
    inbound_utm_source: null,
    inbound_utm_medium: null,
    inbound_utm_campaign: null,
    inbound_meta: null,
    status: 'enriquecido',
    notas: null,
    hubspot_exported_at: null,
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
    ...overrides,
  }
}

describe('buildHubspotPreview', () => {
  it('lists the exact fields the confirmation modal previews', () => {
    expect(buildHubspotPreview(lead())).toEqual([
      { label: 'Nome', value: 'Pietra Patisserie' },
      { label: 'Website', value: 'https://pietrapatisserie.com.br' },
      { label: 'Instagram', value: '@pietrapatisserie' },
      { label: 'CNPJ', value: '12.345.678/0001-90' },
      { label: 'Dono', value: 'Maria Silva' },
      { label: 'WhatsApp', value: '+5511999998888' },
    ])
  })

  it('prefers the manually collected owner WhatsApp in the preview', () => {
    const preview = buildHubspotPreview(lead({ whatsapp_dono: '+5511888887777' }))
    expect(preview.find((row) => row.label === 'WhatsApp')?.value).toBe('+5511888887777')
  })

  it('uses a dash for missing optional fields instead of inventing values', () => {
    const preview = buildHubspotPreview(
      lead({ website: null, instagram_handle: null, cnpj: null, dono_nome: null, whatsapp_phone: null }),
    )
    expect(preview.map((row) => row.value)).toEqual(['Pietra Patisserie', '—', '—', '—', '—', '—'])
  })
})

describe('websiteInstagramMismatchWarning', () => {
  it('warns on an obvious domain and Instagram handle mismatch', () => {
    expect(
      websiteInstagramMismatchWarning(lead({ website: 'https://outrapadaria.com.br' })),
    ).toContain('Website e Instagram parecem apontar para marcas diferentes')
  })

  it('does not warn when the website domain contains the Instagram handle', () => {
    expect(websiteInstagramMismatchWarning(lead())).toBeNull()
  })

  it('does not warn for Instagram profile URLs that match the handle', () => {
    expect(websiteInstagramMismatchWarning(lead({ website: 'https://www.instagram.com/pietrapatisserie/' }))).toBeNull()
  })
})
