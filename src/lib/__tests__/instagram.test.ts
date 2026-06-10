import { describe, it, expect } from 'vitest'
import {
  instagramHandleFromUrl,
  handleFromHtml,
  handleCasaNome,
} from '../../../supabase/functions/_shared/instagram.ts'

describe('handleFromHtml', () => {
  it('acha o @ num link do rodapé/header do site', () => {
    const html = `<footer><a href="https://www.instagram.com/padocadogael/">Instagram</a></footer>`
    expect(handleFromHtml(html)).toBe('padocadogael')
  })

  it('ignora links reservados (/p, /reel) e pega o perfil', () => {
    const html = `
      <a href="https://instagram.com/p/Cabc123/">post</a>
      <a href="https://instagram.com/selvvva">perfil</a>`
    expect(handleFromHtml(html)).toBe('selvvva')
  })

  it('sem link de instagram → null (anti-invenção)', () => {
    expect(handleFromHtml('<a href="https://facebook.com/x">fb</a>')).toBeNull()
    expect(handleFromHtml(null)).toBeNull()
  })
})

describe('handleCasaNome', () => {
  it('handle igual/contido no nome → alto', () => {
    expect(handleCasaNome('padocadogael', 'Padoca do Gael')).toBeGreaterThanOrEqual(0.8)
    expect(handleCasaNome('lellistrattoria', 'Lellis Trattoria')).toBeGreaterThanOrEqual(0.8)
  })
  it('handle de concorrente/sem relação → baixo', () => {
    expect(handleCasaNome('comidadebairro_sp', 'Padoca do Gael')).toBeLessThan(0.5)
  })
  it('casa por token parcial', () => {
    expect(handleCasaNome('selvvvadecor', 'Selvvva')).toBeGreaterThanOrEqual(0.8)
  })
})

describe('instagramHandleFromUrl', () => {
  it('extrai handle de URL de perfil', () => {
    expect(instagramHandleFromUrl('https://instagram.com/criminalburguer')).toBe('criminalburguer')
  })
  it('rejeita caminho reservado', () => {
    expect(instagramHandleFromUrl('https://instagram.com/reel/abc')).toBeNull()
    expect(instagramHandleFromUrl('https://instagram.com/sharer')).toBeNull()
  })
})
