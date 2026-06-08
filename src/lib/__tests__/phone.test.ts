import { describe, it, expect } from 'vitest'
import {
  normalizeBrazilPhone,
  whatsappFromUrl,
  findWhatsappInText,
} from '../../../supabase/functions/_shared/phone'

// Princípio anti-invenção: nunca fabricar dígitos (ex.: não inventar o 9º dígito
// de um celular). Dado ambíguo/implausível → null.

describe('normalizeBrazilPhone', () => {
  it('normaliza celular com máscara para E.164', () => {
    expect(normalizeBrazilPhone('(11) 99999-8888')).toEqual({
      e164: '+5511999998888',
      kind: 'mobile',
    })
  })

  it('aceita prefixo +55 e espaços', () => {
    expect(normalizeBrazilPhone('+55 11 99999-8888')).toEqual({
      e164: '+5511999998888',
      kind: 'mobile',
    })
  })

  it('aceita 11 dígitos crus (DDD + 9 dígitos)', () => {
    expect(normalizeBrazilPhone('11999998888')).toEqual({
      e164: '+5511999998888',
      kind: 'mobile',
    })
  })

  it('aceita 13 dígitos com código do país', () => {
    expect(normalizeBrazilPhone('5511999998888')).toEqual({
      e164: '+5511999998888',
      kind: 'mobile',
    })
  })

  it('classifica fixo (8 dígitos começando 2-5) como landline', () => {
    expect(normalizeBrazilPhone('(11) 3333-4444')).toEqual({
      e164: '+551133334444',
      kind: 'landline',
    })
    expect(normalizeBrazilPhone('1133334444')).toEqual({
      e164: '+551133334444',
      kind: 'landline',
    })
    expect(normalizeBrazilPhone('+55 (21) 2555-0000')).toEqual({
      e164: '+552125550000',
      kind: 'landline',
    })
  })

  it('rejeita vazio / nulo / não numérico', () => {
    expect(normalizeBrazilPhone('')).toBeNull()
    expect(normalizeBrazilPhone(null)).toBeNull()
    expect(normalizeBrazilPhone(undefined)).toBeNull()
    expect(normalizeBrazilPhone('liga pra gente')).toBeNull()
  })

  it('rejeita comprimento implausível', () => {
    expect(normalizeBrazilPhone('12345')).toBeNull()
    expect(normalizeBrazilPhone('551199999888812345')).toBeNull()
  })

  it('NÃO inventa o 9º dígito de um celular legado de 8 dígitos (anti-invenção)', () => {
    // subscriber "99998888" (8 dígitos começando 9) é ambíguo → null, sem fabricar.
    expect(normalizeBrazilPhone('1199998888')).toBeNull()
  })

  it('rejeita DDD inválido (< 11)', () => {
    expect(normalizeBrazilPhone('1099999888')).toBeNull()
  })
})

describe('whatsappFromUrl', () => {
  it('extrai número de wa.me', () => {
    expect(whatsappFromUrl('https://wa.me/5511999998888')).toBe('+5511999998888')
  })

  it('extrai de api.whatsapp.com/send?phone=', () => {
    expect(
      whatsappFromUrl('https://api.whatsapp.com/send?phone=5511999998888&text=oi'),
    ).toBe('+5511999998888')
  })

  it('extrai de whatsapp://send?phone= com máscara', () => {
    expect(whatsappFromUrl('whatsapp://send?phone=+55 11 99999-8888')).toBe(
      '+5511999998888',
    )
  })

  it('assume DDI 55 quando faltam só DDD+celular (11 dígitos)', () => {
    expect(whatsappFromUrl('https://wa.me/11999998888')).toBe('+5511999998888')
  })

  it('devolve null para links não-whatsapp ou vazios', () => {
    expect(whatsappFromUrl('https://instagram.com/foo')).toBeNull()
    expect(whatsappFromUrl('https://wa.me/')).toBeNull()
    expect(whatsappFromUrl(null)).toBeNull()
  })
})

describe('findWhatsappInText', () => {
  it('acha um link wa.me no meio do texto', () => {
    expect(
      findWhatsappInText('fala comigo no zap https://wa.me/5511988887777 ❤️'),
    ).toBe('+5511988887777')
  })

  it('acha um celular escrito por extenso', () => {
    expect(findWhatsappInText('WhatsApp: (11) 98888-7777')).toBe('+5511988887777')
  })

  it('ignora telefone fixo no texto (não é whatsapp-able)', () => {
    expect(findWhatsappInText('ligue 11 3333-4444')).toBeNull()
  })

  it('devolve null para texto sem número ou vazio', () => {
    expect(findWhatsappInText('sem telefone aqui')).toBeNull()
    expect(findWhatsappInText('')).toBeNull()
    expect(findWhatsappInText(null)).toBeNull()
  })
})
