import { describe, it, expect } from 'vitest'
import {
  parsePerplexityLeadInfo,
  resolverProvedorSonar,
  validarHandleInstagram,
} from '../../../supabase/functions/_shared/perplexity.ts'

describe('parsePerplexityLeadInfo (anti-invenção na resposta do Sonar)', () => {
  it('aceita JSON limpo com campos válidos', () => {
    const r = parsePerplexityLeadInfo(
      '{"instagram":"pietrapatisserie","whatsapp":"+55 11 96336-6136","website":"https://pietra.com.br"}',
    )
    expect(r).toEqual({
      instagram: 'pietrapatisserie',
      whatsapp: '+5511963366136',
      website: 'https://pietra.com.br/',
    })
  })

  it('aceita JSON dentro de cerca de código e texto em volta', () => {
    const r = parsePerplexityLeadInfo(
      'Aqui está:\n```json\n{"instagram":"@doce_arte","whatsapp":null,"website":null}\n```',
    )
    expect(r.instagram).toBe('doce_arte')
    expect(r.whatsapp).toBeNull()
  })

  it('telefone FIXO não vira WhatsApp (só celular é WhatsApp-able)', () => {
    const r = parsePerplexityLeadInfo('{"instagram":null,"whatsapp":"(11) 3256-7890","website":null}')
    expect(r.whatsapp).toBeNull()
  })

  it('handle inválido / URL reservada do Instagram → null', () => {
    expect(parsePerplexityLeadInfo('{"instagram":"https://instagram.com/p","whatsapp":null,"website":null}').instagram).toBeNull()
    expect(parsePerplexityLeadInfo('{"instagram":"a b c!","whatsapp":null,"website":null}').instagram).toBeNull()
  })

  it('website tem que ser http(s) e não pode ser o próprio Instagram', () => {
    expect(parsePerplexityLeadInfo('{"instagram":null,"whatsapp":null,"website":"ftp://x.com"}').website).toBeNull()
    expect(parsePerplexityLeadInfo('{"instagram":null,"whatsapp":null,"website":"https://instagram.com/loja"}').website).toBeNull()
    expect(parsePerplexityLeadInfo('{"instagram":null,"whatsapp":null,"website":"https://www.loja.com.br/menu"}').website).toBe('https://www.loja.com.br/menu')
  })

  it('resposta sem JSON / JSON podre / vazia → tudo null (nunca lança)', () => {
    const vazio = { instagram: null, whatsapp: null, website: null }
    expect(parsePerplexityLeadInfo('não encontrei nada')).toEqual(vazio)
    expect(parsePerplexityLeadInfo('{ não é json }')).toEqual(vazio)
    expect(parsePerplexityLeadInfo(null)).toEqual(vazio)
    expect(parsePerplexityLeadInfo('')).toEqual(vazio)
  })
})

describe('resolverProvedorSonar (Perplexity direto ou via OpenRouter)', () => {
  it('Perplexity direto tem preferência', () => {
    const p = resolverProvedorSonar({ perplexityKey: 'pplx-1', openrouterKey: 'sk-or-1' })
    expect(p).toEqual({
      apiKey: 'pplx-1',
      url: 'https://api.perplexity.ai/chat/completions',
      model: 'sonar-pro',
    })
  })
  it('sem chave da Perplexity → OpenRouter como gateway (perplexity/sonar-pro)', () => {
    const p = resolverProvedorSonar({ perplexityKey: null, openrouterKey: 'sk-or-1' })
    expect(p).toEqual({
      apiKey: 'sk-or-1',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'perplexity/sonar-pro',
    })
  })
  it('sem chave nenhuma (ou só espaços) → null (fonte 4 não roda)', () => {
    expect(resolverProvedorSonar({})).toBeNull()
    expect(resolverProvedorSonar({ perplexityKey: '  ', openrouterKey: '' })).toBeNull()
  })
})

describe('validarHandleInstagram', () => {
  it('normaliza @ e URL completa', () => {
    expect(validarHandleInstagram('@doce_arte')).toBe('doce_arte')
    expect(validarHandleInstagram('https://www.instagram.com/doce.arte/')).toBe('doce.arte')
  })
  it('rejeita reservadas e formatos inválidos', () => {
    expect(validarHandleInstagram('reel')).toBeNull()
    expect(validarHandleInstagram('x')).toBeNull() // curto demais
    expect(validarHandleInstagram(42)).toBeNull()
  })
})
