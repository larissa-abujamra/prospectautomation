import { describe, it, expect } from 'vitest'
import {
  deveResponder,
  detectarOptout,
  construirSystemPrompt,
  descreverAgora,
  historicoParaMensagens,
  montarRequest,
  interpretarResposta,
  estadoAposAcao,
  normalizarNumeroBr,
  escolherNumeroBr,
  extrairNumeroDono,
  extrairDddBr,
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
    expect(p).toContain('Responsável (no cadastro): ainda não temos o nome')
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
  it('emoji com parcimônia: sem emoji em toda mensagem e sem 😊 no exemplo', () => {
    const p = construirSystemPrompt(lead())
    expect(p).toMatch(/EMOJI: use com MUITA parcimônia/)
    expect(p).toMatch(/não deve ter nenhum/)
    expect(p).not.toContain('😊')
  })
  it('sem agora: NÃO injeta o bloco de data', () => {
    expect(construirSystemPrompt(lead())).not.toContain('DATA E HORA AGORA')
  })
  it('com agora: injeta a data e proíbe dizer o ano', () => {
    const p = construirSystemPrompt(lead(), 'quinta-feira, 18 de junho de 2026, 14:30 (horário de Brasília)')
    expect(p).toContain('DATA E HORA AGORA: quinta-feira, 18 de junho de 2026, 14:30 (horário de Brasília).')
    expect(p).toMatch(/NUNCA diga o ano/)
    expect(p).toMatch(/semana que vem/)
  })
  it('qualificação: instrui a NÃO repetir a pergunta de dono/responsável quando já confirmado', () => {
    const p = construirSystemPrompt(lead())
    expect(p).toMatch(/NUNCA PERGUNTE DUAS VEZES/i)
    expect(p).toMatch(/considere CONFIRMADO/i)
    // reconhece as confirmações típicas que o cliente manda
    expect(p).toMatch(/sou eu/i)
    expect(p).toMatch(/sou a dona/i)
  })
  it('sem dono no cadastro: não afirma "ainda não confirmado" de forma que force re-perguntar', () => {
    const p = construirSystemPrompt(lead({ dono_nome: null }))
    // a linha de contexto deve apontar que quem responde PODE ser o dono (confirmar pela conversa)
    expect(p).toMatch(/PODE ser o próprio dono\/responsável/i)
    expect(p).not.toContain('- Responsável: ainda não confirmado')
  })
  it('indicação do dono: reconhece cartão de contato compartilhado e manda chamar registrar_dono', () => {
    const p = construirSystemPrompt(lead())
    expect(p).toContain('[Contato compartilhado:')
    expect(p).toMatch(/chame registrar_dono/i)
  })
  it('indicação do dono: proíbe pedir o número de novo e re-qualificar quem repassou o contato', () => {
    const p = construirSystemPrompt(lead())
    expect(p).toMatch(/NUNCA peça o número de novo/i)
    expect(p).toMatch(/NÃO\s+volte a perguntar "você é o responsável\?"/i)
    // e não prometer contato antes da ferramenta
    expect(p).toMatch(/NUNCA diga "vou entrar em contato"/i)
  })
})

describe('escolherNumeroBr (cartão de contato multi-número)', () => {
  it('número único: igual ao normalizarNumeroBr (inclui prefixar DDD em local)', () => {
    expect(escolherNumeroBr('981059699', '19')).toBe('+5519981059699')
    expect(escolherNumeroBr('+55 21 98698-8380')).toBe('+5521986988380')
  })
  it('cartão multi-número: extrai o BR que bate com o DDD da praça (caso Café Das Águas)', () => {
    // IDs da Meta (215423487621, 1781968356) + número comum (5511936237724) + o real (DDD 19)
    const card = '215423487621, 5511936237724, 5519993592236, 1781968356'
    expect(escolherNumeroBr(card, '19')).toBe('+5519993592236')
  })
  it('cartão multi-número sem DDD da praça: prefere um celular válido, nunca a string toda', () => {
    const r = escolherNumeroBr('215423487621, 5511936237724, 5519993592236, 1781968356')
    expect(r).toMatch(/^\+55\d{10,11}$/)
    expect(r).not.toBeNull()
  })
  it('só IDs da Meta (nenhum número BR válido) → null (handoff é correto aí)', () => {
    expect(escolherNumeroBr('215423487621, 1781968356', '11')).toBeNull()
  })
})

describe('extrairNumeroDono (registro determinístico do responsável)', () => {
  it('cartão de contato → número', () => {
    expect(extrairNumeroDono('[Contato compartilhado: +55 21 97035-5923]')).toBe('+5521970355923')
  })
  it('número digitado sozinho no texto → número', () => {
    expect(extrairNumeroDono('11977643761')).toBe('+5511977643761')
  })
  it('número com saudação curta ("Boa tarde 11 98549-5275") → número', () => {
    expect(extrairNumeroDono('Boa tarde   11 985495275')).toBe('+5511985495275')
  })
  it('"Falar com Edson 11 99947-5069" → número (nome curto não atrapalha)', () => {
    expect(extrairNumeroDono('Falar com Edson 11 99947-5069')).toBe('+5511999475069')
  })
  it('número no MEIO de uma frase longa → null (não chuta dono)', () => {
    expect(
      extrairNumeroDono('oi! vou te passar o contato amanhã quando ele chegar, o antigo era 11999998888 mas mudou'),
    ).toBeNull()
  })
  it('CNPJ / sem número de celular válido → null', () => {
    expect(extrairNumeroDono('nosso cnpj é 11.222.333/0001-44 pra nota')).toBeNull()
    expect(extrairNumeroDono('bom dia, tudo bem?')).toBeNull()
    expect(extrairNumeroDono(null)).toBeNull()
  })
})

describe('OLIVIA_TOOLS registrar_dono', () => {
  it('descreve o gatilho de cartão de contato compartilhado', () => {
    const tool = OLIVIA_TOOLS.find((t) => t.function?.name === 'registrar_dono')
    expect(tool).toBeTruthy()
    expect(tool!.function.description).toMatch(/Contato compartilhado/i)
  })
})

describe('descreverAgora (data/hora em pt-BR, fuso de Brasília)', () => {
  it('formata o instante no fuso de São Paulo (UTC-3), sem inventar', () => {
    // 2026-06-18T17:30:00Z = 14:30 em Brasília (quinta-feira)
    const s = descreverAgora(Date.parse('2026-06-18T17:30:00Z'))
    expect(s).toContain('quinta-feira')
    expect(s).toContain('18 de junho de 2026')
    expect(s).toContain('14:30')
    expect(s).toContain('horário de Brasília')
  })
  it('é determinística: mesmo ms → mesma string', () => {
    const ms = Date.parse('2026-12-25T03:00:00Z')
    expect(descreverAgora(ms)).toBe(descreverAgora(ms))
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

  it('completa número local SEM DDD usando o DDD do lead (caso Nelson/Fioretta)', () => {
    // "Pode falar com o Nelson no 981059699" — celular SP sem o DDD 11.
    expect(normalizarNumeroBr('981059699', '11')).toBe('+5511981059699')
    expect(normalizarNumeroBr('98105-9699', '11')).toBe('+5511981059699')
    // fixo local de 8 dígitos + DDD do lead
    expect(normalizarNumeroBr('3253-1234', '11')).toBe('+551132531234')
    // DDD do lead pode vir em E.164 — extrai só os 2 dígitos
    expect(normalizarNumeroBr('981059699', '+5511')).toBe('+5511981059699')
  })

  it('sem DDD do lead, número local incompleto continua null (anti-invenção)', () => {
    expect(normalizarNumeroBr('981059699')).toBeNull()
    expect(normalizarNumeroBr('981059699', '')).toBeNull()
    // DDD padrão inválido não é usado para chutar
    expect(normalizarNumeroBr('981059699', '00')).toBeNull()
  })

  it('número já completo ignora o DDD padrão', () => {
    expect(normalizarNumeroBr('(48) 99800-5386', '11')).toBe('+5548998005386')
  })
})

describe('extrairDddBr', () => {
  it('extrai o DDD de um número E.164 BR do lead', () => {
    expect(extrairDddBr('+5511999002121')).toBe('11')
    expect(extrairDddBr('5548998005386')).toBe('48')
    expect(extrairDddBr('11999002121')).toBe('11')
  })
  it('sem número plausível → null', () => {
    expect(extrairDddBr(null)).toBeNull()
    expect(extrairDddBr('123')).toBeNull()
    expect(extrairDddBr('+1 415 555 2671')).toBeNull()
  })
})
