import { describe, it, expect } from 'vitest'
import {
  normalizeBrazilPhone,
  whatsappFromUrl,
  findWhatsappInText,
  findWhatsappInHtml,
  findWhatsappNearKeyword,
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

describe('findWhatsappInHtml', () => {
  // REGRESSÃO (bug real em produção): floats de JavaScript no HTML de sites
  // casavam com o regex solto de telefone e viravam "celulares" fabricados.
  // Valores reais raspados: margherita.com.br → 47.925619188 (virou
  // +5547925619188); cristalpizza.com.br → 71.920188817 (virou +5571920188817).
  // O HTML de site NUNCA pode passar pela varredura de texto cru — só links.
  it('NÃO fabrica número a partir de float de JS (caso Margherita, DDD 47)', () => {
    const html = `<script>gsap.to(el,{duration:47.925619188,ease:"power2"});
      var lat=-23.561414, lng=-46.655881;</script><p>Alameda Tietê, 255</p>`
    expect(findWhatsappInHtml(html)).toBeNull()
  })

  it('NÃO fabrica número a partir de float de JS (caso Cristal Pizza, DDD 71)', () => {
    const html = `<script>{"offsetTime":71.920188817,"node":12}</script>`
    expect(findWhatsappInHtml(html)).toBeNull()
  })

  it('NÃO fabrica número a partir de UUID em URL de fonte (caso Make a Cake, DDD 88)', () => {
    // makeacake.com.br (Wix): o UUID do arquivo de fonte contém "8b88-9288338191"
    // e o regex solto casava "88-92883" + "3819" → +5588928833819 (Ceará!).
    const html = `<style>@font-face { src:
      url('//static.parastorage.com/fonts/v2/c24fcada-6239-48bc-8b88-9288338191c9/v1/proxima-n-w05-reg.woff2')
      format('woff2'); }</style>`
    expect(findWhatsappInHtml(html)).toBeNull()
  })

  it('NÃO pega celular escrito em texto visível — site é só links (contrato)', () => {
    // No texto cru de um site não dá pra distinguir telefone de qualquer outro
    // número; só fontes explícitas (links) contam. A varredura de texto fica
    // restrita a bios do Instagram (findWhatsappInText).
    expect(findWhatsappInHtml('<p>WhatsApp: (11) 98888-7777</p>')).toBeNull()
  })

  it('extrai de link wa.me em âncora', () => {
    expect(
      findWhatsappInHtml('<a href="https://wa.me/5511988887777?text=oi">Peça já</a>'),
    ).toBe('+5511988887777')
  })

  it('extrai de api.whatsapp.com/send?phone=', () => {
    expect(
      findWhatsappInHtml('<a href="https://api.whatsapp.com/send?phone=5511988887777&text=oi">zap</a>'),
    ).toBe('+5511988887777')
  })

  it('extrai de link whatsapp://send', () => {
    expect(
      findWhatsappInHtml('<a href="whatsapp://send?phone=5511988887777">abrir</a>'),
    ).toBe('+5511988887777')
  })

  it('extrai celular de href="tel:..." (declaração explícita do site)', () => {
    expect(
      findWhatsappInHtml('<a href="tel:+5511988887777">Ligue</a>'),
    ).toBe('+5511988887777')
  })

  it('ignora href="tel:..." de fixo (não é whatsapp-able)', () => {
    expect(findWhatsappInHtml('<a href="tel:+551133334444">Ligue</a>')).toBeNull()
  })

  it('pula link wa.me não-numérico (qr/slug) e acha o link real seguinte', () => {
    const html = `<a href="https://wa.me/qr/ABCDEF123">QR</a>
      <a href="https://wa.me/5511988887777">zap</a>`
    expect(findWhatsappInHtml(html)).toBe('+5511988887777')
  })

  it('link de WhatsApp tem prioridade sobre tel:', () => {
    const html = `<a href="tel:+5511977776666">Ligue</a>
      <a href="https://wa.me/5511988887777">zap</a>`
    expect(findWhatsappInHtml(html)).toBe('+5511988887777')
  })

  it('devolve null para HTML sem links ou vazio', () => {
    expect(findWhatsappInHtml('<div>sem contato</div>')).toBeNull()
    expect(findWhatsappInHtml('')).toBeNull()
    expect(findWhatsappInHtml(null)).toBeNull()
  })
})

describe('findWhatsappNearKeyword', () => {
  // Recall calibrado (P0-B): recupera números listados como TEXTO no site —
  // mas só no texto VISÍVEL (scripts/styles fora) e a poucos caracteres de uma
  // palavra-chave de WhatsApp. Nunca reabre o buraco dos floats (ISSUE-001).
  it('acha o celular colado na palavra "Whatsapp" (caso real Empório dos Bichos)', () => {
    const html = `<div>Horário Segunda - Sábado 8h - 18h Contato
      Whatsapp(11) 96595-0143 Telefone (11) 3507-7434</div>`
    expect(findWhatsappNearKeyword(html)).toBe('+5511965950143')
  })

  it('aceita variações wpp / zap', () => {
    expect(findWhatsappNearKeyword('<p>wpp: (11) 98888-7777</p>')).toBe('+5511988887777')
    expect(findWhatsappNearKeyword('<p>chama no zap 11 98888-7777</p>')).toBe('+5511988887777')
  })

  it('ignora fixo mesmo perto da palavra-chave', () => {
    expect(findWhatsappNearKeyword('<p>WhatsApp: (11) 3333-4444</p>')).toBeNull()
  })

  it('número longe da palavra-chave NÃO conta', () => {
    const filler = 'x'.repeat(200)
    expect(
      findWhatsappNearKeyword(`<p>Temos WhatsApp! ${filler} (11) 98888-7777</p>`),
    ).toBeNull()
  })

  it('número sem palavra-chave alguma → null', () => {
    expect(findWhatsappNearKeyword('<p>Ligue (11) 98888-7777</p>')).toBeNull()
  })

  it('REGRESSÃO: float de JS perto de "whatsapp" dentro de <script> não conta', () => {
    const html = `<script>var whatsappDelay = 47.925619188; initWhatsapp();</script>`
    expect(findWhatsappNearKeyword(html)).toBeNull()
  })

  it('REGRESSÃO: UUID em <style>/url de fonte não conta', () => {
    const html = `<style>/* whatsapp icon */ @font-face { src:
      url('//x.com/fonts/c24fcada-6239-48bc-8b88-9288338191c9/v1/a.woff2'); }</style>`
    expect(findWhatsappNearKeyword(html)).toBeNull()
  })

  it('não casa número embutido em sequência maior de dígitos', () => {
    expect(
      findWhatsappNearKeyword('<p>whatsapp pedido 00119888877771234</p>'),
    ).toBeNull()
  })

  it('vazio/null → null', () => {
    expect(findWhatsappNearKeyword('')).toBeNull()
    expect(findWhatsappNearKeyword(null)).toBeNull()
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
