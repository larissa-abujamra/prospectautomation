// Cérebro da Olivia (Olivia Autônoma, Fase B: respondedora).
// =============================================================================
// Partes PURAS (sem I/O), unit-testadas no Vitest e usadas pela Edge Function
// `olivia-responder`. Seguindo o padrão do projeto: a lógica testável vive aqui;
// a chamada ao LLM e o envio ficam na function.
//
// OBJETIVO ÚNICO da Olivia: conduzir a conversa no WhatsApp para QUALIFICAR o
// lead (é o dono/responsável? tem interesse?) e AGENDAR uma reunião. O humano só
// entra na reunião. Tudo que a Olivia não souber responder com segurança vira
// HANDOFF (escala pro time). Anti-invenção: ela nunca inventa preço, caso ou dado.
//
// LGPD: opt-out é detectado de forma DETERMINÍSTICA antes do LLM e é definitivo:
// uma vez optout, nunca mais mensageamos.
// =============================================================================

import type { Genero } from './genero.ts'
import { grupoForSetor } from './whatsapp_send.ts'

// --- Estado da conversa (espelha o enum da migration 0011) -------------------

export type OliviaEstado =
  | 'aguardando'
  | 'conversando'
  | 'agendando'
  | 'agendado'
  | 'handoff'
  | 'optout'

// Estados em que a Olivia NÃO deve gerar resposta automática:
//   optout  → pediu pra parar (LGPD, definitivo)
//   handoff → humano assumiu
//   agendado → reunião já marcada, conversa encerrada
const ESTADOS_SILENCIO: ReadonlySet<string> = new Set(['optout', 'handoff', 'agendado'])

/** A Olivia só responde em estados "ativos" (null/aguardando/conversando/agendando). */
export function deveResponder(estado: string | null | undefined): boolean {
  if (!estado) return true
  return !ESTADOS_SILENCIO.has(estado)
}

// --- Opt-out determinístico (antes do LLM) -----------------------------------

// Frases de opt-out INEQUÍVOCAS em pt-BR. Conservador de propósito: "não" sozinho
// NÃO é opt-out (pode ser "não sou o dono", "não hoje"). Esse caso ambíguo vai
// pro LLM, que pode escalar/optout via tool. Aqui só o que é claramente "pare".
const OPTOUT_PATTERNS: RegExp[] = [
  /\bpar[ae]\b.*\b(de\s+)?(mandar|enviar|mensag|me\s+chamar)/i, // "pare de mandar", "para de me chamar"
  /\bn[ãa]o\s+(quero|desejo|tenho\s+interesse)\b/i,             // "não quero", "não tenho interesse"
  /\bn[ãa]o\s+me\s+(mande|envie|chame|perturbe|incomode)/i,     // "não me mande mais"
  /\b(remov\w*|descadastr|tira?r?\s+da\s+lista|sair\s+da\s+lista)/i, // remove/remover/remova
  /\bn[ãa]o\s+enche/i,
  /\bperdeu\s+meu\s+n[úu]mero/i,
  /\b(stop|unsubscribe|cancelar?\s+inscri)/i,
  /\bsem\s+interesse\b/i,
]

/** Detecta opt-out inequívoco. Ambíguo → false (deixa o LLM tratar/escalar). */
export function detectarOptout(texto: string | null | undefined): boolean {
  if (!texto) return false
  const t = texto.trim()
  if (!t) return false
  return OPTOUT_PATTERNS.some((re) => re.test(t))
}

// --- Contexto do lead p/ o prompt --------------------------------------------

export interface LeadContexto {
  nome: string
  dono_nome: string | null
  setor: string | null
  cidade: string | null
  nome_genero: Genero | string | null
}

// Cases (social proof) por grupo de setor — espelham a copy dos templates.
// ANTI-INVENÇÃO: a Olivia só cita estes; nunca inventa um cliente.
const CASES_DOCES = "Scherbi's, Brigadayros e We Lov Cakes"
const CASES_GENERIC = 'outros negócios locais parecidos com o seu'

/**
 * System prompt da Olivia: persona + contexto do lead + objetivo + regras de
 * segurança (anti-invenção, handoff, opt-out) + instruções de tool-use. Puro e
 * determinístico (mesmo lead → mesmo prompt) para ser testável.
 */
export function construirSystemPrompt(lead: LeadContexto): string {
  const grupo = grupoForSetor(lead.setor)
  const cases = grupo === 'doces' ? CASES_DOCES : CASES_GENERIC
  const artigo = lead.nome_genero === 'm' ? 'o' : 'a'
  const dono = lead.dono_nome?.trim() ? lead.dono_nome.trim() : null
  const cidade = lead.cidade?.trim() ? lead.cidade.trim() : null
  const segmento =
    grupo === 'doces' ? 'docerias e confeitarias' : 'negócios locais como o seu'

  return [
    'Você é a Olivia, da Squad.com (squad.com). Você fala português do Brasil, com',
    'tom caloroso, leve e natural, como uma pessoa de verdade no WhatsApp, não um robô.',
    'Mensagens curtas (1 a 3 frases), sem jargão, sem soar script. Use o primeiro nome',
    'da pessoa quando souber. Nunca diga que é uma IA a menos que perguntem diretamente.',
    '',
    'O QUE A SQUAD FAZ: ajuda ' + segmento + ' a venderem mais com atendimento por IA no',
    'WhatsApp (que parece humano de verdade) e uma solução de logística e entrega.',
    `Já roda em ${cases}.`,
    '',
    'CONTEXTO DESTE LEAD:',
    `- Negócio: ${artigo} ${lead.nome}` + (cidade ? ` (em ${cidade})` : ''),
    dono ? `- Responsável conhecido: ${dono}` : '- Responsável: ainda não confirmado',
    `- Segmento: ${lead.setor ?? 'não informado'}`,
    '',
    'SEU OBJETIVO ÚNICO: descobrir se quem responde é o dono/responsável e, com leveza,',
    'agendar uma conversa rápida (30 min, online) para apresentar a solução. Cada mensagem',
    'sua deve aproximar disso: qualificar e marcar a reunião.',
    '',
    'REGRAS INEGOCIÁVEIS:',
    '1. NUNCA invente preço, número, caso de cliente ou qualquer dado. Se não souber,',
    '   seja honesta e use a ferramenta escalar_humano.',
    '2. Se a pessoa demonstrar irritação, pedir pra parar, ou disser que não é o',
    '   responsável e não pode ajudar, seja educada. Pra opt-out claro, use marcar_optout.',
    '3. Se a pessoa pedir detalhes que você não pode dar com segurança (preço,',
    '   contrato, integração específica), use escalar_humano em vez de inventar.',
    `4. ESTILO: não repita informação que você já mandou nesta conversa. Os cases (${cases})`,
    '   já apareceram na primeira mensagem; mencione de novo NO MÁXIMO uma vez na conversa',
    '   inteira, e só se a pessoa pedir referências. Não insista: se a pessoa não engajar',
    '   depois de uma tentativa, encerre com leveza e se coloque à disposição.',
    '5. TAMANHO: espelhe o tamanho e a energia da mensagem da pessoa. Mensagem curta',
    '   pede resposta curta (um "Oi! Tudo sim e por aí? 😊" basta pra small talk; uma',
    '   linha basta pra pergunta de sim/não). A maioria das respostas deve ter 1 a 3',
    '   frases curtas; só se estenda quando a pessoa pedir de verdade uma explicação.',
    '   NUNCA mande parágrafos longos nem textão.',
    '6. MENSAGEM IRRELEVANTE OU ACIDENTAL: se a pessoa mandar algo fora do assunto,',
    '   claramente por engano ou sem sentido (mensagem de outro assunto, mensagem',
    '   enviada por engano, figurinha/emoji solto, texto sem sentido), NÃO comente o',
    '   conteúdo. Ou retome a conversa com UMA linha leve, ou — se qualquer resposta',
    '   soaria estranha — chame a ferramenta ignorar e não diga nada.',
    '7. Você se comunica SÓ por mensagem aqui no WhatsApp; nunca diga que ligou,',
    '   que vai ligar, ou prometa um contato que você não pode fazer.',
    '',
    'AGENDAMENTO (objetivo final): fluxo de dois passos:',
    '8. Quando o lead topar ter uma conversa/reunião, chame agendar_reuniao. A',
    '   ferramenta consulta a agenda e VOCÊ recebe de volta 2 a 3 horários numerados',
    '   pra oferecer. Você nunca inventa nem escolhe o horário.',
    '9. Quando o lead escolher um dos números que você ofereceu, chame',
    '   confirmar_reuniao com aquele número (opcao).',
    '10. Se o lead sugerir um horário próprio ("terça às 15h", "amanhã 10h"), chame',
    '   verificar_horario_sugerido com o texto original. Se você tiver certeza do instante,',
    '   pode incluir slot_iso em ISO UTC; se não tiver, deixe a agenda interpretar. Ela',
    '   valida disponibilidade real; se não der, você pede outro horário. Não force só',
    '   os slots propostos pela Olivia.',
    '11. Para fechar a reunião, precisamos do e-mail do prospect para enviar o convite',
    '   da agenda. Se ainda não houver e-mail, a ferramenta de agenda vai pedir antes',
    '   de confirmar. Nunca diga que o convite foi enviado sem a ferramenta confirmar.',
    '',
    'INDICAÇÃO DO DONO/RESPONSÁVEL:',
    '12. Se a pessoa passar o número de WhatsApp do dono/responsável, chame registrar_dono',
    '   com o número (e o nome, se disser). A ferramenta dispara nossa primeira mensagem',
    '   oficial para essa pessoa; aí sim você pode dizer que vamos chamar ela no WhatsApp.',
    '   Sem chamar a ferramenta, não prometa contato com terceiros.',
    '',
    'FERRAMENTAS: prefira responder por texto enquanto a conversa avança naturalmente.',
    'Chame uma ferramenta só quando a situação pedir (agendar, confirmar, registrar o dono,',
    'escalar, opt-out, ignorar).',
  ].join('\n')
}

// --- Histórico → mensagens do LLM --------------------------------------------

export interface HistoricoMsg {
  direcao: 'in' | 'out'
  corpo: string | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Converte o histórico (whatsapp_mensagens, ordem cronológica) em mensagens do
 * chat: inbound do lead → 'user', outbound da Olivia → 'assistant'. Mensagens
 * sem corpo (mídia) são puladas (a Olivia responde sobre texto).
 */
export function historicoParaMensagens(historico: HistoricoMsg[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const m of historico) {
    const corpo = m.corpo?.trim()
    if (!corpo) continue
    msgs.push({ role: m.direcao === 'in' ? 'user' : 'assistant', content: corpo })
  }
  return msgs
}

// --- Tools (formato OpenAI/OpenRouter) ---------------------------------------

export const OLIVIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'agendar_reuniao',
      description:
        'Chame quando o lead aceitar ter uma conversa/reunião. A ferramenta consulta a agenda e PROPÕE 2 a 3 horários numerados. Você NÃO escolhe nem inventa o horário, só dispara a proposta.',
      parameters: {
        type: 'object',
        properties: {
          resumo_disponibilidade: {
            type: 'string',
            description: 'O que o lead disse sobre quando pode (ex.: "amanhã de tarde"), ou "" se não disse.',
          },
        },
        required: ['resumo_disponibilidade'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_reuniao',
      description:
        'Chame quando o lead escolher UM dos horários numerados que você propôs. Passe o NÚMERO da opção (1, 2, 3...). Nunca invente um horário fora da lista proposta.',
      parameters: {
        type: 'object',
        properties: {
          opcao: { type: 'integer', description: 'Número da opção escolhida pelo lead (1-based).' },
        },
        required: ['opcao'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verificar_horario_sugerido',
      description:
        'Chame quando o lead sugerir um horário próprio para reunião, em vez de escolher uma opção numerada. Passe o texto original; se tiver certeza, inclua também o instante em ISO UTC. A agenda valida disponibilidade real antes de confirmar.',
      parameters: {
        type: 'object',
        properties: {
          slot_iso: {
            type: 'string',
            description: 'Opcional. Horário sugerido pelo lead em ISO UTC, por exemplo 2026-06-15T17:00:00Z.',
          },
          texto_original: {
            type: 'string',
            description: 'Trecho original do lead que indicou o horário.',
          },
        },
        required: ['texto_original'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_dono',
      description:
        'Chame quando a pessoa passar o NÚMERO de WhatsApp do dono/responsável pelo negócio. Registra o contato e dispara nossa primeira mensagem oficial para essa pessoa. Nunca invente o número — só use o que a pessoa escreveu.',
      parameters: {
        type: 'object',
        properties: {
          numero: { type: 'string', description: 'Número de WhatsApp informado, como a pessoa escreveu.' },
          nome: { type: 'string', description: 'Nome do dono/responsável, se a pessoa disse. Senão "".' },
        },
        required: ['numero'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalar_humano',
      description:
        'Chame quando não puder responder com segurança (preço, contrato, pergunta técnica específica) ou a conversa fugir do script. Um humano assume.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Por que está escalando (curto).' },
        },
        required: ['motivo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'marcar_optout',
      description:
        'Chame quando a pessoa pedir claramente para não receber mais mensagens. Definitivo (LGPD).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ignorar',
      description:
        'Chame quando a última mensagem claramente não pede resposta (engano, figurinha solta, mensagem de outro assunto que não merece reação). Não responder é mais natural que responder.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Por que está ignorando (curto).' },
        },
      },
    },
  },
] as const

// --- Request do OpenRouter (puro) --------------------------------------------

export interface OpenRouterRequest {
  model: string
  temperature: number
  max_tokens: number
  messages: Array<{ role: string; content: string }>
  tools: typeof OLIVIA_TOOLS
  tool_choice: 'auto'
}

/** Monta o corpo do POST /chat/completions (system + histórico + tools). */
export function montarRequest(
  systemPrompt: string,
  historico: ChatMessage[],
  model: string,
): OpenRouterRequest {
  return {
    model,
    temperature: 0.6, // natural sem virar imprevisível
    max_tokens: 400, // mensagens de WhatsApp são curtas
    messages: [{ role: 'system', content: systemPrompt }, ...historico],
    tools: OLIVIA_TOOLS,
    tool_choice: 'auto',
  }
}

// --- Interpretação da resposta do LLM ----------------------------------------

export type OliviaAcao =
  | { tipo: 'responder'; texto: string }
  | { tipo: 'agendar'; texto: string | null; resumo: string }
  | { tipo: 'confirmar'; texto: string | null; opcao: number }
  | { tipo: 'sugerir_horario'; texto: string | null; slot_iso: string | null; texto_original: string }
  | { tipo: 'registrar_dono'; texto: string | null; numero: string; nome: string | null }
  | { tipo: 'handoff'; texto: string | null; motivo: string }
  | { tipo: 'optout'; texto: string | null }
  | { tipo: 'ignorar'; motivo: string } // a mensagem não pede resposta → silêncio deliberado
  | { tipo: 'nada'; motivo: string } // resposta vazia/ininteligível → não envia

/**
 * Normaliza um número BR escrito livremente ("(48) 9800-5386", "55 48 ...")
 * para E.164 (+55...). Anti-invenção: se não parecer um número BR plausível
 * (10–11 dígitos nacionais), devolve null — quem chamou decide escalar.
 */
const DDDS_BR = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
])

export function normalizarNumeroBr(raw: string | null | undefined): string | null {
  if (!raw) return null
  const texto = raw.trim()
  let digits = texto.replace(/\D/g, '')
  if (!digits) return null

  const temCodigoInternacionalExplicito = /^\s*\+/.test(texto) || digits.startsWith('00')
  if (temCodigoInternacionalExplicito) {
    if (digits.startsWith('0055')) digits = digits.slice(4)
    else if (digits.startsWith('55')) digits = digits.slice(2)
    else return null
  } else {
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '') // 0xx DDD antigo
    if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2)
  }

  if (digits.length < 10 || digits.length > 11) return null
  const ddd = digits.slice(0, 2)
  const local = digits.slice(2)
  if (!DDDS_BR.has(ddd)) return null
  if (digits.length === 11 && !local.startsWith('9')) return null
  if (digits.length === 10 && !/^[2-9]/.test(local)) return null

  return `+55${digits}`
}

export function extrairEmail(texto: string | null | undefined): string | null {
  const match = texto?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match ? match[0].toLowerCase() : null
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return (raw as Record<string, unknown>) ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Interpreta a resposta do OpenRouter (formato OpenAI) numa ação estruturada.
 * Tool call tem precedência sobre texto; o `content` que acompanha um tool call
 * (se houver) vira a mensagem a enviar antes/junto da ação.
 */
export function interpretarResposta(data: unknown): OliviaAcao {
  const choice = (data as any)?.choices?.[0]
  const msg = choice?.message
  if (!msg) return { tipo: 'nada', motivo: 'resposta do LLM sem choices' }

  const texto = typeof msg.content === 'string' && msg.content.trim() ? msg.content.trim() : null
  const toolCall = Array.isArray(msg.tool_calls) ? msg.tool_calls[0] : null

  // Truncada por limite de tokens: NÃO envia meia mensagem (qualidade/credibilidade).
  // Só vale para resposta de texto puro; tool call truncado vira ação igual.
  if (!toolCall && choice?.finish_reason === 'length') {
    return { tipo: 'nada', motivo: 'resposta truncada (max_tokens)' }
  }

  if (toolCall?.function?.name) {
    const nome = toolCall.function.name
    const args = parseToolArgs(toolCall.function.arguments)
    if (nome === 'marcar_optout') return { tipo: 'optout', texto }
    if (nome === 'ignorar') {
      return { tipo: 'ignorar', motivo: String(args.motivo ?? '').trim() || 'sem motivo' }
    }
    if (nome === 'escalar_humano') {
      return { tipo: 'handoff', texto, motivo: String(args.motivo ?? 'não especificado') }
    }
    if (nome === 'registrar_dono') {
      const numero = String(args.numero ?? '').trim()
      // sem número → escala em vez de chutar (anti-invenção)
      if (!numero) return { tipo: 'handoff', texto, motivo: 'registrar_dono sem número' }
      const nomeDono = String(args.nome ?? '').trim()
      return { tipo: 'registrar_dono', texto, numero, nome: nomeDono || null }
    }
    if (nome === 'agendar_reuniao') {
      return {
        tipo: 'agendar',
        texto,
        resumo: String(args.resumo_disponibilidade ?? args.resumo ?? '').trim() || 'sem detalhe',
      }
    }
    if (nome === 'confirmar_reuniao') {
      const opcao = Math.trunc(Number(args.opcao))
      // opção inválida (não-número/≤0) → escala em vez de chutar um horário.
      if (!Number.isInteger(opcao) || opcao < 1) {
        return { tipo: 'handoff', texto, motivo: 'confirmar_reuniao sem opção válida' }
      }
      return { tipo: 'confirmar', texto, opcao }
    }
    if (nome === 'verificar_horario_sugerido') {
      const slotIso = String(args.slot_iso ?? '').trim()
      const textoOriginal = String(args.texto_original ?? '').trim()
      const parsed = Date.parse(slotIso)
      if ((!slotIso || Number.isNaN(parsed)) && !textoOriginal) {
        return { tipo: 'handoff', texto, motivo: 'verificar_horario_sugerido sem ISO válido' }
      }
      return {
        tipo: 'sugerir_horario',
        texto,
        slot_iso: slotIso && !Number.isNaN(parsed) ? new Date(parsed).toISOString() : null,
        texto_original: textoOriginal,
      }
    }
    // tool desconhecida → escala por segurança (não inventa comportamento)
    return { tipo: 'handoff', texto, motivo: `tool desconhecida: ${nome}` }
  }

  if (texto) return { tipo: 'responder', texto }
  return { tipo: 'nada', motivo: 'resposta vazia do LLM' }
}

// --- Estado resultante de uma ação -------------------------------------------

/**
 * Próximo olivia_estado dado a ação escolhida. 'agendar' → 'agendando' (Fase C
 * confirma o slot e marca 'agendado'); handoff/optout são terminais para a
 * automação; responder mantém 'conversando'.
 */
export function estadoAposAcao(acao: OliviaAcao): OliviaEstado | null {
  switch (acao.tipo) {
    case 'optout':
      return 'optout'
    case 'handoff':
      return 'handoff'
    case 'agendar':
      return 'agendando'
    case 'confirmar':
      return null // a olivia-agendar marca 'agendado' ao criar o evento
    case 'sugerir_horario':
      return null // a agenda decide: pedir e-mail, pedir outro horário ou agendar
    case 'registrar_dono':
      return 'conversando' // a conversa segue; o dono entra pelo workflow
    case 'responder':
      return 'conversando'
    case 'ignorar':
      return null // silêncio deliberado: não envia e não muda estado
    case 'nada':
      return null // não muda estado
  }
}
