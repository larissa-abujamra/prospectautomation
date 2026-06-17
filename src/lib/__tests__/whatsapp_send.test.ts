import { describe, it, expect } from 'vitest'
import {
  templateForGenero,
  langForGenero,
  grupoForSetor,
  templateFor,
  langFor,
  sendBlockReason,
  toWhatsappRecipient,
  buildTemplatePayload,
  buildTemplatePayloadForRecipient,
  buildFollowupTemplatePayload,
  buildTextPayload,
  parseSendResult,
  FOLLOWUP_TEMPLATE,
  TEMPLATE_F,
  TEMPLATE_M,
  DEFAULT_TEMPLATES,
  type SendableLead,
} from '../../../supabase/functions/_shared/whatsapp_send'
import { resolveOliviaMessagingProvider } from '../../../supabase/functions/_shared/olivia_channel'

function lead(over: Partial<SendableLead> = {}): SendableLead {
  return {
    nome: 'Pietra Pâtisserie',
    setor: 'Confeitaria',
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

describe('langForGenero', () => {
  it('idioma por gênero, com defaults pt_BR (f) / en (m)', () => {
    expect(langForGenero('f')).toBe('pt_BR')
    expect(langForGenero(null)).toBe('pt_BR')
    expect(langForGenero('m')).toBe('en')
  })
  it('aceita overrides (ex.: se o template _m for recriado em pt_BR)', () => {
    expect(langForGenero('m', 'pt_BR', 'pt_BR')).toBe('pt_BR')
    expect(langForGenero('f', 'pt_BR', 'en_US')).toBe('pt_BR')
  })
})

describe('grupoForSetor (template por perfil)', () => {
  it('confeitaria/cafeteria/doceria → doces (case/acento-insensível)', () => {
    expect(grupoForSetor('Confeitaria')).toBe('doces')
    expect(grupoForSetor('cafeteria')).toBe('doces')
    expect(grupoForSetor('Doceria artesanal')).toBe('doces')
    expect(grupoForSetor('CONFEITARIA')).toBe('doces')
  })
  it('outros setores → generic', () => {
    expect(grupoForSetor('Pizzaria')).toBe('generic')
    expect(grupoForSetor('Academia')).toBe('generic')
    expect(grupoForSetor('Pet shop')).toBe('generic')
    expect(grupoForSetor('Salão de beleza')).toBe('generic')
  })
  it('sem setor → generic (copy genérica é verdadeira pra qualquer negócio)', () => {
    expect(grupoForSetor(null)).toBe('generic')
    expect(grupoForSetor(undefined)).toBe('generic')
    expect(grupoForSetor('  ')).toBe('generic')
  })
})

describe('templateFor (matriz segmento × gênero)', () => {
  it('doces usa os templates já aprovados (intro_f/_m)', () => {
    expect(templateFor('Confeitaria', 'f')).toBe(TEMPLATE_F)
    expect(templateFor('Cafeteria', 'm')).toBe(TEMPLATE_M)
  })
  it('generic usa os templates novos, com default f', () => {
    expect(templateFor('Academia', 'f')).toBe(DEFAULT_TEMPLATES.genericF)
    expect(templateFor('Pizzaria', 'm')).toBe(DEFAULT_TEMPLATES.genericM)
    expect(templateFor('Pet shop', null)).toBe(DEFAULT_TEMPLATES.genericF)
  })
  it('aceita matriz custom (override por env na function)', () => {
    const custom = { ...DEFAULT_TEMPLATES, genericF: 'minha_intro_v2_f' }
    expect(templateFor('Floricultura', 'f', custom)).toBe('minha_intro_v2_f')
    expect(templateFor('Confeitaria', 'f', custom)).toBe(TEMPLATE_F)
  })
})

describe('langFor (idioma por célula da matriz)', () => {
  it('doces mantém o legado: f=pt_BR, m=en', () => {
    expect(langFor('Confeitaria', 'f')).toBe('pt_BR')
    expect(langFor('Confeitaria', 'm')).toBe('en')
  })
  it('generic nasce todo pt_BR', () => {
    expect(langFor('Academia', 'f')).toBe('pt_BR')
    expect(langFor('Academia', 'm')).toBe('pt_BR')
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

  it('setor não-doces → template genérico (por perfil)', () => {
    const p = buildTemplatePayload(lead({ setor: 'Academia' }), 'pt_BR')
    expect(p.template.name).toBe(DEFAULT_TEMPLATES.genericF)
    const m = buildTemplatePayload(lead({ setor: 'Pizzaria', nome_genero: 'm' }), 'pt_BR')
    expect(m.template.name).toBe(DEFAULT_TEMPLATES.genericM)
  })
})

describe('buildTemplatePayloadForRecipient', () => {
  it('reusa o template do lead mas troca o destinatário (handoff do dono)', () => {
    const p = buildTemplatePayloadForRecipient(lead(), '+5511999002121', 'pt_BR')
    expect(p.to).toBe('5511999002121')
    expect(p.template.name).toBe(TEMPLATE_F)
    expect(p.template.components[0].parameters[0].text).toBe('Pietra Pâtisserie')
  })
})

describe('buildFollowupTemplatePayload', () => {
  it('monta o follow-up aprovado sem variáveis', () => {
    const p = buildFollowupTemplatePayload('+5511999002121')
    expect(p).toEqual({
      messaging_product: 'whatsapp',
      to: '5511999002121',
      type: 'template',
      template: {
        name: FOLLOWUP_TEMPLATE,
        language: { code: 'pt_BR' },
        components: [],
      },
    })
  })
})

describe('buildTextPayload', () => {
  it('monta texto livre para janela de 24h', () => {
    expect(buildTextPayload('+55 (11) 99900-2121', 'Oi!')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999002121',
      type: 'text',
      text: { preview_url: false, body: 'Oi!' },
    })
  })
})

describe('resolveOliviaMessagingProvider', () => {
  it('defaulta para HubSpot para rollback compatível', () => {
    expect(resolveOliviaMessagingProvider(undefined, undefined)).toBe('hubspot')
  })

  it('aceita OLIVIA_MESSAGING_PROVIDER=meta e aliases operacionais', () => {
    expect(resolveOliviaMessagingProvider('meta', undefined)).toBe('meta')
    expect(resolveOliviaMessagingProvider(undefined, 'whatsapp')).toBe('meta')
    expect(resolveOliviaMessagingProvider('cloud_api', 'hubspot')).toBe('meta')
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
