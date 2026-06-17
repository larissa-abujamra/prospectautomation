import { describe, it, expect } from 'vitest'
import {
  elegivelParaFollowup,
  filtrarElegiveis,
  FOLLOWUP_JANELA_MS,
  FOLLOWUP_MAX_POR_RUN,
  HUBSPOT_OUTREACH_FOLLOWUP,
  type FollowupLead,
} from '../../../supabase/functions/_shared/olivia_followup'

// Agora fixo pra janela ser determinística nos testes.
const AGORA = Date.parse('2026-06-12T15:00:00Z')
const HORA = 3_600_000

const lead = (over: Partial<FollowupLead> = {}): FollowupLead => ({
  id: 'lead-1',
  hubspot_contact_id: '12345',
  whatsapp_phone: '+5511999002121',
  whatsapp_sent_at: new Date(AGORA - 49 * HORA).toISOString(), // 49h atrás → elegível
  whatsapp_send_status: null, // fluxo HubSpot: nulo até webhook reportar
  olivia_estado: null,
  followup_enviado_em: null,
  ...over,
})

describe('elegivelParaFollowup (janela de 48h)', () => {
  it('elegível: intro acionada há 49h, nunca respondeu, sem follow-up', () => {
    expect(elegivelParaFollowup(lead(), AGORA)).toEqual({ elegivel: true, motivo: null })
  })

  it('elegível exatamente em 48h (limite fechado)', () => {
    const l = lead({ whatsapp_sent_at: new Date(AGORA - FOLLOWUP_JANELA_MS).toISOString() })
    expect(elegivelParaFollowup(l, AGORA).elegivel).toBe(true)
  })

  it('inelegível: janela ainda aberta (47h59m)', () => {
    const l = lead({ whatsapp_sent_at: new Date(AGORA - FOLLOWUP_JANELA_MS + 60_000).toISOString() })
    const r = elegivelParaFollowup(l, AGORA)
    expect(r.elegivel).toBe(false)
    expect(r.motivo).toMatch(/janela/)
  })

  it('inelegível: intro nunca acionada (whatsapp_sent_at nulo)', () => {
    const r = elegivelParaFollowup(lead({ whatsapp_sent_at: null }), AGORA)
    expect(r.elegivel).toBe(false)
    expect(r.motivo).toMatch(/nunca acionada/)
  })

  it('inelegível: whatsapp_sent_at inválido (não inventa janela)', () => {
    const r = elegivelParaFollowup(lead({ whatsapp_sent_at: 'não-é-data' }), AGORA)
    expect(r.elegivel).toBe(false)
    expect(r.motivo).toMatch(/inválido/)
  })

  it('inelegível: sem contato no HubSpot', () => {
    const r = elegivelParaFollowup(lead({ hubspot_contact_id: null }), AGORA)
    expect(r.elegivel).toBe(false)
    expect(r.motivo).toMatch(/hubspot_contact_id/)
  })

  it('em modo Meta não exige contato HubSpot, mas exige número WhatsApp', () => {
    expect(elegivelParaFollowup(lead({ hubspot_contact_id: null }), AGORA, 'meta').elegivel).toBe(true)
    const semNumero = elegivelParaFollowup(lead({ hubspot_contact_id: null, whatsapp_phone: null }), AGORA, 'meta')
    expect(semNumero.elegivel).toBe(false)
    expect(semNumero.motivo).toMatch(/whatsapp_phone/)
  })
})

describe('elegivelParaFollowup (nunca respondeu)', () => {
  it('status sem resposta passam: null, sent, delivered, read', () => {
    for (const s of [null, 'sent', 'delivered', 'read']) {
      expect(elegivelParaFollowup(lead({ whatsapp_send_status: s }), AGORA).elegivel).toBe(true)
    }
  })

  it('replied/failed/invalid nunca recebem follow-up', () => {
    for (const s of ['replied', 'failed', 'invalid']) {
      const r = elegivelParaFollowup(lead({ whatsapp_send_status: s }), AGORA)
      expect(r.elegivel).toBe(false)
      expect(r.motivo).toContain(s)
    }
  })

  it('estados da Olivia: só null/aguardando passam', () => {
    expect(elegivelParaFollowup(lead({ olivia_estado: 'aguardando' }), AGORA).elegivel).toBe(true)
    for (const e of ['conversando', 'agendando', 'agendado', 'handoff', 'optout']) {
      const r = elegivelParaFollowup(lead({ olivia_estado: e }), AGORA)
      expect(r.elegivel).toBe(false)
      expect(r.motivo).toContain(e)
    }
  })
})

describe('elegivelParaFollowup (one-shot)', () => {
  it('quem já recebeu follow-up NUNCA recebe outro', () => {
    const r = elegivelParaFollowup(
      lead({ followup_enviado_em: '2026-06-10T12:00:00Z' }),
      AGORA,
    )
    expect(r.elegivel).toBe(false)
    expect(r.motivo).toMatch(/one-shot/)
  })
})

describe('filtrarElegiveis (teto por execução)', () => {
  it('filtra inelegíveis e respeita o cap', () => {
    const leads: FollowupLead[] = [
      lead({ id: 'a' }),
      lead({ id: 'respondeu', whatsapp_send_status: 'replied' }),
      lead({ id: 'b' }),
      lead({ id: 'optout', olivia_estado: 'optout' }),
      lead({ id: 'c' }),
    ]
    expect(filtrarElegiveis(leads, AGORA).map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(filtrarElegiveis(leads, AGORA, 2).map((l) => l.id)).toEqual(['a', 'b'])
    expect(
      filtrarElegiveis(
        [lead({ id: 'meta-sem-hs', hubspot_contact_id: null })],
        AGORA,
        25,
        'meta',
      ).map((l) => l.id),
    ).toEqual(['meta-sem-hs'])
  })

  it('cap padrão é o teto de segurança da função', () => {
    const muitos = Array.from({ length: 40 }, (_, i) => lead({ id: `l${i}` }))
    expect(filtrarElegiveis(muitos, AGORA)).toHaveLength(FOLLOWUP_MAX_POR_RUN)
  })
})

describe('constantes do contrato HubSpot', () => {
  it('valor da property que inscreve no workflow de follow-up', () => {
    expect(HUBSPOT_OUTREACH_FOLLOWUP).toBe('followup')
  })
})
