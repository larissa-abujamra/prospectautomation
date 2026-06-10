import { describe, it, expect } from 'vitest'
import {
  deveResponder,
  detectarOptout,
  construirSystemPrompt,
  historicoParaMensagens,
  montarRequest,
  interpretarResposta,
  estadoAposAcao,
  OLIVIA_TOOLS,
  type LeadContexto,
} from '../../../supabase/functions/_shared/olivia_brain'

const lead = (over: Partial<LeadContexto> = {}): LeadContexto => ({
  nome: 'Pietra Pâtisserie',
  dono_nome: 'Maria',
  setor: 'Confeitaria',
  cidade: 'São Paulo',
  nome_genero: 'f',
  ...over,
})

describe('deveResponder (gate de estado)', () => {
  it('responde em estados ativos', () => {
    expect(deveResponder(null)).toBe(true)
    expect(deveResponder('aguardando')).toBe(true)
    expect(deveResponder('conversando')).toBe(true)
    expect(deveResponder('agendando')).toBe(true)
  })
  it('silencia em optout/handoff/agendado', () => {
    expect(deveResponder('optout')).toBe(false)
    expect(deveResponder('handoff')).toBe(false)
    expect(deveResponder('agendado')).toBe(false)
  })
})

describe('detectarOptout (determinístico, LGPD)', () => {
  it('pega pedidos claros de parar', () => {
    for (const t of [
      'pare de mandar mensagem',
      'para de me chamar',
      'não quero',
      'não tenho interesse',
      'não me mande mais nada',
      'quero sair da lista',
      'me remove dessa lista por favor',
      'STOP',
      'sem interesse',
      'perdeu meu número',
    ]) {
      expect(detectarOptout(t), t).toBe(true)
    }
  })
  it('NÃO trata ambíguo como opt-out (deixa pro LLM)', () => {
    for (const t of [
      'não sou o dono, mas posso passar',
      'não hoje, me chama semana que vem',
      'oi! quem é?',
      'quanto custa?',
      'não sei se entendi',
    ]) {
      expect(detectarOptout(t), t).toBe(false)
    }
  })
  it('vazio/null → false', () => {
    expect(detectarOptout(null)).toBe(false)
    expect(detectarOptout('')).toBe(false)
    expect(detectarOptout('   ')).toBe(false)
  })
})

describe('construirSystemPrompt', () => {
  it('doces cita os cases de doces e usa o artigo do gênero', () => {
    const p = construirSystemPrompt(lead({ setor: 'Confeitaria', nome_genero: 'f' }))
    expect(p).toContain("Scherby's, Brigadayros e We Lov Cakes")
    expect(p).toContain('docerias e confeitarias')
    expect(p).toContain('a Pietra Pâtisserie')
    expect(p).toContain('em São Paulo')
    expect(p).toContain('Responsável conhecido: Maria')
  })
  it('genérico NÃO cita os cases de doces (anti-invenção)', () => {
    const p = construirSystemPrompt(lead({ setor: 'Academia', nome: 'Power Fit', dono_nome: null }))
    expect(p).not.toContain("Scherby's")
    expect(p).toContain('negócios locais como o seu')
    expect(p).toContain('Responsável: ainda não confirmado')
  })
  it('artigo masculino quando genero=m', () => {
    const p = construirSystemPrompt(lead({ nome: 'Empório do Café', nome_genero: 'm' }))
    expect(p).toContain('o Empório do Café')
  })
  it('objetivo único (qualificar + agendar) sempre presente', () => {
    expect(construirSystemPrompt(lead())).toMatch(/agendar uma conversa|marcar a reunião/i)
  })
})

describe('historicoParaMensagens', () => {
  it('mapeia in→user, out→assistant em ordem', () => {
    const msgs = historicoParaMensagens([
      { direcao: 'out', corpo: 'Oi! Sou a Olivia da Squad.' },
      { direcao: 'in', corpo: 'oi, quem é?' },
      { direcao: 'out', corpo: 'Ajudamos confeitarias a venderem mais.' },
    ])
    expect(msgs).toEqual([
      { role: 'assistant', content: 'Oi! Sou a Olivia da Squad.' },
      { role: 'user', content: 'oi, quem é?' },
      { role: 'assistant', content: 'Ajudamos confeitarias a venderem mais.' },
    ])
  })
  it('pula mensagens sem corpo (mídia)', () => {
    const msgs = historicoParaMensagens([
      { direcao: 'in', corpo: null },
      { direcao: 'in', corpo: '  ' },
      { direcao: 'in', corpo: 'oi' },
    ])
    expect(msgs).toEqual([{ role: 'user', content: 'oi' }])
  })
})

describe('montarRequest', () => {
  it('põe system primeiro, anexa histórico e inclui as tools', () => {
    const req = montarRequest('SYS', [{ role: 'user', content: 'oi' }], 'anthropic/claude-3.5-sonnet')
    expect(req.model).toBe('anthropic/claude-3.5-sonnet')
    expect(req.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(req.messages[1]).toEqual({ role: 'user', content: 'oi' })
    expect(req.tool_choice).toBe('auto')
    expect(req.tools).toBe(OLIVIA_TOOLS)
    expect(req.max_tokens).toBeLessThanOrEqual(500) // mensagens de WhatsApp são curtas
  })
})

describe('interpretarResposta', () => {
  const withTool = (name: string, args: unknown, content: string | null = null) => ({
    choices: [{ message: { content, tool_calls: [{ function: { name, arguments: args } }] } }],
  })

  it('texto puro → responder', () => {
    const a = interpretarResposta({ choices: [{ message: { content: 'Oi Maria! Tudo bem?' } }] })
    expect(a).toEqual({ tipo: 'responder', texto: 'Oi Maria! Tudo bem?' })
  })

  it('marcar_optout → optout', () => {
    expect(interpretarResposta(withTool('marcar_optout', '{}')).tipo).toBe('optout')
  })

  it('escalar_humano → handoff com motivo (args como string JSON)', () => {
    const a = interpretarResposta(withTool('escalar_humano', '{"motivo":"perguntou preço"}'))
    expect(a).toEqual({ tipo: 'handoff', texto: null, motivo: 'perguntou preço' })
  })

  it('agendar_reuniao → agendar com resumo (args como objeto)', () => {
    const a = interpretarResposta(
      withTool('agendar_reuniao', { resumo_disponibilidade: 'sexta 15h' }, 'Perfeito, marco pra sexta!'),
    )
    expect(a).toEqual({ tipo: 'agendar', texto: 'Perfeito, marco pra sexta!', resumo: 'sexta 15h' })
  })

  it('tool desconhecida → handoff (não inventa comportamento)', () => {
    const a = interpretarResposta(withTool('fazer_cafe', '{}'))
    expect(a.tipo).toBe('handoff')
  })

  it('args inválidos não quebram (resumo cai no default)', () => {
    const a = interpretarResposta(withTool('agendar_reuniao', '{ não é json'))
    expect(a).toEqual({ tipo: 'agendar', texto: null, resumo: 'sem detalhe' })
  })

  it('resposta vazia ou sem choices → nada', () => {
    expect(interpretarResposta({ choices: [{ message: { content: '   ' } }] }).tipo).toBe('nada')
    expect(interpretarResposta({}).tipo).toBe('nada')
    expect(interpretarResposta(null).tipo).toBe('nada')
  })
})

describe('estadoAposAcao', () => {
  it('mapeia cada ação ao estado correto', () => {
    expect(estadoAposAcao({ tipo: 'optout', texto: null })).toBe('optout')
    expect(estadoAposAcao({ tipo: 'handoff', texto: null, motivo: 'x' })).toBe('handoff')
    expect(estadoAposAcao({ tipo: 'agendar', texto: null, resumo: 'y' })).toBe('agendando')
    expect(estadoAposAcao({ tipo: 'responder', texto: 'oi' })).toBe('conversando')
    expect(estadoAposAcao({ tipo: 'nada', motivo: 'vazio' })).toBeNull()
  })
})
