import { describe, it, expect } from 'vitest'
import { extractContactLinks } from '../../../supabase/functions/_shared/contact_pages'

// Descoberta de páginas de contato (P0-B): wa.me costuma morar em /contato,
// não na home. Só mesma origem (cada fetch ainda passa pelo safeFetchHtml).

describe('extractContactLinks', () => {
  const base = 'https://exemplo.com.br/'

  it('acha link por href (/contato) e resolve relativo', () => {
    const html = `<a href="/contato">Contato</a>`
    expect(extractContactLinks(html, base)).toEqual(['https://exemplo.com.br/contato'])
  })

  it('acha link pelo TEXTO ("Fale conosco") mesmo com href genérico', () => {
    const html = `<a href="/pagina-x">Fale conosco</a>`
    expect(extractContactLinks(html, base)).toEqual(['https://exemplo.com.br/pagina-x'])
  })

  it('aceita variações: fale-conosco, atendimento, whatsapp no href', () => {
    const html = `
      <a href="/fale-conosco">x</a>
      <a href="/atendimento">y</a>
      <a href="/whatsapp">z</a>`
    expect(extractContactLinks(html, base)).toEqual([
      'https://exemplo.com.br/fale-conosco',
      'https://exemplo.com.br/atendimento',
      'https://exemplo.com.br/whatsapp',
    ])
  })

  it('só mesma origem — descarta domínio externo', () => {
    const html = `<a href="https://outrosite.com/contato">Contato</a>`
    expect(extractContactLinks(html, base)).toEqual([])
  })

  it('ignora mailto:, tel:, âncora e javascript:', () => {
    const html = `
      <a href="mailto:oi@exemplo.com.br">contato</a>
      <a href="tel:+5511999998888">contato</a>
      <a href="#contato">contato</a>
      <a href="javascript:void(0)">contato</a>`
    expect(extractContactLinks(html, base)).toEqual([])
  })

  it('dedupe + limite de 3', () => {
    const html = `
      <a href="/contato">a</a><a href="/contato">b</a>
      <a href="/contato-2">c</a><a href="/contato-3">d</a><a href="/contato-4">e</a>`
    const out = extractContactLinks(html, base)
    expect(out).toHaveLength(3)
    expect(new Set(out).size).toBe(3)
  })

  it('não devolve a própria página base', () => {
    const html = `<a href="/">Contato</a><a href="https://exemplo.com.br/">Fale conosco</a>`
    expect(extractContactLinks(html, base)).toEqual([])
  })

  it('HTML sem âncoras → []', () => {
    expect(extractContactLinks('<p>nada aqui</p>', base)).toEqual([])
  })
})
