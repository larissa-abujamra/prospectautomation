import { describe, expect, it } from 'vitest'
import {
  mapSquadLeadToLeadRow,
  normalizeSquadContactPhone,
  normalizeSquadInstagramHandle,
} from '../../../supabase/functions/_shared/squad_leads'

const baseLead = {
  id: 42,
  companyName: '  Brigadeiros da Ana  ',
  hasInstagram: 'sim',
  instagramHandle: ' @Ana.Doces ',
  hasWhatsapp: 'sim',
  sellsOnWhatsapp: 'sim',
  hasCnpj: 'sim',
  revenueRange: '20k_50k',
  readyToImplement: 'sim_certeza',
  score: 87,
  classification: 'quente',
  contactName: 'Ana Paula',
  contactPhone: '(11) 98888-7777',
  utmSource: 'acesso',
  utmMedium: null,
  utmCampaign: 'convite-abc123',
  createdAt: '2026-06-01T12:30:00.000Z',
} as const

describe('normalizeSquadInstagramHandle', () => {
  it('limpa arroba, espaços e caixa do handle recebido do formulário', () => {
    expect(normalizeSquadInstagramHandle(' @Ana.Doces ')).toBe('ana.doces')
  })

  it('remove URL de perfil e rejeita valor vazio ou rota genérica', () => {
    expect(normalizeSquadInstagramHandle('https://instagram.com/Loja_Bolos/')).toBe('loja_bolos')
    expect(normalizeSquadInstagramHandle('@')).toBeNull()
    expect(normalizeSquadInstagramHandle('instagram.com/p/abc')).toBeNull()
  })
})

describe('normalizeSquadContactPhone', () => {
  it('normaliza telefone local brasileiro para E.164 usado pelo pipeline', () => {
    expect(normalizeSquadContactPhone('(11) 98888-7777')).toBe('+5511988887777')
    expect(normalizeSquadContactPhone('5511988887777')).toBe('+5511988887777')
  })

  it('rejeita telefone malformado sem inventar dígitos', () => {
    expect(normalizeSquadContactPhone('119888877')).toBeNull()
    expect(normalizeSquadContactPhone('liga comigo')).toBeNull()
  })
})

describe('mapSquadLeadToLeadRow', () => {
  it('mapeia lead inbound para public.leads sem preencher CNPJ auto-declarado', () => {
    const mapped = mapSquadLeadToLeadRow(baseLead)

    expect(mapped).toEqual({
      ok: true,
      row: expect.objectContaining({
        squad_leads_id: 42,
        origem: 'squad_leads_form',
        nome: 'Brigadeiros da Ana',
        dono_nome: 'Ana Paula',
        telefone: '+5511988887777',
        instagram_handle: 'ana.doces',
        cnpj: null,
        inbound_score: 87,
        inbound_classification: 'quente',
        inbound_revenue_range: '20k_50k',
        inbound_ready_to_implement: 'sim_certeza',
        inbound_created_at: '2026-06-01T12:30:00.000Z',
        inbound_utm_source: 'acesso',
        inbound_utm_medium: null,
        inbound_utm_campaign: 'convite-abc123',
      }),
    })
  })

  it('preserva telefone bruto em metadata quando não dá para normalizar', () => {
    const mapped = mapSquadLeadToLeadRow({ ...baseLead, contactPhone: 'sem telefone' })

    expect(mapped.ok).toBe(true)
    if (mapped.ok) {
      expect(mapped.row.telefone).toBeNull()
      expect(mapped.row.inbound_meta).toEqual(expect.objectContaining({ contact_phone_raw: 'sem telefone' }))
    }
  })

  it('pula linhas sem chave fonte ou nome da empresa', () => {
    expect(mapSquadLeadToLeadRow({ ...baseLead, id: 0 })).toEqual({
      ok: false,
      reason: 'missing_source_id',
    })
    expect(mapSquadLeadToLeadRow({ ...baseLead, companyName: ' ' })).toEqual({
      ok: false,
      reason: 'missing_company_name',
    })
  })
})
