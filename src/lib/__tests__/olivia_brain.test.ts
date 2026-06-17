import { describe, it, expect } from 'vitest'
import {
  deveResponder,
  detectarOptout,
  construirSystemPrompt,
  historicoParaMensagens,
  montarRequest,
  interpretarResposta,
  estadoAposAcao,
  normalizarNumeroBr,
  extrairEmail,
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
  it('silencia quando o time pausa a Olivia (kill switch)', () => {
    expect(deveResponder('pausada')).toBe(false)
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
    expect(p).toContain("Scherbi's, Brigadayros e We Lov Cakes")
    expect(p).toContain('docerias e confeitarias')
    expect(p).toContain('a Pietra Pâtisserie')
    expect(p).toContain('em São Paulo')
    expect(p).toContain('Responsável conhecido: Maria')
  })
  it('genérico NÃO cita os cases de doces (anti-invenção)', () => {
    const p = construirSystemPrompt(lead({ setor: 'Academia', nome: 'Power Fit', dono_nome: null }))
    expect(p).not.toContain("Scherbi's")
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
  it('regras de estilo: não repetir cases, não insistir, nunca dizer que ligou', () => {
    const p = construirSystemPrompt(lead())
    expect(p).toMatch(/NO MÁXIMO uma vez/)
    expect(p).toMatch(/Não insista/)
    expect(p).toMatch(/nunca diga que ligou/)
    expect(p).toMatch(/registrar_dono/)
  })
  it('regra de tamanho: espelhar a pessoa, respostas curtas por padrão', () => {
    const p = construirSystemPrompt(lead())
    expect(p).toMatch(/espelhe o tamanho e a energia/)
    expect(p).toMatch(/1 a 3/)
    expect(p).toMatch(/NUNCA mande parágrafos longos/)
  })
  it('regra de mensagem irrelevante: não comentar conteúdo, tool ignorar', () => {
    const p = construirSystemPrompt(lead())
    expect(p).toMatch(/MENSAGEM IRRELEVANTE OU ACIDENTAL/)
    expect(p).toMatch(/figurinha\/emoji solto/)
    expect(p).toMatch(/ferramenta ignorar/)
  })
})

describe('OLIVIA_TOOLS', () => {
  it('inclui as tools de ignorar e validar horário sugerido', () => {
    const nomes = OLIVIA_TOOLS.map((t) => t.function.name)
    expect(nomes).toContain('ignorar')
    expect(nomes).toContain('verificar_horario_sugerido')
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

  it('confirmar_reuniao com opção válida → confirmar (opcao numérica)', () => {
    const a = interpretarResposta(withTool('confirmar_reuniao', '{"opcao":2}', 'Fechado!'))
    expect(a).toEqual({ tipo: 'confirmar', texto: 'Fechado!', opcao: 2 })
  })

  it('confirmar_reuniao sem opção válida → handoff (não chuta horário)', () => {
    expect(interpretarResposta(withTool('confirmar_reuniao', '{}')).tipo).toBe('handoff')
    expect(interpretarResposta(withTool('confirmar_reuniao', '{"opcao":0}')).tipo).toBe('handoff')
    expect(interpretarResposta(withTool('confirmar_reuniao', '{"opcao":"abc"}')).tipo).toBe('handoff')
  })

  it('verificar_horario_sugerido com ISO válido → sugerir_horario', () => {
    const a = interpretarResposta(
      withTool(
        'verificar_horario_sugerido',
        '{"slot_iso":"2026-06-15T17:00:00Z","texto_original":"pode ser segunda 14h"}',
        'Vou checar esse horário.',
      ),
    )
    expect(a).toEqual({
      tipo: 'sugerir_horario',
      texto: 'Vou checar esse horário.',
      slot_iso: '2026-06-15T17:00:00.000Z',
      texto_original: 'pode ser segunda 14h',
    })
  })

  it('verificar_horario_sugerido sem ISO mas com texto → deixa o servidor interpretar', () => {
    const a = interpretarResposta(
      withTool('verificar_horario_sugerido', '{"texto_original":"segunda 15h"}'),
    )
    expect(a).toEqual({
      tipo: 'sugerir_horario',
      texto: null,
      slot_iso: null,
      texto_original: 'segunda 15h',
    })
  })

  it('verificar_horario_sugerido sem ISO nem texto → handoff (não chuta data)', () => {
    expect(interpretarResposta(withTool('verificar_horario_sugerido', '{}')).tipo).toBe('handoff')
  })

  it('ignorar → ação ignorar com motivo (não envia nada)', () => {
    const a = interpretarResposta(withTool('ignorar', '{"motivo":"figurinha solta"}'))
    expect(a).toEqual({ tipo: 'ignorar', motivo: 'figurinha solta' })
  })

  it('ignorar sem motivo não quebra (cai no default)', () => {
    expect(interpretarResposta(withTool('ignorar', '{}'))).toEqual({ tipo: 'ignorar', motivo: 'sem motivo' })
  })

  it('tool desconhecida → handoff (não inventa comportamento)', () => {
    const a = interpretarResposta(withTool('fazer_cafe', '{}'))
    expect(a.tipo).toBe('handoff')
  })

  it('registrar_dono → ação com número e nome (texto acompanha)', () => {
    const a = interpretarResposta(
      withTool('registrar_dono', '{"numero":"(11) 99900-2121","nome":"Stefanie"}', 'Perfeito!'),
    )
    expect(a).toEqual({ tipo: 'registrar_dono', texto: 'Perfeito!', numero: '(11) 99900-2121', nome: 'Stefanie' })
  })

  it('registrar_dono sem número → handoff (não chuta contato)', () => {
    expect(interpretarResposta(withTool('registrar_dono', '{"numero":""}')).tipo).toBe('handoff')
    expect(interpretarResposta(withTool('registrar_dono', '{}')).tipo).toBe('handoff')
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

  it('texto truncado (finish_reason=length) → nada (não envia meia mensagem)', () => {
    const a = interpretarResposta({
      choices: [{ finish_reason: 'length', message: { content: 'Oi Maria, a Squad ajuda voc' } }],
    })
    expect(a.tipo).toBe('nada')
  })

  it('tool call com finish_reason=length ainda é executado (ação estruturada)', () => {
    const a = interpretarResposta({
      choices: [{ finish_reason: 'length', message: { content: null, tool_calls: [{ function: { name: 'marcar_optout', arguments: '{}' } }] } }],
    })
    expect(a.tipo).toBe('optout')
  })
})

describe('estadoAposAcao', () => {
  it('mapeia cada ação ao estado correto', () => {
    expect(estadoAposAcao({ tipo: 'optout', texto: null })).toBe('optout')
    expect(estadoAposAcao({ tipo: 'handoff', texto: null, motivo: 'x' })).toBe('handoff')
    expect(estadoAposAcao({ tipo: 'agendar', texto: null, resumo: 'y' })).toBe('agendando')
    expect(estadoAposAcao({ tipo: 'confirmar', texto: null, opcao: 1 })).toBeNull() // agendar marca 'agendado'
    expect(estadoAposAcao({ tipo: 'sugerir_horario', texto: null, slot_iso: '2026-06-15T17:00:00Z', texto_original: 'segunda 14h' })).toBeNull()
    expect(estadoAposAcao({ tipo: 'registrar_dono', texto: null, numero: '+5511999002121', nome: null })).toBe('conversando')
    expect(estadoAposAcao({ tipo: 'responder', texto: 'oi' })).toBe('conversando')
    expect(estadoAposAcao({ tipo: 'ignorar', motivo: 'figurinha solta' })).toBeNull() // silêncio: nada muda
    expect(estadoAposAcao({ tipo: 'nada', motivo: 'vazio' })).toBeNull()
  })
})

describe('extrairEmail', () => {
  it('extrai e normaliza o primeiro e-mail da mensagem', () => {
    expect(extrairEmail('Pode mandar para Cliente.Teste+agenda@Example.COM, por favor')).toBe(
      'cliente.teste+agenda@example.com',
    )
  })

  it('sem e-mail → null', () => {
    expect(extrairEmail('me manda no WhatsApp mesmo')).toBeNull()
    expect(extrairEmail(null)).toBeNull()
  })
})

describe('normalizarNumeroBr', () => {
  it('formatos comuns viram E.164', () => {
    expect(normalizarNumeroBr('(11) 99900-2121')).toBe('+5511999002121')
    expect(normalizarNumeroBr('11999002121')).toBe('+5511999002121')
    expect(normalizarNumeroBr('+55 11 99900-2121')).toBe('+5511999002121')
    expect(normalizarNumeroBr('55 48 9800-5386')).toBe('+554898005386')
    expect(normalizarNumeroBr('048 9800 5386')).toBe('+554898005386')
  })
  it('normaliza o número indicado no handoff da Carolline', () => {
    expect(normalizarNumeroBr('1194359-7666')).toBe('+5511943597666')
  })
  it('não-números e tamanhos implausíveis → null (anti-invenção)', () => {
    expect(normalizarNumeroBr('amanhã às 14h')).toBeNull()
    expect(normalizarNumeroBr('123')).toBeNull()
    expect(normalizarNumeroBr('')).toBeNull()
    expect(normalizarNumeroBr(null)).toBeNull()
    expect(normalizarNumeroBr('5511999002121999')).toBeNull()
  })
  it('rejeita códigos internacionais explícitos que não são do Brasil', () => {
    expect(normalizarNumeroBr('+1 (415) 555-2671')).toBeNull()
    expect(normalizarNumeroBr('001 415 555 2671')).toBeNull()
    expect(normalizarNumeroBr('+44 20 7946 0958')).toBeNull()
  })
  it('rejeita DDDs e celulares BR implausíveis', () => {
    expect(normalizarNumeroBr('+55 20 99900-2121')).toBeNull()
    expect(normalizarNumeroBr('+55 11 19900-2121')).toBeNull()
  })
})
