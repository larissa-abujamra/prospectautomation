import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  verifyChallenge,
  verifyMetaSignature,
  parseWebhookEvents,
  shouldAdvanceSendStatus,
  inboundPhoneCandidates,
  estadoAposResposta,
  type InboundMessage,
  type StatusUpdate,
} from '../../../supabase/functions/_shared/whatsapp_webhook'

// Payloads reais (formato da Cloud API v21, campo "messages").
function metaBody(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value }] }],
  }
}

describe('verifyChallenge (GET do setup)', () => {
  const params = (token: string) =>
    new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': token,
      'hub.challenge': '1158201444',
    })

  it('aceita token correto e devolve o challenge', () => {
    const r = verifyChallenge(params('segredo'), 'segredo')
    expect(r.ok).toBe(true)
    expect(r.challenge).toBe('1158201444')
  })

  it('recusa token errado, ausente ou secret não configurado', () => {
    expect(verifyChallenge(params('errado'), 'segredo').ok).toBe(false)
    expect(verifyChallenge(new URLSearchParams(), 'segredo').ok).toBe(false)
    expect(verifyChallenge(params('segredo'), undefined).ok).toBe(false)
    expect(verifyChallenge(params(''), '').ok).toBe(false)
  })
})

describe('verifyMetaSignature (X-Hub-Signature-256)', () => {
  const secret = 'app-secret-de-teste'
  const body = '{"object":"whatsapp_business_account"}'
  const sign = (s: string, b: string) =>
    'sha256=' + createHmac('sha256', s).update(b).digest('hex')

  it('aceita assinatura válida', async () => {
    expect(await verifyMetaSignature(secret, body, sign(secret, body))).toBe(true)
  })

  it('recusa assinatura de outro secret ou corpo alterado', async () => {
    expect(await verifyMetaSignature(secret, body, sign('outro', body))).toBe(false)
    expect(await verifyMetaSignature(secret, body + ' ', sign(secret, body))).toBe(false)
  })

  it('recusa sem secret, sem header ou header sem prefixo sha256=', async () => {
    expect(await verifyMetaSignature(undefined, body, sign(secret, body))).toBe(false)
    expect(await verifyMetaSignature(secret, body, null)).toBe(false)
    expect(await verifyMetaSignature(secret, body, 'abc123')).toBe(false)
  })
})

describe('parseWebhookEvents', () => {
  it('extrai mensagem de texto (inbound)', () => {
    const events = parseWebhookEvents(
      metaBody({
        messaging_product: 'whatsapp',
        contacts: [{ profile: { name: 'Maria' }, wa_id: '5511963366136' }],
        messages: [
          {
            from: '5511963366136',
            id: 'wamid.IN1',
            timestamp: '1765370000',
            type: 'text',
            text: { body: 'Oi! Pode ser amanhã às 15h?' },
          },
        ],
      }),
    )
    expect(events).toHaveLength(1)
    const m = events[0] as InboundMessage
    expect(m.kind).toBe('message')
    expect(m.wamid).toBe('wamid.IN1')
    expect(m.from).toBe('5511963366136')
    expect(m.corpo).toBe('Oi! Pode ser amanhã às 15h?')
    expect(m.timestamp).toBe(new Date(1765370000 * 1000).toISOString())
  })

  it('extrai resposta de botão e interactive (title)', () => {
    const events = parseWebhookEvents(
      metaBody({
        messages: [
          {
            from: '5511963366136',
            id: 'wamid.BTN',
            timestamp: '1765370001',
            type: 'button',
            button: { text: 'Quero saber mais', payload: 'cta_1' },
          },
          {
            from: '5511963366136',
            id: 'wamid.INT',
            timestamp: '1765370002',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sim' } },
          },
        ],
      }),
    )
    expect((events[0] as InboundMessage).corpo).toBe('Quero saber mais')
    expect((events[1] as InboundMessage).corpo).toBe('Sim')
  })

  it('cartão de contato (type=contacts) → "[Contato compartilhado: ...]" com os telefones', () => {
    const events = parseWebhookEvents(
      metaBody({
        messages: [
          {
            from: '5511963366136',
            id: 'wamid.CONTACT',
            timestamp: '1765370010',
            type: 'contacts',
            contacts: [
              { name: { formatted_name: 'Maria Helena' }, phones: [{ phone: '+55 21 98698-8380', wa_id: '5521986988380' }] },
            ],
          },
        ],
      }),
    )
    expect((events[0] as InboundMessage).corpo).toBe('[Contato compartilhado: 5521986988380]')
  })

  it('mídia sem caption → corpo null (anti-invenção, nada fabricado)', () => {
    const events = parseWebhookEvents(
      metaBody({
        messages: [
          {
            from: '5511963366136',
            id: 'wamid.IMG',
            timestamp: '1765370003',
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg' },
          },
        ],
      }),
    )
    expect((events[0] as InboundMessage).corpo).toBeNull()
    expect((events[0] as InboundMessage).tipo).toBe('image')
  })

  it('extrai statuses (delivered/read) com wamid do envio', () => {
    const events = parseWebhookEvents(
      metaBody({
        statuses: [
          { id: 'wamid.OUT1', status: 'delivered', timestamp: '1765370010', recipient_id: '5511963366136' },
          { id: 'wamid.OUT1', status: 'read', timestamp: '1765370020', recipient_id: '5511963366136' },
        ],
      }),
    )
    expect(events).toHaveLength(2)
    expect((events[0] as StatusUpdate).status).toBe('delivered')
    expect((events[1] as StatusUpdate).status).toBe('read')
  })

  it('é tolerante: payload estranho/incompleto não estoura nem inventa evento', () => {
    expect(parseWebhookEvents(null)).toEqual([])
    expect(parseWebhookEvents({})).toEqual([])
    expect(parseWebhookEvents({ entry: 'nope' })).toEqual([])
    expect(parseWebhookEvents(metaBody({ messages: [{ type: 'text' }] }))).toEqual([])
    // field diferente de "messages" (ex.: account_update) é ignorado
    expect(
      parseWebhookEvents({
        entry: [{ changes: [{ field: 'account_update', value: { messages: [{}] } }] }],
      }),
    ).toEqual([])
  })
})

describe('shouldAdvanceSendStatus (nunca regride)', () => {
  it('progride na ordem sent → delivered → read → replied', () => {
    expect(shouldAdvanceSendStatus('sent', 'delivered')).toBe(true)
    expect(shouldAdvanceSendStatus('delivered', 'read')).toBe(true)
    expect(shouldAdvanceSendStatus('read', 'replied')).toBe(true)
    expect(shouldAdvanceSendStatus(null, 'delivered')).toBe(true)
  })

  it('ignora regressão (webhook fora de ordem)', () => {
    expect(shouldAdvanceSendStatus('read', 'delivered')).toBe(false)
    expect(shouldAdvanceSendStatus('replied', 'read')).toBe(false)
    expect(shouldAdvanceSendStatus('delivered', 'sent')).toBe(false)
    expect(shouldAdvanceSendStatus('delivered', 'delivered')).toBe(false)
  })

  it('failed só vale antes da entrega', () => {
    expect(shouldAdvanceSendStatus('sent', 'failed')).toBe(true)
    expect(shouldAdvanceSendStatus('delivered', 'failed')).toBe(false)
    expect(shouldAdvanceSendStatus('replied', 'failed')).toBe(false)
  })

  it('status desconhecido da Meta é ignorado', () => {
    expect(shouldAdvanceSendStatus('sent', 'warning')).toBe(false)
  })
})

describe('inboundPhoneCandidates (quirk BR do 9º dígito)', () => {
  it('número completo → ele mesmo em E.164', () => {
    expect(inboundPhoneCandidates('5511963366136')).toContain('+5511963366136')
  })

  it('celular sem o 9º dígito → gera variante com 9 (só p/ match)', () => {
    const c = inboundPhoneCandidates('551163366136')
    expect(c).toContain('+551163366136')
    expect(c).toContain('+5511963366136')
  })

  it('com 9º dígito → também gera variante sem 9 (lead gravado no formato antigo)', () => {
    const c = inboundPhoneCandidates('5511963366136')
    expect(c).toContain('+551163366136')
  })

  it('fixo (8 dígitos começando 2–5) não ganha variante de celular', () => {
    const c = inboundPhoneCandidates('551130001000')
    expect(c).toEqual(['+551130001000'])
  })

  it('entrada vazia/suja → sem candidatos', () => {
    expect(inboundPhoneCandidates('')).toEqual([])
    expect(inboundPhoneCandidates('abc')).toEqual([])
  })
})

describe('estadoAposResposta', () => {
  it('promove para conversando do zero ou de aguardando', () => {
    expect(estadoAposResposta(null)).toBe('conversando')
    expect(estadoAposResposta('aguardando')).toBe('conversando')
    expect(estadoAposResposta('conversando')).toBe('conversando')
  })

  it('preserva estados fortes (optout é LGPD; handoff é do humano)', () => {
    expect(estadoAposResposta('optout')).toBeNull()
    expect(estadoAposResposta('handoff')).toBeNull()
    expect(estadoAposResposta('agendado')).toBeNull()
    expect(estadoAposResposta('agendando')).toBeNull()
  })
})
