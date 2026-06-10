import { describe, it, expect } from 'vitest'
import {
  canSyncToHubspot,
  leadToContactProperties,
  leadToContactPropertiesWithTrigger,
  canExportDeal,
  leadToDealProperties,
  HUBSPOT_DEDUP_PROPERTY,
  HUBSPOT_OUTREACH_PROPERTY,
  HUBSPOT_WHATSAPP_PHONE_PROPERTY,
  HUBSPOT_DEALS_PIPELINE,
  HUBSPOT_STAGE_PROSPECTS,
} from '../../../supabase/functions/_shared/hubspot'
import type { Lead } from '../types'

// Lead mínimo "sincronizável": número achado + place_id (chave de dedup).
function baseLead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'uuid-1',
    nome: 'Pietra Pâtisserie',
    setor: 'Confeitaria',
    endereco: 'R. José da Silva Ribeiro, 616',
    bairro: 'Vila Andrade',
    cidade: 'São Paulo',
    lat: null,
    lng: null,
    google_place_id: 'ChIJ_place_123',
    telefone: '(11) 96336-6136',
    website: 'http://www.instagram.com/pietrapatisserie',
    rating: 4.9,
    reviews_count: 69,
    instagram_handle: 'pietrapatisserie',
    instagram_followers: 7106,
    cnpj: null,
    razao_social: null,
    socios: null,
    dono_nome: null,
    enrich_status: null,
    whatsapp_phone: '+5511963366136',
    whatsapp_source: 'google',
    whatsapp_status: 'found',
    nome_genero: 'f',
    hubspot_contact_id: null,
    hubspot_synced_at: null,
    whatsapp_send_status: null,
    whatsapp_sent_at: null,
    whatsapp_msg_id: null,
    olivia_estado: null,
    olivia_handoff_motivo: null,
    reuniao_at: null,
    reuniao_link: null,
    whatsapp_dono: null,
    cliente_oculto_at: null,
    cliente_oculto_notas: null,
    status: 'enriquecido',
    notas: null,
    hubspot_exported_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    ...over,
  }
}

describe('canSyncToHubspot', () => {
  it('aceita lead com número achado + place_id', () => {
    expect(canSyncToHubspot(baseLead())).toBe(true)
  })

  it('rejeita sem whatsapp_phone', () => {
    expect(canSyncToHubspot(baseLead({ whatsapp_phone: null, whatsapp_status: 'missing' }))).toBe(false)
  })

  it('rejeita se status não for found', () => {
    expect(canSyncToHubspot(baseLead({ whatsapp_status: 'missing' }))).toBe(false)
  })

  it('rejeita sem google_place_id (sem chave de dedup, não sincroniza)', () => {
    expect(canSyncToHubspot(baseLead({ google_place_id: null }))).toBe(false)
  })

  // O nº manual da dona(o) também destrava o sync: é exatamente o lead que o
  // plano de 10/06 manda preferir no disparo — não pode falhar em silêncio.
  it('aceita lead SÓ com whatsapp_dono (nº manual), sem nº da loja achado', () => {
    expect(
      canSyncToHubspot(
        baseLead({ whatsapp_phone: null, whatsapp_status: 'missing', whatsapp_dono: '+5511988887777' }),
      ),
    ).toBe(true)
  })

  it('whatsapp_dono vazio (ou só espaços) NÃO destrava o gate (anti-invenção)', () => {
    for (const vazio of ['', '   ']) {
      expect(
        canSyncToHubspot(baseLead({ whatsapp_phone: null, whatsapp_status: 'missing', whatsapp_dono: vazio })),
      ).toBe(false)
    }
  })

  it('mesmo com whatsapp_dono, sem place_id não sincroniza (dedup obrigatório)', () => {
    expect(
      canSyncToHubspot(
        baseLead({
          whatsapp_phone: null,
          whatsapp_status: 'missing',
          whatsapp_dono: '+5511988887777',
          google_place_id: null,
        }),
      ),
    ).toBe(false)
  })
})

describe('leadToContactProperties', () => {
  it('mapeia os campos essenciais', () => {
    const p = leadToContactProperties(baseLead())
    expect(p[HUBSPOT_DEDUP_PROPERTY]).toBe('ChIJ_place_123')
    expect(p.phone).toBe('+5511963366136')
    expect(p.company).toBe('Pietra Pâtisserie')
    expect(p.city).toBe('São Paulo')
    expect(p.website).toBe('http://www.instagram.com/pietrapatisserie')
    expect(p.lifecyclestage).toBe('lead')
  })

  it('usa dono_nome como firstname quando existe', () => {
    const p = leadToContactProperties(baseLead({ dono_nome: 'Maria Silva' }))
    expect(p.firstname).toBe('Maria Silva')
  })

  it('NÃO inventa: campos nulos são omitidos (não viram string vazia)', () => {
    const p = leadToContactProperties(
      baseLead({ dono_nome: null, website: null, cidade: null }),
    )
    expect('firstname' in p).toBe(false)
    expect('website' in p).toBe(false)
    expect('city' in p).toBe(false)
  })

  it('inclui o handle do Instagram só quando presente', () => {
    expect(leadToContactProperties(baseLead()).instagram_handle).toBe('pietrapatisserie')
    expect('instagram_handle' in leadToContactProperties(baseLead({ instagram_handle: null }))).toBe(false)
  })

  it('sempre inclui a chave de dedup (place_id)', () => {
    const p = leadToContactProperties(baseLead())
    expect(p[HUBSPOT_DEDUP_PROPERTY]).toBeTruthy()
  })

  it('preenche hs_whatsapp_phone_number (o que o WhatsApp do HubSpot usa p/ enviar + opt-in)', () => {
    const p = leadToContactProperties(baseLead({ whatsapp_phone: '+5511963366136' }))
    expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511963366136')
  })

  it('inclui nome_genero quando definido (para o workflow ramificar f/m)', () => {
    expect(leadToContactProperties(baseLead({ nome_genero: 'm' })).nome_genero).toBe('m')
    expect(leadToContactProperties(baseLead({ nome_genero: 'f' })).nome_genero).toBe('f')
  })

  it('omite nome_genero quando nulo (anti-invenção)', () => {
    expect('nome_genero' in leadToContactProperties(baseLead({ nome_genero: null }))).toBe(false)
  })

  it('inclui setor_grupo p/ o workflow por segmento ramificar (template por perfil)', () => {
    expect(leadToContactProperties(baseLead()).setor_grupo).toBe('doces')
    expect(leadToContactProperties(baseLead({ setor: 'Academia' })).setor_grupo).toBe('generic')
    // sem setor → generic (copy genérica é segura p/ qualquer negócio)
    expect(leadToContactProperties(baseLead({ setor: null })).setor_grupo).toBe('generic')
  })

  // WhatsApp da dona(o): nº pessoal preenchido MANUALMENTE pelo time tem
  // preferência sobre o nº da loja no disparo (decisão LGPD do plano de 10/06).
  it('prefere whatsapp_dono em phone e hs_whatsapp_phone_number quando presente', () => {
    const p = leadToContactProperties(baseLead({ whatsapp_dono: '+5511988887777' }))
    expect(p.phone).toBe('+5511988887777')
    expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511988887777')
  })

  it('sem whatsapp_dono, continua usando whatsapp_phone (nº da loja)', () => {
    const p = leadToContactProperties(baseLead({ whatsapp_dono: null }))
    expect(p.phone).toBe('+5511963366136')
    expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511963366136')
  })

  it('whatsapp_dono vazio (ou só espaços) é tratado como ausente (anti-invenção)', () => {
    for (const vazio of ['', '   ']) {
      const p = leadToContactProperties(baseLead({ whatsapp_dono: vazio }))
      expect(p.phone).toBe('+5511963366136')
      expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511963366136')
    }
  })
})

describe('leadToContactPropertiesWithTrigger', () => {
  it('marca whatsapp_outreach=ready quando trigger=true', () => {
    const p = leadToContactPropertiesWithTrigger(baseLead(), true)
    expect(p[HUBSPOT_OUTREACH_PROPERTY]).toBe('ready')
    // ainda traz o mapeamento normal
    expect(p[HUBSPOT_DEDUP_PROPERTY]).toBe('ChIJ_place_123')
    expect(p.phone).toBe('+5511963366136')
  })

  it('NÃO marca o gatilho quando trigger=false (só sincroniza)', () => {
    const p = leadToContactPropertiesWithTrigger(baseLead(), false)
    expect(HUBSPOT_OUTREACH_PROPERTY in p).toBe(false)
  })
})

describe('canExportDeal', () => {
  it('aceita com nome + place_id (CNPJ/dono NÃO exigidos)', () => {
    expect(canExportDeal(baseLead({ cnpj: null, dono_nome: null }))).toBe(true)
  })
  it('rejeita sem place_id', () => {
    expect(canExportDeal(baseLead({ google_place_id: null }))).toBe(false)
  })
})

describe('leadToDealProperties', () => {
  it('cria o negócio em Squad Prospects / etapa Prospects', () => {
    const p = leadToDealProperties(baseLead())
    expect(p.dealname).toBe('Pietra Pâtisserie')
    expect(p.pipeline).toBe(HUBSPOT_DEALS_PIPELINE)
    expect(p.dealstage).toBe(HUBSPOT_STAGE_PROSPECTS)
  })
})
