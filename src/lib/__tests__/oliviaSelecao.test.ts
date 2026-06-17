import { describe, it, expect } from 'vitest'
import {
  aguardandoWhatsapp,
  filtrarLeads,
  FILTROS_VAZIOS,
  jaTeveDisparo,
  leadDisponivelParaProspeccao,
  leadsDaBusca,
  leadsInboundParaAprendizado,
  selecionadosVisiveis,
  temWhatsapp,
} from '../oliviaSelecao'
import type { Lead } from '../types'

const lead = (over: Partial<Lead>): Lead =>
  ({ id: 'x', status: 'descoberto', google_place_id: null, ...over }) as Lead

describe('leadsDaBusca', () => {
  const leads = [
    lead({ id: 'a', status: 'descoberto', google_place_id: 'P1' }), // desta busca, fresco
    lead({ id: 'b', status: 'descoberto', google_place_id: 'P2' }), // desta busca, fresco
    lead({ id: 'c', status: 'descoberto', google_place_id: 'PX' }), // descoberto MAS de outra busca
    lead({ id: 'd', status: 'qualificado', google_place_id: 'P3' }), // desta busca, mas já processado
    lead({ id: 'e', status: 'descoberto', google_place_id: null }), // sem place_id
  ]

  it('mostra só os descoberto desta busca (nem todos do banco, nem os já processados)', () => {
    const r = leadsDaBusca(leads, ['P1', 'P2', 'P3'])
    expect(r.map((l) => l.id)).toEqual(['a', 'b']) // c (outra busca), d (qualificado), e (sem id) ficam de fora
  })

  it('busca sem resultados → lista vazia', () => {
    expect(leadsDaBusca(leads, [])).toEqual([])
  })

  it('aceita Set ou array de place_ids', () => {
    expect(leadsDaBusca(leads, new Set(['P1'])).map((l) => l.id)).toEqual(['a'])
  })

  it('não mostra novamente leads que já tiveram disparo/outreach acionado', () => {
    const r = leadsDaBusca(
      [
        lead({ id: 'novo', status: 'descoberto', google_place_id: 'P1', whatsapp_sent_at: null, whatsapp_send_status: null }),
        lead({ id: 'workflow', status: 'descoberto', google_place_id: 'P2', whatsapp_sent_at: '2026-06-15T12:00:00Z' }),
        lead({ id: 'enviado', status: 'descoberto', google_place_id: 'P3', whatsapp_send_status: 'sent' }),
        lead({ id: 'respondido', status: 'descoberto', google_place_id: 'P4', whatsapp_send_status: 'replied' }),
      ],
      ['P1', 'P2', 'P3', 'P4'],
    )

    expect(r.map((l) => l.id)).toEqual(['novo'])
  })

  it('não mistura Squad Leads de aprendizado no lote de prospecção', () => {
    const r = leadsDaBusca(
      [
        lead({ id: 'google', origem: 'google_places', status: 'descoberto', google_place_id: 'P1' }),
        lead({ id: 'manual', origem: 'manual_olivia', status: 'descoberto', google_place_id: 'P2' }),
        lead({ id: 'squad', origem: 'squad_leads_form', status: 'descoberto', google_place_id: 'P3' }),
      ],
      ['P1', 'P2', 'P3'],
    )

    expect(r.map((l) => l.id)).toEqual(['google', 'manual'])
  })

  it('colapsa duplicatas do mesmo Google Place ID na seleção da Olivia', () => {
    const r = leadsDaBusca(
      [
        lead({ id: 'primeiro', status: 'descoberto', google_place_id: 'P1' }),
        lead({ id: 'duplicado', status: 'descoberto', google_place_id: 'P1' }),
        lead({ id: 'outro', status: 'descoberto', google_place_id: 'P2' }),
      ],
      ['P1', 'P1', 'P2'],
    )

    expect(r.map((l) => l.id)).toEqual(['primeiro', 'outro'])
  })
})

describe('leadDisponivelParaProspeccao / jaTeveDisparo', () => {
  it('define disparo pelo marcador canônico whatsapp_sent_at ou por evidência positiva de envio', () => {
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: '2026-06-15T12:00:00Z', whatsapp_send_status: null }))).toBe(true)
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: null, whatsapp_send_status: 'delivered' }))).toBe(true)
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: null, whatsapp_send_status: 'read' }))).toBe(true)
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: null, whatsapp_send_status: 'failed' }))).toBe(false)
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: null, whatsapp_send_status: 'invalid' }))).toBe(false)
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: '2026-06-15T12:00:00Z', whatsapp_send_status: 'failed' }))).toBe(false)
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: '2026-06-15T12:00:00Z', whatsapp_send_status: 'invalid' }))).toBe(false)
    expect(jaTeveDisparo(lead({ whatsapp_sent_at: null, whatsapp_send_status: null }))).toBe(false)
  })

  it('mantém leads descobertos sem disparo elegíveis para busca/prospecção', () => {
    expect(leadDisponivelParaProspeccao(lead({ status: 'descoberto', whatsapp_sent_at: null }))).toBe(true)
    expect(leadDisponivelParaProspeccao(lead({ status: 'qualificado', whatsapp_sent_at: null }))).toBe(false)
    expect(leadDisponivelParaProspeccao(lead({ status: 'descoberto', whatsapp_sent_at: '2026-06-15T12:00:00Z' }))).toBe(false)
    expect(
      leadDisponivelParaProspeccao(
        lead({ origem: 'squad_leads_form', status: 'descoberto', whatsapp_sent_at: null }),
      ),
    ).toBe(false)
  })
})

describe('leadsInboundParaAprendizado', () => {
  it('usa Squad Leads como base de aprendizado, não como lote disponível para Olivia', () => {
    const leads = [
      lead({
        id: 'inbound-fresco',
        origem: 'squad_leads_form',
        google_place_id: null,
        status: 'descoberto',
        inbound_created_at: '2026-06-12T12:00:00Z',
      }),
      lead({ id: 'google', origem: 'google_places', google_place_id: 'P1', status: 'descoberto' }),
      lead({
        id: 'inbound-processado',
        origem: 'squad_leads_form',
        google_place_id: null,
        status: 'qualificado',
        inbound_created_at: '2026-06-11T12:00:00Z',
      }),
    ]

    expect(leadsInboundParaAprendizado(leads).map((l) => l.id)).toEqual([
      'inbound-fresco',
      'inbound-processado',
    ])
  })
})

describe('selecionadosVisiveis', () => {
  const visiveis = [lead({ id: 'a' }), lead({ id: 'b' })]

  it('conta só os selecionados que estão na lista visível (nem mais, nem menos)', () => {
    // 'z' foi selecionado numa busca anterior e não está visível → não conta
    const sel = new Set(['a', 'z'])
    const r = selecionadosVisiveis(visiveis, sel)
    expect(r.map((l) => l.id)).toEqual(['a'])
    expect(r.length).toBe(1) // o botão "Processar N" mostraria 1, e processa 1
  })

  it('nada selecionado → vazio', () => {
    expect(selecionadosVisiveis(visiveis, new Set())).toEqual([])
  })
})

describe('temWhatsapp (gate de seleção)', () => {
  it('número achado (found) passa', () => {
    expect(temWhatsapp(lead({ whatsapp_status: 'found', whatsapp_phone: '+5511999990000' }))).toBe(true)
  })
  it('nº manual da dona(o) passa mesmo sem número da loja', () => {
    expect(temWhatsapp(lead({ whatsapp_status: 'missing', whatsapp_phone: null, whatsapp_dono: '+5511988887777' }))).toBe(true)
  })
  it('sem número confirmado NÃO passa (anti-invenção)', () => {
    expect(temWhatsapp(lead({ whatsapp_status: 'missing', whatsapp_phone: null }))).toBe(false)
    expect(temWhatsapp(lead({ whatsapp_status: null, whatsapp_phone: null }))).toBe(false)
    // status found mas sem número (estado inconsistente) também não passa
    expect(temWhatsapp(lead({ whatsapp_status: 'found', whatsapp_phone: null }))).toBe(false)
    // whatsapp_dono só com espaços não destrava
    expect(temWhatsapp(lead({ whatsapp_status: 'missing', whatsapp_phone: null, whatsapp_dono: '   ' }))).toBe(false)
  })
})

describe('aguardandoWhatsapp', () => {
  it('sem verificação ainda (status null/pending) → aguardando', () => {
    expect(aguardandoWhatsapp(lead({ whatsapp_status: null, whatsapp_phone: null }))).toBe(true)
    expect(aguardandoWhatsapp(lead({ whatsapp_status: 'pending', whatsapp_phone: null }))).toBe(true)
  })
  it('verificado (found/missing/invalid) → não aguarda', () => {
    expect(aguardandoWhatsapp(lead({ whatsapp_status: 'found', whatsapp_phone: '+5511999990000' }))).toBe(false)
    expect(aguardandoWhatsapp(lead({ whatsapp_status: 'missing', whatsapp_phone: null }))).toBe(false)
    expect(aguardandoWhatsapp(lead({ whatsapp_status: 'invalid', whatsapp_phone: null }))).toBe(false)
  })
  it('nº manual presente → não aguarda (já é mensageável)', () => {
    expect(aguardandoWhatsapp(lead({ whatsapp_status: null, whatsapp_dono: '+5511988887777' }))).toBe(false)
  })
})

describe('filtrarLeads (filtros da seleção)', () => {
  const base = [
    lead({ id: 'a', origem: 'google_places', instagram_handle: 'a_doces', instagram_followers: 5000, rating: 4.8, reviews_count: 120 }),
    lead({ id: 'b', origem: 'squad_leads_form', inbound_classification: 'quente', instagram_handle: null, instagram_followers: null, rating: 4.2, reviews_count: 30 }),
    lead({ id: 'c', origem: 'squad_leads_form', inbound_classification: 'nutrir', instagram_handle: 'c_bolos', instagram_followers: 800, rating: null, reviews_count: null }),
  ]

  it('sem filtros → todos passam', () => {
    expect(filtrarLeads(base, FILTROS_VAZIOS).map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('seguidores mínimos: dado ausente NÃO passa (anti-invenção)', () => {
    const r = filtrarLeads(base, { ...FILTROS_VAZIOS, minSeguidores: 1000 })
    expect(r.map((l) => l.id)).toEqual(['a']) // b sem contagem, c com 800
  })

  it('nota mínima e avaliações mínimas', () => {
    expect(filtrarLeads(base, { ...FILTROS_VAZIOS, minRating: 4.5 }).map((l) => l.id)).toEqual(['a'])
    expect(filtrarLeads(base, { ...FILTROS_VAZIOS, minReviews: 50 }).map((l) => l.id)).toEqual(['a'])
  })

  it('só com Instagram', () => {
    expect(filtrarLeads(base, { ...FILTROS_VAZIOS, comInstagram: true }).map((l) => l.id)).toEqual(['a', 'c'])
  })

  it('filtros combinam (E lógico)', () => {
    const r = filtrarLeads(base, { ...FILTROS_VAZIOS, comInstagram: true, minSeguidores: 100, minRating: 4 })
    expect(r.map((l) => l.id)).toEqual(['a'])
  })

  it('filtra por origem e prioriza inbound quente', () => {
    expect(filtrarLeads(base, { ...FILTROS_VAZIOS, origem: 'squad_leads_form' }).map((l) => l.id)).toEqual(['b', 'c'])
    expect(
      filtrarLeads(
        base,
        { ...FILTROS_VAZIOS, origem: 'squad_leads_form', inboundClassifications: ['quente'] },
      ).map((l) => l.id),
    ).toEqual(['b'])
  })
})
