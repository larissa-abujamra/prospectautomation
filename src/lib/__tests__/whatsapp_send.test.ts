import { describe, it, expect } from 'vitest'
import {
  templateForGenero,
  sendBlockReason,
  toWhatsappRecipient,
  buildTemplatePayload,
  parseSendResult,
  TEMPLATE_F,
  TEMPLATE_M,
  type SendableLead,
} from '../../../supabase/functions/_shared/whatsapp_send'

function lead(over: Partial<SendableLead> = {}): SendableLead {
  return {
    nome: 'Pietra Pâtisserie',
    cidade: 'São Paulo',
    whatsapp_phone: '+5511963366136',
    whatsapp_status: 'found',
    nome_genero: 'f',
    ...over,
  }
}

describe('templateForGenero', () => {
  it('m → masculino, qualquer outro → feminino (default)', () => {
    expect(templateForGenero('m')).toBe(TEMPLATE_M)
    expect(templateForGenero('f')).toBe(TEMPLATE_F)
    expect(templateForGenero(null)).toBe(TEMPLATE_F)
    expect(templateForGenero(undefined)).toBe(TEMPLATE_F)
    expect(templateForGenero('')).toBe(TEMPLATE_F)
  })
})

describe('sendBlockReason', () => {
  it('passa para lead mensageável', () => {
    expect(sendBlockReason(lead())).toBeNull()
  })
  it('bloqueia sem número, status, nome ou cidade (anti-invenção)', () => {
    expect(sendBlockReason(lead({ whatsapp_status: 'missing' }))).toMatch(/found/)
    expect(sendBlockReason(lead({ whatsapp_phone: null }))).toMatch(/phone/)
    expect(sendBlockReason(lead({ nome: '' }))).toMatch(/nome/)
    expect(sendBlockReason(lead({ cidade: null }))).toMatch(/cidade/)
  })
})

describe('toWhatsappRecipient', () => {
  it('tira tudo que não é dígito', () => {
    expect(toWhatsappRecipient('+5511963366136')).toBe('5511963366136')
    expect(toWhatsappRecipient('+55 (11) 96336-6136')).toBe('5511963366136')
  })
})

describe('buildTemplatePayload', () => {
  it('monta o payload exato da Cloud API (feminino)', () => {
    const p = buildTemplatePayload(lead(), 'pt_BR')
    expect(p).toEqual({
      messaging_product: 'whatsapp',
      to: '5511963366136',
      type: 'template',
      template: {
        name: 'squad_prospeccao_intro_f',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Pietra Pâtisserie' },
              { type: 'text', text: 'São Paulo' },
              { type: 'text', text: 'Pietra Pâtisserie' },
            ],
          },
        ],
      },
    })
  })

  it('usa o template masculino quando genero=m', () => {
    const p = buildTemplatePayload(lead({ nome_genero: 'm', nome: 'Empório dos Bichos' }), 'pt_BR')
    expect(p.template.name).toBe('squad_prospeccao_intro_m')
    expect(p.template.components[0].parameters[0].text).toBe('Empório dos Bichos')
    expect(p.template.components[0].parameters[1].text).toBe('São Paulo')
    expect(p.template.components[0].parameters[2].text).toBe('Empório dos Bichos')
  })

  it('respeita o language code passado', () => {
    expect(buildTemplatePayload(lead(), 'en').template.language.code).toBe('en')
  })
})

describe('parseSendResult', () => {
  it('2xx com message id → sent', () => {
    const r = parseSendResult(200, { messages: [{ id: 'wamid.ABC123' }] })
    expect(r.status).toBe('sent')
    expect(r.messageId).toBe('wamid.ABC123')
  })

  it('número fora do WhatsApp (131026) → invalid', () => {
    const r = parseSendResult(400, { error: { code: 131026, message: 'Message undeliverable' } })
    expect(r.status).toBe('invalid')
    expect(r.errorCode).toBe(131026)
  })

  it('outro erro → failed com código/mensagem', () => {
    const r = parseSendResult(401, { error: { code: 190, message: 'token expirado' } })
    expect(r.status).toBe('failed')
    expect(r.errorCode).toBe(190)
    expect(r.errorMessage).toMatch(/token/)
  })

  it('2xx sem id → failed (defensivo)', () => {
    expect(parseSendResult(200, {}).status).toBe('failed')
  })
})
