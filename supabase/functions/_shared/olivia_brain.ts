// Cérebro da Olivia (Olivia Autônoma — Fase B: respondedora).
// =============================================================================
// Partes PURAS (sem I/O) — unit-testadas no Vitest e usadas pela Edge Function
// `olivia-responder`. Seguindo o padrão do projeto: a lógica testável vive aqui;
// a chamada ao LLM e o envio ficam na function.
//
// OBJETIVO ÚNICO da Olivia: conduzir a conversa no WhatsApp para QUALIFICAR o
// lead (é o dono/responsável? tem interesse?) e AGENDAR uma reunião. O humano só
// entra na reunião. Tudo que a Olivia não souber responder com segurança vira
// HANDOFF (escala pro time) — anti-invenção: ela nunca inventa preço, caso ou dado.
//
// LGPD: opt-out é detectado de forma DETERMINÍSTICA antes do LLM e é definitivo —
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
// NÃO é opt-out (pode ser "não sou o dono", "não hoje") — esse caso ambíguo vai
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
const CASES_DOCES = "Scherby's, Brigadayros e We Lov Cakes"
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
    'tom caloroso, leve e natural — como uma pessoa de verdade no WhatsApp, não um robô.',
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
    'sua deve aproximar disso — qualificar e marcar a reunião.',
    '',
    'REGRAS INEGOCIÁVEIS:',
    '1. NUNCA invente preço, número, caso de cliente ou qualquer dado. Se não souber,',
    '   seja honesta e use a ferramenta escalar_humano.',
    '2. Se a pessoa demonstrar irritação, pedir pra parar, ou disser que não é o',
    '   responsável e não pode ajudar, seja educada. Pra opt-out claro, use marcar_optout.',
    '3. Se a pessoa pedir detalhes que você não pode dar com segurança (preço,',
    '   contrato, integração específica), use escalar_humano em vez de inventar.',
    '',
    'AGENDAMENTO (objetivo final) — fluxo de dois passos:',
    '4. Quando o lead topar ter uma conversa/reunião, chame agendar_reuniao. A',
    '   ferramenta consulta a agenda e VOCÊ recebe de volta 2–3 horários numerados',
    '   pra oferecer — você nunca inventa nem escolhe o horário.',
    '5. Quando o lead escolher um dos números que você ofereceu, chame',
    '   confirmar_reuniao com aquele número (opcao). Não confirme horário fora da lista.',
    '',
    'FERRAMENTAS: prefira responder por texto enquanto a conversa avança naturalmente.',
    'Chame uma ferramenta só quando a situação pedir (agendar, confirmar, escalar, opt-out).',
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
        'Chame quando o lead aceitar ter uma conversa/reunião. A ferramenta consulta a agenda e PROPÕE 2–3 horários numerados — você NÃO escolhe nem inventa o horário, só dispara a proposta.',
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
  | { tipo: 'handoff'; texto: string | null; motivo: string }
  | { tipo: 'optout'; texto: string | null }
  | { tipo: 'nada'; motivo: string } // resposta vazia/ininteligível → não envia

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
  // Só vale para resposta de texto puro — tool call truncado vira ação igual.
  if (!toolCall && choice?.finish_reason === 'length') {
    return { tipo: 'nada', motivo: 'resposta truncada (max_tokens)' }
  }

  if (toolCall?.function?.name) {
    const nome = toolCall.function.name
    const args = parseToolArgs(toolCall.function.arguments)
    if (nome === 'marcar_optout') return { tipo: 'optout', texto }
    if (nome === 'escalar_humano') {
      return { tipo: 'handoff', texto, motivo: String(args.motivo ?? 'não especificado') }
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
    case 'responder':
      return 'conversando'
    case 'nada':
      return null // não muda estado
  }
}
