import { describe, it, expect } from 'vitest'
import {
  acharSenderActor,
  extractInbound,
  extractOutbound,
  extrairAudioUrl,
  extrairContatosCompartilhados,
  hubspotV3BaseString,
  montarEnvioHubspot,
  parseNewMessageEvents,
  verifyHubspotV3Signature,
} from '../../../supabase/functions/_shared/hubspot_conversations.ts'

// --- Assinatura v3 -------------------------------------------------------------

describe('verifyHubspotV3Signature', () => {
  const SECRET = 'segredo-de-teste'
  const URI = 'https://x.supabase.co/functions/v1/olivia-hubspot-webhook'
  const BODY = '[{"subscriptionType":"conversation.newMessage"}]'

  async function assinar(ts: string): Promise<string> {
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode(hubspotV3BaseString('POST', URI, BODY, ts)),
    )
    return btoa(String.fromCharCode(...new Uint8Array(mac)))
  }

  it('aceita assinatura válida dentro da janela', async () => {
    const ts = String(Date.now())
    const sig = await assinar(ts)
    expect(
      await verifyHubspotV3Signature({
        clientSecret: SECRET,
        method: 'POST',
        uri: URI,
        rawBody: BODY,
        timestampHeader: ts,
        signatureHeader: sig,
      }),
    ).toBe(true)
  })

  it('rejeita assinatura errada, segredo ausente e timestamp velho (replay)', async () => {
    const ts = String(Date.now())
    const sig = await assinar(ts)
    const base = {
      clientSecret: SECRET,
      method: 'POST',
      uri: URI,
      rawBody: BODY,
      timestampHeader: ts,
      signatureHeader: sig,
    }
    expect(await verifyHubspotV3Signature({ ...base, signatureHeader: 'x' + sig })).toBe(false)
    expect(await verifyHubspotV3Signature({ ...base, clientSecret: null })).toBe(false)
    const velho = String(Date.now() - 10 * 60 * 1000)
    expect(
      await verifyHubspotV3Signature({
        ...base,
        timestampHeader: velho,
        signatureHeader: await assinar(velho),
      }),
    ).toBe(false)
    // corpo adulterado após assinar → inválida
    expect(await verifyHubspotV3Signature({ ...base, rawBody: BODY + 'x' })).toBe(false)
  })
})

// --- Parse dos eventos ----------------------------------------------------------

describe('parseNewMessageEvents', () => {
  it('filtra só conversation.newMessage com ids válidos', () => {
    const out = parseNewMessageEvents([
      { subscriptionType: 'conversation.newMessage', objectId: 123, messageId: 'm1', messageType: 'MESSAGE', occurredAt: 1770000000000 },
      { subscriptionType: 'conversation.creation', objectId: 124 },
      { subscriptionType: 'conversation.newMessage', objectId: 125 }, // sem messageId
      { subscriptionType: 'conversation.newMessage', objectId: 126, messageId: 'm2', messageType: 'COMMENT' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ threadId: '123', messageId: 'm1', messageType: 'MESSAGE' })
    expect(out[1].messageType).toBe('COMMENT')
  })

  it('payload não-array ou podre → vazio, sem throw', () => {
    expect(parseNewMessageEvents(null)).toEqual([])
    expect(parseNewMessageEvents({})).toEqual([])
    expect(parseNewMessageEvents([null, 42, 'x'])).toEqual([])
  })
})

// --- Normalização da mensagem ----------------------------------------------------

const MSG_INCOMING = {
  type: 'MESSAGE',
  direction: 'INCOMING',
  text: 'Oi, pode ser amanhã às 14h',
  channelId: '1009',
  channelAccountId: '555',
  createdAt: '2026-06-11T18:00:00Z',
  senders: [
    { actorId: 'V-77', deliveryIdentifier: { type: 'HS_PHONE_NUMBER', value: '+5519984321221' } },
  ],
}

describe('extractInbound', () => {
  it('normaliza mensagem INCOMING com telefone', () => {
    const got = extractInbound(MSG_INCOMING)
    expect(got).toMatchObject({
      texto: 'Oi, pode ser amanhã às 14h',
      phone: '+5519984321221',
      channelId: '1009',
      channelAccountId: '555',
      senderActorId: 'V-77',
    })
  })

  it('anti-eco: OUTGOING, COMMENT e sistema → null', () => {
    expect(extractInbound({ ...MSG_INCOMING, direction: 'OUTGOING' })).toBeNull()
    expect(extractInbound({ ...MSG_INCOMING, type: 'COMMENT' })).toBeNull()
    expect(extractInbound(null)).toBeNull()
  })

  it('mensagem sem texto (mídia) → texto null, resto preservado', () => {
    const got = extractInbound({ ...MSG_INCOMING, text: '   ' })
    expect(got?.texto).toBeNull()
    expect(got?.phone).toBe('+5519984321221')
  })

  it('cartão de contato (vCard) sem texto → surface o número no texto', () => {
    // WhatsApp "contato compartilhado": o número vem no anexo (vCard), não em
    // m.text. Antes, texto ficava null e a Olivia pedia o número de novo.
    const got = extractInbound({
      ...MSG_INCOMING,
      text: null,
      attachments: [
        {
          type: 'VCARD',
          content: 'BEGIN:VCARD\nFN:Doce de Laura\nTEL;type=CELL:+55 11 96845 6545\nEND:VCARD',
        },
      ],
    })
    expect(got?.texto).toContain('+55 11 96845 6545')
    expect(got?.texto?.toLowerCase()).toContain('contato compartilhado')
  })

  it('vCard + texto → mantém o texto e acrescenta o número compartilhado', () => {
    const got = extractInbound({
      ...MSG_INCOMING,
      text: 'esse é o contato deles',
      attachments: [{ type: 'VCARD', content: 'TEL:+5511968456545' }],
    })
    expect(got?.texto).toContain('esse é o contato deles')
    expect(got?.texto).toContain('+5511968456545')
  })
})

describe('extrairAudioUrl', () => {
  it('pega a url do anexo de áudio (FILE + fileUsageType AUDIO) — formato real do HubSpot', () => {
    const msg = {
      type: 'MESSAGE', direction: 'INCOMING', text: '',
      attachments: [{ type: 'FILE', fileId: '214910527295', name: '1711916786799281.m4a', fileUsageType: 'AUDIO', url: 'https://cdn.hubspot.net/audio.m4a?sig=x' }],
    }
    expect(extrairAudioUrl(msg)).toBe('https://cdn.hubspot.net/audio.m4a?sig=x')
  })
  it('detecta áudio também pela extensão do nome', () => {
    expect(extrairAudioUrl({ attachments: [{ type: 'FILE', name: 'voz.ogg', url: 'http://x/voz.ogg' }] }))
      .toBe('http://x/voz.ogg')
  })
  it('imagem/contato/sem-anexo → null (não é áudio)', () => {
    expect(extrairAudioUrl({ attachments: [{ type: 'FILE', fileUsageType: 'IMAGE', name: 'foto.webp', url: 'http://x/f.webp' }] })).toBeNull()
    expect(extrairAudioUrl({ attachments: [{ type: 'CONTACT', contactProfile: { phones: [{ phone: '+55 11 9' }] } }] })).toBeNull()
    expect(extrairAudioUrl({ text: 'oi' })).toBeNull()
    expect(extrairAudioUrl(null)).toBeNull()
  })
})

describe('extrairContatosCompartilhados', () => {
  it('extrai TEL de um anexo vCard', () => {
    const nums = extrairContatosCompartilhados({
      attachments: [{ type: 'VCARD', content: 'BEGIN:VCARD\nTEL:+55 48 98005 386\nEND:VCARD' }],
    })
    expect(nums).toContain('+55 48 98005 386')
  })

  it('ignora anexos que não são contato (mídia/foto) — anti-falso-positivo', () => {
    // Um ID/timestamp longo num anexo de imagem NÃO deve virar "contato".
    expect(
      extrairContatosCompartilhados({
        attachments: [{ type: 'IMAGE', fileId: '1234567890123', url: 'https://x/y.jpg' }],
      }),
    ).toEqual([])
  })

  it('sem anexos → vazio', () => {
    expect(extrairContatosCompartilhados({ text: 'oi' })).toEqual([])
    expect(extrairContatosCompartilhados(null)).toEqual([])
  })
})

// --- Saída do thread (OUTGOING) -----------------------------------------------

describe('extractOutbound', () => {
  const BASE_OUT = {
    type: 'MESSAGE',
    direction: 'OUTGOING',
    text: 'Pode falar comigo, sou o dono',
    channelAccountId: '555',
    createdAt: '2026-06-17T20:10:00Z',
  }

  it('humano no inbox (agente A-...) → isAgente true', () => {
    const got = extractOutbound({ ...BASE_OUT, senders: [{ actorId: 'A-42' }] })
    expect(got).toMatchObject({ texto: 'Pode falar comigo, sou o dono', actorId: 'A-42', isAgente: true })
  })

  it('disparo de workflow/integração (I-...) → isAgente false', () => {
    const got = extractOutbound({ ...BASE_OUT, senders: [{ actorId: 'I-9' }] })
    expect(got?.isAgente).toBe(false)
  })

  it('INCOMING ou não-MESSAGE → null', () => {
    expect(extractOutbound({ ...BASE_OUT, direction: 'INCOMING' })).toBeNull()
    expect(extractOutbound({ ...BASE_OUT, type: 'COMMENT' })).toBeNull()
    expect(extractOutbound(null)).toBeNull()
  })
})

// --- Corpo do envio ---------------------------------------------------------------

describe('montarEnvioHubspot', () => {
  const inbound = extractInbound(MSG_INCOMING)!

  it('copia canal/conta/destinatário do inbound (anti-invenção)', () => {
    const corpo = montarEnvioHubspot({ inbound, senderActorId: 'A-101', texto: 'Fechado!' })
    expect(corpo).toMatchObject({
      type: 'MESSAGE',
      text: 'Fechado!',
      senderActorId: 'A-101',
      channelId: '1009',
      channelAccountId: '555',
    })
    const recipients = (corpo as { recipients: Array<Record<string, unknown>> }).recipients
    expect(recipients[0]).toMatchObject({ actorId: 'V-77' })
    expect(recipients[0].deliveryIdentifiers).toEqual([
      { type: 'HS_PHONE_NUMBER', value: '+5519984321221' },
    ])
  })

  it('sem canal/sender/texto → null (não chuta)', () => {
    expect(
      montarEnvioHubspot({ inbound: { ...inbound, channelId: null }, senderActorId: 'A-1', texto: 'x' }),
    ).toBeNull()
    expect(montarEnvioHubspot({ inbound, senderActorId: '', texto: 'x' })).toBeNull()
    expect(montarEnvioHubspot({ inbound, senderActorId: 'A-1', texto: '   ' })).toBeNull()
  })
})

// --- Escolha do sender actor --------------------------------------------------------

describe('acharSenderActor', () => {
  it('pega o agente (A-...) da OUTGOING mais recente', () => {
    const msgs = [
      { type: 'MESSAGE', direction: 'OUTGOING', senders: [{ actorId: 'A-1' }] },
      { type: 'MESSAGE', direction: 'INCOMING', senders: [{ actorId: 'V-9' }] },
      { type: 'MESSAGE', direction: 'OUTGOING', senders: [{ actorId: 'A-2' }] },
    ]
    expect(acharSenderActor(msgs)).toBe('A-2')
  })

  it('ignora bots/integrações (I-...) e devolve null sem agente', () => {
    expect(
      acharSenderActor([{ type: 'MESSAGE', direction: 'OUTGOING', senders: [{ actorId: 'I-3' }] }]),
    ).toBeNull()
    expect(acharSenderActor([])).toBeNull()
  })
})
