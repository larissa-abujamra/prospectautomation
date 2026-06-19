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
  | 'pausada'

// Estados em que a Olivia NÃO deve gerar resposta automática:
//   optout  → pediu pra parar (LGPD, definitivo)
//   handoff → humano assumiu
//   agendado → reunião já marcada, conversa encerrada
//   pausada → o time desligou a Olivia nessa conversa manualmente (kill switch:
//             ela está alucinando / fazendo algo errado). Reversível pela UI.
const ESTADOS_SILENCIO: ReadonlySet<string> = new Set(['optout', 'handoff', 'agendado', 'pausada'])

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
  // Memória da conversa (Fase 3): fatos estruturados que o LEAD já disse +
  // resumo rolante das mensagens antigas (além da janela de 40). Opcionais —
  // sem eles, o prompt é idêntico ao de antes (retrocompatível).
  conversa_fatos?: ConversaFatos | null
  conversa_resumo?: string | null
}

/**
 * Base de conhecimento POR CONVERSA. ANTI-INVENÇÃO: só guarda o que o lead
 * declarou de fato — nunca inferências. Tudo opcional; campos vazios não entram
 * no prompt. Escalares são sobrescritos por valor novo não-vazio; listas são
 * unidas (dedup). Nada é apagado por uma extração posterior.
 */
export interface ConversaFatos {
  is_dono?: boolean | null // confirmou ser o dono/responsável
  nome_responsavel?: string | null // nome do responsável, se disse
  email?: string | null
  disponibilidade?: string | null // ex.: "só de manhã", "depois do dia 20"
  objecoes?: string[] // ex.: ["acha caro", "já usa concorrente"]
  interesses?: string[] // ex.: ["quer saber da logística"]
  notas?: string[] // outros fatos ditos pelo lead
}

const FATOS_LISTAS = ['objecoes', 'interesses', 'notas'] as const

function uniqAppend(prev: string[] | undefined, novos: unknown): string[] {
  const base = Array.isArray(prev) ? [...prev] : []
  const vistos = new Set(base.map((s) => s.toLowerCase().trim()))
  const arr = Array.isArray(novos) ? novos : []
  for (const item of arr) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (!s) continue
    const k = s.toLowerCase()
    if (!vistos.has(k)) {
      vistos.add(k)
      base.push(s)
    }
  }
  return base
}

/**
 * Merge IMUTÁVEL de fatos: escalares novos não-vazios sobrescrevem; listas são
 * unidas com dedup (case-insensitive). Nunca remove o que já havia. Devolve um
 * objeto novo (não muta os argumentos).
 */
export function mergeFatos(
  prev: ConversaFatos | null | undefined,
  novos: ConversaFatos | null | undefined,
): ConversaFatos {
  const base: ConversaFatos = { ...(prev ?? {}) }
  // Listas SEMPRE viram cópias novas (imutabilidade: nunca devolver referência
  // pros arrays do `prev`, mesmo quando não há fatos novos).
  for (const lista of FATOS_LISTAS) {
    const merged = uniqAppend(base[lista], novos?.[lista])
    if (merged.length > 0) base[lista] = merged
    else delete base[lista]
  }
  if (novos) {
    if (typeof novos.is_dono === 'boolean') base.is_dono = novos.is_dono
    for (const campo of ['nome_responsavel', 'email', 'disponibilidade'] as const) {
      const v = novos[campo]
      if (typeof v === 'string' && v.trim()) base[campo] = v.trim()
    }
  }
  return base
}

/**
 * Renderiza a MEMÓRIA da conversa (fatos + resumo) como um bloco pt-BR pro
 * system prompt. Só inclui o que existe. Devolve [] quando não há memória —
 * assim o prompt fica idêntico ao antigo pra leads novos.
 */
export function formatarMemoria(
  fatos: ConversaFatos | null | undefined,
  resumo: string | null | undefined,
): string[] {
  const linhas: string[] = []
  if (fatos) {
    if (fatos.is_dono === true) linhas.push('- A pessoa É o dono/responsável (confirmado nesta conversa).')
    if (fatos.nome_responsavel?.trim()) linhas.push(`- Nome do responsável: ${fatos.nome_responsavel.trim()}`)
    if (fatos.email?.trim()) linhas.push(`- E-mail informado: ${fatos.email.trim()}`)
    if (fatos.disponibilidade?.trim()) linhas.push(`- Disponibilidade que a pessoa deu: ${fatos.disponibilidade.trim()}`)
    if (fatos.objecoes?.length) linhas.push(`- Objeções/ressalvas já levantadas: ${fatos.objecoes.join('; ')}`)
    if (fatos.interesses?.length) linhas.push(`- Interesses demonstrados: ${fatos.interesses.join('; ')}`)
    if (fatos.notas?.length) linhas.push(`- Outros fatos ditos: ${fatos.notas.join('; ')}`)
  }
  const resumoTxt = resumo?.trim()
  if (resumoTxt) linhas.push(`- Resumo da conversa até aqui: ${resumoTxt}`)
  if (linhas.length === 0) return []
  return [
    'MEMÓRIA DESTA CONVERSA (o que você JÁ SABE — não pergunte de novo, use com naturalidade):',
    ...linhas,
    '',
  ]
}

// Cases (social proof) por grupo de setor — espelham a copy dos templates.
// ANTI-INVENÇÃO: a Olivia só cita estes; nunca inventa um cliente.
const CASES_DOCES = "Scherbi's, Brigadayros e We Lov Cakes"
const CASES_GENERIC = 'outros negócios locais parecidos com o seu'

/**
 * Descreve "agora" em pt-BR no fuso de Brasília, ex.:
 *   "quinta-feira, 18 de junho de 2026, 14:30 (horário de Brasília)".
 * Puro/determinístico (mesmo ms → mesma string; Intl com timeZone fixo) pra ser
 * testável. Vai no system prompt pra Olivia resolver "hoje/amanhã/semana que vem".
 * O ANO entra aqui só pro raciocínio dela; ela é instruída a NÃO dizer o ano.
 */
export function descreverAgora(nowMs: number): string {
  const d = new Date(nowMs)
  const data = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(d)
  const hora = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(d)
  return `${data}, ${hora} (horário de Brasília)`
}

/**
 * System prompt da Olivia: persona + contexto do lead + objetivo + regras de
 * segurança (anti-invenção, handoff, opt-out) + instruções de tool-use. Puro e
 * determinístico (mesmo lead → mesmo prompt) para ser testável.
 */
export function construirSystemPrompt(lead: LeadContexto, agoraDescricao?: string): string {
  const grupo = grupoForSetor(lead.setor)
  const cases = grupo === 'doces' ? CASES_DOCES : CASES_GENERIC
  const artigo = lead.nome_genero === 'm' ? 'o' : 'a'
  const dono = lead.dono_nome?.trim() ? lead.dono_nome.trim() : null
  const cidade = lead.cidade?.trim() ? lead.cidade.trim() : null
  const segmento =
    grupo === 'doces' ? 'docerias e confeitarias' : 'negócios locais como o seu'

  const blocoData = agoraDescricao
    ? [
        'DATA E HORA AGORA: ' + agoraDescricao + '.',
        'Use isto pra entender e responder a referências de tempo: "hoje", "amanhã",',
        '"depois de amanhã", "semana que vem", "fim de semana", dias da semana, etc.',
        'Ao FALAR de datas com a pessoa, seja natural e relativa ("amanhã", "terça que',
        'vem", "semana que vem", "dia 25") — NUNCA diga o ano e não soletre a data por',
        'extenso como um robô. Se a pessoa só puder num período ("só semana que vem",',
        '"depois do dia 20"), respeite isso ao propor/validar horários.',
        '',
      ]
    : []

  return [
    'Você é a Olivia, da Squad.com (squad.com). Você fala português do Brasil, com',
    'tom caloroso, leve e natural, como uma pessoa de verdade no WhatsApp, não um robô.',
    'Mensagens curtas (1 a 3 frases), sem jargão, sem soar script. Use o primeiro nome',
    'da pessoa quando souber. Nunca diga que é uma IA a menos que perguntem diretamente.',
    '',
    ...blocoData,
    'O QUE A SQUAD FAZ: ajuda ' + segmento + ' a venderem mais com atendimento por IA no',
    'WhatsApp (que parece humano de verdade) e uma solução de logística e entrega.',
    `Já roda em ${cases}.`,
    '',
    'CONTEXTO DESTE LEAD:',
    `- Negócio: ${artigo} ${lead.nome}` + (cidade ? ` (em ${cidade})` : ''),
    dono
      ? `- Responsável conhecido: ${dono}`
      : '- Responsável (no cadastro): ainda não temos o nome — mas quem está respondendo' +
        ' PODE ser o próprio dono/responsável; confirme pela CONVERSA, não por este campo.',
    `- Segmento: ${lead.setor ?? 'não informado'}`,
    '',
    ...formatarMemoria(lead.conversa_fatos, lead.conversa_resumo),
    'SEU OBJETIVO ÚNICO: descobrir se quem responde é o dono/responsável e, com leveza,',
    'agendar uma conversa rápida (30 min, online) para apresentar a solução. Cada mensagem',
    'sua deve aproximar disso: qualificar e marcar a reunião.',
    '',
    'QUALIFICAÇÃO — NUNCA PERGUNTE DUAS VEZES: se a pessoa já disse ou deu a entender que',
    'é o dono/responsável (ex.: "sou eu", "sou a dona", "sim, sou responsável", "sou eu',
    'mesma", "pode falar comigo", "é comigo mesmo"), considere CONFIRMADO. NÃO volte a',
    'perguntar quem é o responsável — isso irrita e soa robótico. Agradeça em uma linha',
    'e siga DIRETO para combinar a conversa (pergunte o melhor dia/horário pra ela). Só',
    'pergunte de novo se a resposta for mesmo ambígua, ou se ela disser que é outra pessoa',
    '(aí sim peça o contato do responsável). Olhe o histórico antes de perguntar.',
    '',
    'REGRAS INEGOCIÁVEIS:',
    '1. NUNCA invente preço, número, caso de cliente ou qualquer dado. Se não souber,',
    '   seja honesta e use a ferramenta escalar_humano.',
    '1b. NOME DA PESSOA: nunca invente um nome. Só chame a pessoa pelo nome se ela se',
    '   apresentou NESTA conversa, ou se o nome está no contexto do lead acima. Na',
    '   dúvida, fale SEM nome — jamais chute (já chamamos uma cliente por um nome errado).',
    '2. Se a pessoa demonstrar irritação, pedir pra parar, ou disser que não é o',
    '   responsável e não pode ajudar, seja educada. Pra opt-out claro, use marcar_optout.',
    '3. Se a pessoa pedir detalhes que você não pode dar com segurança (preço,',
    '   contrato, integração específica), use escalar_humano em vez de inventar.',
    `4. ESTILO: não repita informação que você já mandou nesta conversa. Os cases (${cases})`,
    '   já apareceram na primeira mensagem; mencione de novo NO MÁXIMO uma vez na conversa',
    '   inteira, e só se a pessoa pedir referências. Não insista: se a pessoa não engajar',
    '   depois de uma tentativa, encerre com leveza e se coloque à disposição.',
    '5. TAMANHO: espelhe o tamanho e a energia da mensagem da pessoa. Mensagem curta',
    '   pede resposta curta (um "Oi! Tudo sim e por aí?" basta pra small talk; uma',
    '   linha basta pra pergunta de sim/não). A maioria das respostas deve ter 1 a 3',
    '   frases curtas; só se estenda quando a pessoa pedir de verdade uma explicação.',
    '   NUNCA mande parágrafos longos nem textão.',
    '5b. EMOJI: use com MUITA parcimônia. NÃO coloque emoji em toda mensagem — a',
    '   maioria das suas mensagens não deve ter nenhum. No máximo um, e só quando',
    '   realmente couber. Nada de carinhas em toda frase; soa robótico e forçado.',
    '6. MENSAGEM IRRELEVANTE OU ACIDENTAL: se a pessoa mandar algo fora do assunto,',
    '   claramente por engano ou sem sentido (mensagem de outro assunto, mensagem',
    '   enviada por engano, figurinha/emoji solto, texto sem sentido), NÃO comente o',
    '   conteúdo. Ou retome a conversa com UMA linha leve, ou — se qualquer resposta',
    '   soaria estranha — chame a ferramenta ignorar e não diga nada.',
    '6b. MÍDIA QUE NÃO ABRIU: se a última mensagem do lead aparecer como',
    '   "[a pessoa enviou um áudio/imagem/documento/vídeo que não consegui',
    '   ouvir/ver/abrir]", chegou uma mídia que você NÃO conseguiu ler. NUNCA',
    '   invente o conteúdo. Reconheça com leveza e peça pra reenviar ou contar por',
    '   escrito (ex.: "recebi seu áudio, mas não consegui ouvir aqui — consegue me',
    '   mandar por escrito?"). Uma linha só; não use ferramentas nesse caso.',
    '7. Você se comunica SÓ por mensagem aqui no WhatsApp; nunca diga que ligou,',
    '   que vai ligar, ou prometa um contato que você não pode fazer.',
    '7b. VÁRIAS MENSAGENS SEGUIDAS: é comum a pessoa quebrar um pensamento em várias',
    '   bolhas seguidas ("oi" / "vi sua mensagem" / "quanto custa?"). Leia TODAS',
    '   como uma coisa só e responda UMA vez, ao conjunto — nunca responda bolha por',
    '   bolha nem comece a responder a primeira sem considerar as seguintes.',
    '',
    'AGENDAMENTO (objetivo final): PERGUNTE o horário do lead, não ofereça opções.',
    '8. Quando o lead topar ter uma conversa/reunião, NÃO proponha horários. PERGUNTE',
    '   qual dia e horário fica melhor PRA ELE (pergunta aberta), usando sua noção de',
    '   data ("hoje", "amanhã", "semana que vem"). Ex.: "Que dia e horário funciona',
    '   melhor pra você?".',
    '9. Quando o lead disser um horário ("terça às 15h", "amanhã 10h", "dia 25 de',
    '   manhã"), chame verificar_horario_sugerido com o texto original (e slot_iso em',
    '   ISO UTC se tiver certeza). A agenda vê se ALGUÉM do time está livre nesse',
    '   horário e marca; se ninguém estiver livre, ela já responde pedindo outro',
    '   horário — você só repassa e espera a próxima sugestão. NUNCA ofereça horários',
    '   alternativos por conta própria nem invente disponibilidade.',
    '10. Só chame agendar_reuniao (que PROPÕE 2-3 opções) se o lead pedir que VOCÊ',
    '   escolha ou disser que tanto faz ("você escolhe", "o que vocês têm?", "qualquer',
    '   horário"). Aí, quando ele escolher um número, chame confirmar_reuniao(opcao).',
    '11. Para fechar a reunião, precisamos do e-mail do prospect para enviar o convite',
    '   da agenda. Se ainda não houver e-mail, a ferramenta de agenda vai pedir antes',
    '   de confirmar. Nunca diga que o convite foi enviado sem a ferramenta confirmar.',
    '',
    'INDICAÇÃO DO DONO/RESPONSÁVEL (quando te passam o contato de OUTRA pessoa):',
    '12. Se te indicarem o dono/responsável e vier um número — digitado no texto',
    '   ("manda pro nosso gerente: 21 98888-7777", "o número dela é ...") OU um cartão',
    '   de contato compartilhado (aparece na conversa como "[Contato compartilhado:',
    '   +55 ...]") — chame registrar_dono JÁ com esse número (e o nome, se disserem).',
    '   Esse número É a indicação que você precisava.',
    '13. NUNCA peça o número de novo se ele já apareceu na conversa (texto ou cartão de',
    '   contato). Pedir algo que a pessoa acabou de mandar é o que mais irrita.',
    '14. NUNCA diga "vou entrar em contato" / "vou chamar essa pessoa" ANTES de chamar',
    '   registrar_dono — é a ferramenta que dispara a mensagem oficial. Sem ela, não',
    '   prometa contato com terceiros nem diga que já vai falar com a pessoa.',
    '15. Depois que te passaram o contato do responsável, a conversa com ESTE número se',
    '   encerra com leveza (agradeça e diga que vai falar com a pessoa indicada). NÃO',
    '   volte a perguntar "você é o responsável?" para quem acabou de te repassar outro',
    '   contato — isso é contraditório e parece que você não leu o que mandaram.',
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
  // tipo da mensagem em whatsapp_mensagens ('text'|'audio'|'image'|'document'|
  // 'video'|...). Usado p/ injetar um placeholder quando a mídia chegou mas não
  // conseguimos lê-la (transcrição/OCR falhou ou sem chave do provedor).
  tipo?: string | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Placeholder pt-BR para mídia INBOUND que a Olivia não conseguiu ler (áudio sem
 * transcrição, imagem/documento/vídeo sem OCR). Injetado como turno do lead pra
 * ela RECONHECER que algo chegou — e pedir pra reenviar/escrever — em vez de
 * responder ao contexto antigo (bug visto em produção). ANTI-INVENÇÃO: o texto
 * deixa explícito que NÃO lemos o conteúdo; ela nunca deve chutar o que era.
 * Tipos sem placeholder (texto vazio, tipo desconhecido) → null (segue pulado).
 */
export function placeholderMidia(tipo: string | null | undefined): string | null {
  switch (tipo) {
    case 'audio':
    case 'voice':
      return '[a pessoa enviou um áudio que não consegui ouvir]'
    case 'image':
    case 'sticker':
      return '[a pessoa enviou uma imagem que não consegui ver]'
    case 'document':
      return '[a pessoa enviou um documento que não consegui abrir]'
    case 'video':
      return '[a pessoa enviou um vídeo que não consegui ver]'
    default:
      return null
  }
}

/**
 * Converte o histórico (whatsapp_mensagens, ordem cronológica) em mensagens do
 * chat: inbound do lead → 'user', outbound da Olivia → 'assistant'. Mensagens
 * com texto entram direto. Mídia INBOUND sem texto que não conseguimos ler vira
 * um placeholder pra a Olivia reagir à mídia em vez do contexto velho. Texto
 * vazio e mídia outbound sem corpo seguem pulados.
 */
export function historicoParaMensagens(historico: HistoricoMsg[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const m of historico) {
    const corpo = m.corpo?.trim()
    if (corpo) {
      msgs.push({ role: m.direcao === 'in' ? 'user' : 'assistant', content: corpo })
      continue
    }
    if (m.direcao === 'in') {
      const ph = placeholderMidia(m.tipo)
      if (ph) msgs.push({ role: 'user', content: ph })
    }
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
        'Use APENAS quando o lead pedir que VOCÊ escolha o horário ou disser que tanto faz ("você escolhe", "o que vocês têm?", "qualquer horário"). PROPÕE 2 a 3 horários numerados. NÃO é o primeiro passo: o padrão é PERGUNTAR ao lead o horário que ele prefere e usar verificar_horario_sugerido.',
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
        'CAMINHO PRINCIPAL de agendamento. Chame quando o lead disser qualquer dia/horário que prefere (ex.: "terça às 15h", "amanhã de manhã", "dia 25 às 10h"). Passe o texto original; se tiver certeza do instante, inclua slot_iso em ISO UTC. A agenda vê quem do time está livre nesse horário e marca — ou pede outro horário se ninguém puder.',
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
        'Chame quando te passarem o NÚMERO de WhatsApp do dono/responsável — seja digitado no texto OU como cartão de contato compartilhado (aparece como "[Contato compartilhado: +55 ...]"). Extraia os dígitos desse número. Registra o contato e dispara nossa primeira mensagem oficial para essa pessoa. Se o número já apareceu na conversa, chame esta ferramenta em vez de pedir de novo. Nunca invente o número.',
      parameters: {
        type: 'object',
        properties: {
          numero: { type: 'string', description: 'Número de WhatsApp informado (do texto ou do cartão "[Contato compartilhado: ...]"), como apareceu.' },
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

// --- Extração de fatos (memória da conversa, Fase 3) -------------------------

const FATOS_SYSTEM = [
  'Você extrai FATOS de uma conversa de WhatsApp entre uma SDR (assistant) e um',
  'lead (user). Devolva SOMENTE um objeto JSON com o que o LEAD DECLAROU sobre si',
  'ou o negócio dele — NUNCA invente nem infira. Se algo não foi dito, omita o campo.',
  '',
  'Schema (todos os campos opcionais):',
  '{',
  '  "is_dono": boolean,            // true só se o lead confirmou ser dono/responsável',
  '  "nome_responsavel": string,    // nome do dono/responsável, se dito',
  '  "email": string,               // e-mail que o lead passou',
  '  "disponibilidade": string,     // quando ele pode ("só de manhã", "depois do dia 20")',
  '  "objecoes": string[],          // ressalvas ditas ("acha caro", "já usa concorrente")',
  '  "interesses": string[],        // interesses ("quer saber da logística")',
  '  "notas": string[]              // outros fatos concretos ditos pelo lead',
  '}',
  '',
  'Responda APENAS com o JSON, sem texto ao redor, sem markdown. {} se nada relevante.',
].join('\n')

export interface FatosRequest {
  model: string
  temperature: number
  max_tokens: number
  response_format: { type: 'json_object' }
  messages: Array<{ role: string; content: string }>
}

/**
 * Monta o request de extração de fatos: uma chamada CURTA e barata (temp 0,
 * json_object) sobre o histórico da conversa. Puro/determinístico.
 */
export function montarRequestFatos(historico: ChatMessage[], model: string): FatosRequest {
  const transcript = historico
    .map((m) => `${m.role === 'user' ? 'LEAD' : 'OLIVIA'}: ${m.content}`)
    .join('\n')
  return {
    model,
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: FATOS_SYSTEM },
      { role: 'user', content: transcript },
    ],
  }
}

/** Sanitiza um valor desconhecido num ConversaFatos seguro (ignora lixo/tipos errados). */
function coerceFatos(raw: unknown): ConversaFatos {
  const o = (raw ?? {}) as Record<string, unknown>
  const out: ConversaFatos = {}
  if (typeof o.is_dono === 'boolean') out.is_dono = o.is_dono
  for (const campo of ['nome_responsavel', 'email', 'disponibilidade'] as const) {
    const v = o[campo]
    if (typeof v === 'string' && v.trim()) out[campo] = v.trim()
  }
  for (const lista of FATOS_LISTAS) {
    const v = o[lista]
    if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
      if (arr.length > 0) out[lista] = arr
    }
  }
  return out
}

/**
 * Interpreta a resposta da extração (formato OpenAI) num ConversaFatos. Tolerante:
 * resposta vazia/ininteligível → {} (não quebra o fluxo principal nem inventa).
 */
export function parseFatos(data: unknown): ConversaFatos {
  const content = (data as any)?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) return {}
  try {
    return coerceFatos(JSON.parse(content))
  } catch {
    // Às vezes vem cercado de ```json ... ``` apesar do response_format.
    const m = content.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        return coerceFatos(JSON.parse(m[0]))
      } catch {
        return {}
      }
    }
    return {}
  }
}

// --- Scoring de desfecho (Fase 4, cron olivia-score-outcomes) ----------------

const SCORE_SYSTEM = [
  'Você avalia a QUALIDADE de uma conversa de WhatsApp já encerrada entre a SDR',
  'Olivia (OLIVIA) e um lead (LEAD), do ponto de vista de vendas/atendimento.',
  'Devolva SOMENTE um JSON: {"quality_score": <1-5>, "theme_tags": [<string>...]}.',
  'quality_score: 1 = ruim (robótica, repetitiva, perdeu o lead); 3 = ok;',
  '5 = excelente (natural, avançou pra reunião, lidou bem com objeções).',
  'theme_tags: 2 a 5 tags curtas em pt-BR do que marcou a conversa',
  '(ex.: "preço", "agendou", "sem interesse", "pediu detalhes", "indicou outro").',
  'Responda APENAS o JSON, sem markdown nem texto ao redor.',
].join('\n')

export interface ScoreRequest {
  model: string
  temperature: number
  max_tokens: number
  response_format: { type: 'json_object' }
  messages: Array<{ role: string; content: string }>
}

/** Monta o request de scoring (barato: temp 0, json_object) sobre o transcript. */
export function montarRequestScore(transcript: string, model: string): ScoreRequest {
  return {
    model,
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SCORE_SYSTEM },
      { role: 'user', content: transcript },
    ],
  }
}

export interface OutcomeScore {
  quality_score: number | null // 1-5, ou null se inválido
  theme_tags: string[]
}

/**
 * Interpreta a resposta do scoring. Tolerante: vazio/ininteligível → score null
 * e tags []. quality_score só vale se for inteiro 1-5 (anti-lixo).
 */
export function parseScore(data: unknown): OutcomeScore {
  const empty: OutcomeScore = { quality_score: null, theme_tags: [] }
  const content = (data as any)?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) return empty
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(content)
  } catch {
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return empty
    try {
      obj = JSON.parse(m[0])
    } catch {
      return empty
    }
  }
  const q = Number(obj?.quality_score)
  const quality_score = Number.isInteger(q) && q >= 1 && q <= 5 ? q : null
  const theme_tags = Array.isArray(obj?.theme_tags)
    ? (obj.theme_tags as unknown[])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, 8)
    : []
  return { quality_score, theme_tags }
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

/**
 * Extrai o DDD (2 dígitos) de um número BR do próprio lead (E.164 ou cru), para
 * usar como "praça padrão" ao completar um número local que a pessoa mandou sem
 * o código de área. Devolve null se não houver número nacional plausível.
 */
export function extrairDddBr(raw: string | null | undefined): string | null {
  if (!raw) return null
  const texto = String(raw).trim()
  let d = texto.replace(/\D/g, '')
  const intl = /^\s*\+/.test(texto) || d.startsWith('00')
  if (intl) {
    if (d.startsWith('0055')) d = d.slice(4)
    else if (d.startsWith('55')) d = d.slice(2)
    else return null // internacional não-BR → sem DDD brasileiro
  } else if (d.startsWith('55') && d.length >= 12) {
    d = d.slice(2)
  }
  if (d.length < 10 || d.length > 11) return null
  const ddd = d.slice(0, 2)
  return DDDS_BR.has(ddd) ? ddd : null
}

/**
 * @param dddPadrao DDD do lead (da própria conversa) para completar um número
 *   LOCAL informado sem código de área. Sem ele, número incompleto → null
 *   (anti-invenção: nunca chutamos a praça).
 */
export function normalizarNumeroBr(
  raw: string | null | undefined,
  dddPadrao?: string | null,
): string | null {
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

  // Número local SEM DDD (8 = fixo / 9 = celular): a pessoa mandou só o número
  // ("fala com o Nelson no 981059699"). Se soubermos o DDD da praça do lead,
  // prefixamos — nunca chutamos um DDD do nada. Só fora de código internacional.
  if (
    !temCodigoInternacionalExplicito &&
    (digits.length === 8 || digits.length === 9) &&
    dddPadrao
  ) {
    const ddd = dddPadrao.replace(/\D/g, '').slice(-2)
    if (DDDS_BR.has(ddd)) digits = ddd + digits
  }

  if (digits.length < 10 || digits.length > 11) return null
  const ddd = digits.slice(0, 2)
  const local = digits.slice(2)
  if (!DDDS_BR.has(ddd)) return null
  if (digits.length === 11 && !local.startsWith('9')) return null
  if (digits.length === 10 && !/^[2-9]/.test(local)) return null

  return `+55${digits}`
}

// Escolhe UM número BR de um texto que pode trazer VÁRIOS — caso típico do cartão
// de contato compartilhado do WhatsApp Business, que vem como
// "[Contato compartilhado: 215423487621, 5511936237724, 5519993592236, 1781968356]"
// (IDs internos da Meta misturados com números reais). Antes a Olivia mandava a
// string inteira pro registrar_dono e normalizarNumeroBr falhava → handoff.
// Heurística: normaliza cada token; PREFERE o que bate com o DDD da praça do lead
// (o WhatsApp do dono local costuma ser do mesmo DDD), senão um celular, senão o 1º.
export function escolherNumeroBr(
  raw: string | null | undefined,
  dddPadrao?: string | null,
): string | null {
  if (!raw) return null
  // Tokens separados por vírgula/espaço/; — só os que têm dígitos suficientes.
  const tokens = String(raw).split(/[^\d+]+/).filter((t) => t.replace(/\D/g, '').length >= 8)
  // 0 ou 1 token → comportamento original (inclui prefixar DDD em local sem DDD).
  if (tokens.length <= 1) return normalizarNumeroBr(raw, dddPadrao)

  // Multi-número: cada token é um número COMPLETO (não prefixa DDD — evita inventar).
  // Só aceita CELULAR (+55 + DDD + 9 dígitos = 14 chars): o WhatsApp do dono é
  // celular, e isso descarta IDs internos da Meta que por acaso parecem um fixo
  // de 10 dígitos (ex.: 1781968356 → falso "fixo" do DDD 17).
  const moveis: string[] = []
  for (const t of tokens) {
    const n = normalizarNumeroBr(t)
    if (n && n.length === 14 && !moveis.includes(n)) moveis.push(n)
  }
  if (moveis.length === 0) return null

  const ddd = dddPadrao ? dddPadrao.replace(/\D/g, '').slice(-2) : null
  if (ddd) {
    const match = moveis.find((n) => n.slice(3, 5) === ddd)
    if (match) return match
  }
  return moveis[0]
}

// Detecta o número do RESPONSÁVEL na ÚLTIMA mensagem do lead, para a Olivia
// registrar direto (determinístico, sem depender do LLM — que às vezes re-pergunta
// mesmo com o número na tela). Cobre dois casos:
//  1) cartão de contato → "[Contato compartilhado: +55 ...]"
//  2) número (quase) sozinho no texto — ex.: "11 98549-5275", "Boa tarde 11977643761",
//     "Falar com Edson 11 99947-5069".
// NÃO dispara se o número está no meio de uma frase longa (anti-falso-positivo:
// CNPJ, valor, "liguei pro 0800...", "faturei 11 mil"). dddPadrao completa um
// número local sem DDD usando a praça do lead.
export function extrairNumeroDono(
  corpo: string | null | undefined,
  dddPadrao?: string | null,
): string | null {
  if (!corpo) return null
  const card = corpo.match(/\[Contato compartilhado:([^\]]+)\]/i)
  if (card) return escolherNumeroBr(card[1], dddPadrao)

  const numero = escolherNumeroBr(corpo, dddPadrao)
  if (!numero) return null
  // Exige que a mensagem seja ESSENCIALMENTE o número: tirando dígitos/pontuação de
  // telefone e saudações/conectivos comuns, deve sobrar pouquíssimo texto (um nome
  // curto, no máximo). Caso contrário é um número solto numa frase → deixa pro LLM.
  const resto = corpo
    .replace(/[+\d\s().\-]/g, ' ')
    .replace(
      /\b(oi|ol[áa]|bom dia|boa tarde|boa noite|tudo bem|segue|contato|whats(app)?|zap|n[uú]mero|cel(ular)?|tel|falar com|fala com|com o|com a|do|da|dele|dela|é|eh|esse|este|aqui|t[áa]|ok|obrigad[ao]|por favor|pf)\b/gi,
      ' ',
    )
    .replace(/[^\p{L}]/gu, '')
  return resto.length <= 12 ? numero : null
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
