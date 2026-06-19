// Edge Function: olivia-responder
// =============================================================================
// Legacy dormant path: gera e envia a resposta da Olivia a UMA conversa pela
// Meta Cloud API. O go-live atual usa HubSpot para automação WhatsApp; esta
// function fica fora do runtime ativo até a conversa direta via Meta ser reativada.
// Plano histórico: .claude/plans/2026-06-10-olivia-autonoma.md
//
// FLUXO legado: carrega lead + histórico -> guardrails (opt-out determinístico,
// gate de estado) -> LLM (Claude via OpenRouter, com tools) -> executa a ação
// (envia texto via Cloud API / escala / opt-out / agenda) -> grava a mensagem de
// saída e o estado.
//
// SEGURANÇA: não é chamada por usuário final; exige o secret interno
// OLIVIA_TRIGGER_SECRET (header x-olivia-secret) OU um usuário autenticado (pra
// testar manualmente pela ferramenta). Deploy SEM verificação de JWT:
//   supabase functions deploy olivia-responder --no-verify-jwt
//
// DRY-RUN: por padrão (OLIVIA_DRY_RUN != 'false') NÃO envia nada, apenas calcula
// e devolve/loga a ação que TOMARIA. Vire 'false' só depois de validar transcripts.
//
// PROTEÇÕES DE CUSTO/ABUSO (ativas): segredo interno + auth; skip de "última msg
// já é out" (não responde 2x ao mesmo inbound); rate limit global por minuto via
// RPC olivia_rate_hit (env OLIVIA_MAX_POR_MIN, default 30 -> 429). Slots propostos
// expiram (24h) e re-propõem em vez de marcar horário velho.
//
// Secrets:
//   OPENROUTER_API_KEY            (mesmo do hubspot-sync)
//   OLIVIA_MODEL                  (opcional; default abaixo, modelo Claude via OpenRouter)
//   OLIVIA_TRIGGER_SECRET         (segredo interno que o webhook usa pra chamar)
//   OLIVIA_DRY_RUN=false          (pra realmente enviar; default é dry-run)
//   OLIVIA_PACING=0               (opcional; desliga atraso humano/coalescência)
//   OLIVIA_PACING_MIN_MS/MAX_MS   (opcional; defaults 1800/12000)
//   OLIVIA_COALESCE_MS            (opcional; default 7000; DEBOUNCE: tempo de
//                                  silêncio do lead antes de responder. Cada nova
//                                  mensagem reinicia a janela → 1 resposta cobre a
//                                  rajada inteira em vez de responder bolha a bolha)
//   OLIVIA_COALESCE_MAX_MS        (opcional; default 45000; teto total do debounce)
//   OLIVIA_MULTIPART=1            (opcional; envia blocos separados por linha vazia
//                                  como bolhas separadas, com pausas curtas)
//   OLIVIA_HORARIO=1              (opcional; liga o horário comercial, adia inbound
//                                  fora do expediente. Defaults: seg-sex 9-19 BRT,
//                                  override por OLIVIA_HORARIO_INICIO/FIM/TZ)
//   WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / WHATSAPP_GRAPH_VERSION
//     (mesmos do enviar-whatsapp; necessários só fora do dry-run)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  construirSystemPrompt,
  descreverAgora,
  detectarOptout,
  deveResponder,
  estadoAposAcao,
  extrairDddBr,
  extrairEmail,
  extrairNumeroDono,
  historicoParaMensagens,
  placeholderMidia,
  interpretarResposta,
  montarRequest,
  montarRequestFatos,
  parseFatos,
  mergeFatos,
  escolherNumeroBr,
  type OliviaAcao,
  type ConversaFatos,
} from '../_shared/olivia_brain.ts'
import { slotsExpirados } from '../_shared/olivia_agenda.ts'
import { buildReplyPacingPlan, type PacingOpts } from '../_shared/olivia_pacing.ts'
import { dentroDoHorario, proximaAbertura } from '../_shared/olivia_horario.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { registrarErro } from '../_shared/erros.ts'
import { podeMensagemLivre } from '../_shared/olivia_nudge.ts'
import {
  acharSenderActor,
  extractInbound,
  montarEnvioHubspot,
} from '../_shared/hubspot_conversations.ts'
import {
  HUBSPOT_STAGE_LOCALIZAR_RESPONSAVEL,
  HUBSPOT_STAGE_REUNIAO_PROPOSTA,
  ensureResponsibleHubspotContact,
  queueHubspotDealStageSync,
} from '../_shared/hubspot.ts'
import { resolveOliviaMessagingProvider, type OliviaMessagingProvider } from '../_shared/olivia_channel.ts'
import {
  buildTemplatePayloadForRecipient,
  buildTextPayload,
  DEFAULT_LANGS,
  DEFAULT_TEMPLATES,
  langFor,
  parseSendResult,
  templateFor,
  type SendableLead,
} from '../_shared/whatsapp_send.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Default por TIER (qualidade conversacional), sobrescrevível por env OLIVIA_MODEL.
// OpenRouter exige um id concreto E que a conta tenha acesso ao modelo — testado
// nesta conta: claude-sonnet-4 responde; claude-3.5/3.7-sonnet dão 404 (sem acesso).
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4'

type Supabase = ReturnType<typeof createClient>

interface EnvioParte {
  texto: string
  wamid: string | null
}

interface EnvioResultado {
  ok: boolean
  wamid: string | null
  erro: string | null
  mensagens: EnvioParte[]
  provider: OliviaMessagingProvider
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function envNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (raw == null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function pacingOptsFromEnv(extra: Pick<PacingOpts, 'urgency'> = {}): PacingOpts {
  const pacingDisabled = Deno.env.get('OLIVIA_PACING') === '0'
  return {
    disabled: pacingDisabled,
    testMode:
      Deno.env.get('OLIVIA_TEST_MODE') === '1' ||
      Deno.env.get('DENO_ENV') === 'test' ||
      Deno.env.get('NODE_ENV') === 'test',
    minMs: envNumber('OLIVIA_PACING_MIN_MS', 1800),
    maxMs: envNumber('OLIVIA_PACING_MAX_MS', 12000),
    msPorChar: envNumber('OLIVIA_PACING_MS_PER_CHAR', 28),
    urgentMinMs: envNumber('OLIVIA_PACING_URGENT_MIN_MS', 700),
    urgentMaxMs: envNumber('OLIVIA_PACING_URGENT_MAX_MS', 3200),
    systemMinMs: envNumber('OLIVIA_PACING_SYSTEM_MIN_MS', 500),
    systemMaxMs: envNumber('OLIVIA_PACING_SYSTEM_MAX_MS', 1800),
    multipart: Deno.env.get('OLIVIA_MULTIPART') === '1',
    ...extra,
  }
}

function currentMessagingProvider(): OliviaMessagingProvider {
  return resolveOliviaMessagingProvider(
    Deno.env.get('OLIVIA_MESSAGING_PROVIDER'),
    Deno.env.get('OLIVIA_CHANNEL'),
  )
}

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function mensagemApenasEmail(texto: string | null | undefined, email: string): boolean {
  const normalizado = semAcento(texto ?? '')
  const semEmail = normalizado.replace(semAcento(email), ' ')
  const resto = semEmail
    .replace(/[.,;:!?()[\]{}"']/g, ' ')
    .replace(/\b(meu|minha|email|e-mail|mail|e|eh|pode|manda|mandar|envia|enviar|para|pra|por|favor|segue|aqui|convite|o|me|no|na)\b/g, ' ')
    .replace(/\s+/g, '')
  return resto.length === 0
}

// Envia texto livre (não-template) pela Cloud API. Só dá certo dentro da janela
// de 24h aberta pela resposta do lead — que é exatamente quando a Olivia roda.
async function enviarTexto(
  to: string,
  texto: string,
): Promise<{ ok: boolean; wamid: string | null; erro: string | null }> {
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
  const graphVersion = Deno.env.get('WHATSAPP_GRAPH_VERSION') ?? 'v21.0'
  if (!phoneNumberId || !accessToken) {
    return { ok: false, wamid: null, erro: 'faltam secrets WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN' }
  }
  try {
    const resp = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTextPayload(to, texto)),
    })
    const data = await resp.json().catch(() => ({}))
    const result = parseSendResult(resp.status, data)
    if (result.status === 'sent') return { ok: true, wamid: result.messageId, erro: null }
    return { ok: false, wamid: null, erro: result.errorMessage ?? `HTTP ${resp.status}` }
  } catch (e) {
    return { ok: false, wamid: null, erro: e instanceof Error ? e.message : 'erro de rede' }
  }
}

async function enviarTemplateIntroMeta(
  lead: SendableLead,
  recipientE164: string,
): Promise<{ ok: boolean; wamid: string | null; erro: string | null; template: string }> {
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
  const graphVersion = Deno.env.get('WHATSAPP_GRAPH_VERSION') ?? 'v21.0'
  const langs = {
    docesF: Deno.env.get('WHATSAPP_LANG_F') ?? DEFAULT_LANGS.docesF,
    docesM: Deno.env.get('WHATSAPP_LANG_M') ?? DEFAULT_LANGS.docesM,
    genericF: Deno.env.get('WHATSAPP_LANG_GENERIC_F') ?? DEFAULT_LANGS.genericF,
    genericM: Deno.env.get('WHATSAPP_LANG_GENERIC_M') ?? DEFAULT_LANGS.genericM,
  }
  const templates = {
    ...DEFAULT_TEMPLATES,
    genericF: Deno.env.get('WHATSAPP_TEMPLATE_GENERIC_F') ?? DEFAULT_TEMPLATES.genericF,
    genericM: Deno.env.get('WHATSAPP_TEMPLATE_GENERIC_M') ?? DEFAULT_TEMPLATES.genericM,
  }
  const langCode = langFor(lead.setor, lead.nome_genero, langs)
  const template = templateFor(lead.setor, lead.nome_genero, templates)
  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      wamid: null,
      erro: 'faltam secrets WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN',
      template,
    }
  }
  try {
    const resp = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTemplatePayloadForRecipient(lead, recipientE164, langCode, templates)),
    })
    const data = await resp.json().catch(() => ({}))
    const result = parseSendResult(resp.status, data)
    if (result.status === 'sent') return { ok: true, wamid: result.messageId, erro: null, template }
    return { ok: false, wamid: null, erro: result.errorMessage ?? `HTTP ${resp.status}`, template }
  } catch (e) {
    return {
      ok: false,
      wamid: null,
      erro: e instanceof Error ? e.message : 'erro de rede',
      template,
    }
  }
}

// Envia texto livre pela API de Conversas do HubSpot (canal WhatsApp do inbox).
// A mensagem aparece no inbox do HubSpot — o time vê e pode assumir a qualquer
// momento (decisão de 11/06: tudo centrado no HubSpot). Anti-invenção: canal,
// conta e destinatário são copiados da última mensagem INCOMING do thread.
async function enviarTextoHubspot(
  threadId: string,
  texto: string,
): Promise<{ ok: boolean; wamid: string | null; erro: string | null }> {
  const token =
    Deno.env.get('HUBSPOT_CONVERSATIONS_TOKEN') ?? Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')
  if (!token) return { ok: false, wamid: null, erro: 'falta token do HubSpot' }

  try {
    const histResp = await fetch(
      `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages?limit=30`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const hist = await histResp.json().catch(() => ({}))
    if (!histResp.ok) {
      return { ok: false, wamid: null, erro: `thread HTTP ${histResp.status}` }
    }
    const mensagens: unknown[] = Array.isArray((hist as any)?.results) ? (hist as any).results : []
    // Última INCOMING define canal/destinatário; sender = agente de OUTGOING
    // anterior (o template do workflow) ou o ator configurado por env.
    const inboundMsg = [...mensagens].reverse().map(extractInbound).find(Boolean) ?? null
    const senderActorId =
      acharSenderActor(mensagens) ?? Deno.env.get('HUBSPOT_SENDER_ACTOR_ID') ?? null
    if (!inboundMsg) return { ok: false, wamid: null, erro: 'thread sem mensagem INCOMING' }
    if (!senderActorId) {
      return { ok: false, wamid: null, erro: 'sem senderActorId (env HUBSPOT_SENDER_ACTOR_ID)' }
    }
    const corpo = montarEnvioHubspot({ inbound: inboundMsg, senderActorId, texto })
    if (!corpo) return { ok: false, wamid: null, erro: 'thread sem canal/destinatário completos' }

    const resp = await fetch(
      `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      },
    )
    const data = await resp.json().catch(() => ({}))
    if (resp.ok && (data as any)?.id) {
      const msgId = String((data as any).id)
      // A API aceita (200) mas a entrega ao WhatsApp é assíncrona e pode falhar
      // logo depois (visto em produção: SHORT_MESSAGES_AGENT_SERVER_ERROR).
      // Verifica o status real antes de declarar sucesso — FAILED vira erro.
      for (const espera of [4_000, 6_000]) {
        await new Promise((r) => setTimeout(r, espera))
        try {
          const chk = await fetch(
            `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages/${msgId}`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          const st = ((await chk.json().catch(() => ({}))) as any)?.status
          if (st?.statusType === 'FAILED') {
            const motivo = st?.failureDetails?.errorMessage ?? 'FAILED'
            return { ok: false, wamid: null, erro: `entrega falhou no HubSpot: ${motivo}` }
          }
          // DELIVERED/READ = entregue de fato; para de checar.
          if (st?.statusType === 'DELIVERED' || st?.statusType === 'READ') break
        } catch {
          break // erro de rede na checagem não derruba um envio já aceito
        }
      }
      return { ok: true, wamid: `hs:${msgId}`, erro: null }
    }
    return { ok: false, wamid: null, erro: (data as any)?.message ?? `HTTP ${resp.status}` }
  } catch (e) {
    return { ok: false, wamid: null, erro: e instanceof Error ? e.message : 'erro de rede' }
  }
}

// Despacho do canal: OLIVIA_MESSAGING_PROVIDER=meta força Cloud API direta mesmo
// se o lead tiver thread no HubSpot. Default/rollback é HubSpot quando há thread,
// com fallback Meta para leads fora do inbox.
// A API pública de Conversas do HubSpot não expõe typing indicator nativo; por
// isso o canal ativo só usa pacing real antes do envio. A Cloud API da Meta já
// tem indicador em versões novas, mas este caminho é legado e aqui não temos o
// message_id inbound necessário para marcar como lido/digitando com segurança.
async function enviarPorCanal(
  lead: { hubspot_thread_id?: string | null },
  destino: string,
  texto: string,
  opts: Pick<PacingOpts, 'urgency'> = {},
): Promise<EnvioResultado> {
  const provider = currentMessagingProvider()
  const threadId = lead.hubspot_thread_id?.trim()
  const plan = buildReplyPacingPlan(texto, pacingOptsFromEnv(opts))
  const mensagens: EnvioParte[] = []
  if (plan.parts.length === 0) return { ok: false, wamid: null, erro: 'texto vazio', mensagens, provider }

  await sleep(plan.initialDelayMs)
  for (let i = 0; i < plan.parts.length; i++) {
    if (i > 0) await sleep(plan.betweenPartDelayMs[i - 1] ?? 0)
    const parte = plan.parts[i]
    const envio =
      provider === 'hubspot' && threadId
        ? await enviarTextoHubspot(threadId, parte)
        : await enviarTexto(destino, parte)
    if (!envio.ok) {
      return { ok: false, wamid: envio.wamid, erro: envio.erro, mensagens, provider }
    }
    mensagens.push({ texto: parte, wamid: envio.wamid })
  }

  return {
    ok: true,
    wamid: mensagens.map((m) => m.wamid).filter(Boolean).join(',') || null,
    erro: null,
    mensagens,
    provider,
  }
}

// Grava a mensagem de saída na memória (mesma tabela do inbound).
async function gravarSaida(
  supabase: Supabase,
  leadId: string,
  texto: string,
  wamid: string | null,
): Promise<void> {
  const { error } = await supabase.from('whatsapp_mensagens').insert({
    lead_id: leadId,
    direcao: 'out',
    wamid,
    tipo: 'text',
    corpo: texto,
  })
  if (error) console.error('olivia-responder: falha ao gravar saída', error.message)
}

async function gravarSaidas(
  supabase: Supabase,
  leadId: string,
  mensagens: EnvioParte[],
): Promise<void> {
  for (const mensagem of mensagens) {
    await gravarSaida(supabase, leadId, mensagem.texto, mensagem.wamid)
  }
}

async function aplicarEstado(
  supabase: Supabase,
  leadId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  const { error } = await supabase.from('leads').update(patch).eq('id', leadId)
  if (error) console.error('olivia-responder: falha ao atualizar estado', error.message)
}

// Resumo rolante (Fase 3): 1-2 frases do estado da conversa. Só usado em
// conversas longas (acima da janela de 40), pra não perder contexto antigo.
async function gerarResumo(
  mensagens: Array<{ role: string; content: string }>,
  model: string,
  apiKey: string,
): Promise<string | null> {
  const transcript = mensagens
    .map((m) => `${m.role === 'user' ? 'LEAD' : 'OLIVIA'}: ${m.content}`)
    .join('\n')
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Squad Olivia (resumo)' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 180,
      messages: [
        {
          role: 'system',
          content:
            'Resuma em 1-2 frases curtas (pt-BR) o estado desta conversa de WhatsApp entre a SDR Olivia ' +
            'e um lead: onde a conversa parou e o que falta pra agendar. NÃO invente. Responda só o resumo.',
        },
        { role: 'user', content: transcript },
      ],
    }),
  })
  if (!resp.ok) {
    console.error('olivia-responder: resumo HTTP', resp.status)
    return null
  }
  const data = await resp.json().catch(() => ({}))
  const txt = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
  return typeof txt === 'string' && txt.trim() ? txt.trim() : null
}

// Fase 3 — MEMÓRIA DA CONVERSA em background. Extrai os fatos que o LEAD declarou
// (anti-invenção) e mescla imutavelmente em leads.conversa_fatos; em conversas
// longas, também refaz o conversa_resumo. Roda via EdgeRuntime.waitUntil pra NÃO
// atrasar a resposta. Best-effort: qualquer falha só loga.
function agendarMemoria(
  supabase: Supabase,
  leadId: string,
  fatosAtuais: ConversaFatos | null,
  historico: Array<{ direcao: 'in' | 'out'; corpo: string | null; tipo?: string | null }>,
  apiKey: string,
  model: string,
): void {
  const tarefa = (async () => {
    try {
      const mensagens = historicoParaMensagens(historico)
      if (mensagens.length === 0) return
      const factsModel = Deno.env.get('OLIVIA_FACTS_MODEL') ?? model
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Squad Olivia (fatos)' },
        body: JSON.stringify(montarRequestFatos(mensagens, factsModel)),
      })
      if (!resp.ok) {
        console.error('olivia-responder: extração de fatos HTTP', resp.status)
        return
      }
      const novos = parseFatos(await resp.json())
      const patch: Record<string, unknown> = { conversa_fatos: mergeFatos(fatosAtuais, novos) }

      // Resumo rolante só em conversas longas (a janela de prompt é 40; abaixo
      // disso o histórico inteiro já está no prompt). Evita custo no caso comum.
      const minResumo = Number(Deno.env.get('OLIVIA_RESUMO_MIN') ?? '30')
      if (mensagens.length >= minResumo) {
        const resumo = await gerarResumo(mensagens, factsModel, apiKey)
        if (resumo) patch.conversa_resumo = resumo
      }
      await supabase.from('leads').update(patch).eq('id', leadId)
    } catch (e) {
      console.error('olivia-responder: memória da conversa falhou', e instanceof Error ? e.message : e)
    }
  })()
  try {
    ;(globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(tarefa)
  } catch {
    /* ambiente sem EdgeRuntime (teste) — ignora */
  }
}

// Impressão da rajada de inbound: "<qtd de mensagens 'in'>|<ts da última>". Muda
// sempre que o lead manda mais uma mensagem — é assim que o debounce percebe que
// ele ainda está digitando e adia a resposta até ele parar.
async function inboundFingerprint(supabase: Supabase, leadId: string): Promise<string> {
  const { data, count } = await supabase
    .from('whatsapp_mensagens')
    .select('enviada_em', { count: 'exact' })
    .eq('lead_id', leadId)
    .eq('direcao', 'in')
    .order('enviada_em', { ascending: false })
    .limit(1)
  return `${count ?? 0}|${data?.[0]?.enviada_em ?? ''}`
}

// Chama a olivia-agendar (Fase C) server-to-server, com o segredo interno.
// Devolve o JSON (com `mensagem`) ou null em falha de transporte.
async function chamarAgendar(
  secret: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: any } | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) return null
  try {
    const r = await fetch(`${supabaseUrl}/functions/v1/olivia-agendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret },
      body: JSON.stringify(body),
    })
    return { status: r.status, data: await r.json().catch(() => ({})) }
  } catch (e) {
    console.error('olivia-responder: falha ao chamar olivia-agendar', e instanceof Error ? e.message : e)
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  // Auth: segredo interno (webhook) OU usuário logado (teste manual).
  const triggerSecret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  const headerSecret = req.headers.get('x-olivia-secret')
  const autorizado =
    (!!triggerSecret && headerSecret === triggerSecret) || (await requireAuthenticatedUser(req))
  if (!autorizado) return json({ error: 'Não autorizado.' }, 401)

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) return json({ error: 'Falta OPENROUTER_API_KEY.' }, 500)
  const model = Deno.env.get('OLIVIA_MODEL') ?? DEFAULT_MODEL
  const dryRun = Deno.env.get('OLIVIA_DRY_RUN') !== 'false'

  let leadId: string
  let nudge = false // modo follow-up conversacional (cron olivia-nudge)
  let remarcar: 'pedir' | 'noshow' | 'definir' | null = null // mensagem de reschedule/no-show
  let novoHorarioLabel: string | null = null // rótulo do novo horário (modo 'definir')
  try {
    const body = await req.json()
    leadId = String(body.lead_id ?? '')
    nudge = (body as { nudge?: unknown }).nudge === true
    const rm = (body as { remarcar?: unknown }).remarcar
    if (rm === 'pedir' || rm === 'noshow' || rm === 'definir') remarcar = rm
    const lbl = (body as { novo_horario_label?: unknown }).novo_horario_label
    novoHorarioLabel = typeof lbl === 'string' && lbl.trim() ? lbl.trim() : null
    if (!leadId) return json({ error: 'Informe lead_id.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Rate limit global por minuto (teto de custo de LLM). Atômico via RPC
  // (migration 0013). Se a RPC não existir/der erro, NÃO bloqueia (degrada aberto
  // — o gate de auth + segredo já limita quem chama). Falha fechada só geraria
  // bloqueio total se o banco oscilar.
  const maxPorMin = Number(Deno.env.get('OLIVIA_MAX_POR_MIN') ?? '30')
  const bucket = new Date().toISOString().slice(0, 16) // 'YYYY-MM-DDTHH:MM'
  const { data: dentroLimite, error: rlErr } = await supabase.rpc('olivia_rate_hit', {
    p_bucket: bucket,
    p_max: maxPorMin,
  })
  if (rlErr) console.error('olivia-responder: rate_hit falhou (deixa passar)', rlErr.message)
  if (dentroLimite === false) {
    return json({ error: 'Limite de mensagens por minuto atingido.' }, 429)
  }

  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select('id, nome, dono_nome, setor, cidade, nome_genero, whatsapp_phone, whatsapp_status, whatsapp_dono, olivia_estado, olivia_slots, olivia_slots_at, hubspot_thread_id, hubspot_contact_id, hubspot_deal_id, hubspot_responsavel_contact_id, prospect_email, olivia_pending_slot_iso, conversa_fatos, conversa_resumo')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // --- Anti-resposta-dupla: trava por lead + debounce de rajada ---
  // Mensagens em sequência rápida ("minha chefe" + "pode chamar ela") disparam
  // invocações paralelas; sem trava, cada uma responde (parece robô). A trava é
  // CAS na coluna olivia_lock (migration 0019); quem perde sai — quem ganhou faz
  // o DEBOUNCE abaixo (espera o lead ficar quieto), então lê o histórico uma vez
  // e a resposta única cobre a rajada inteira. Trava velha (>90s) = órfã/roubável.
  const lockCutoff = new Date(Date.now() - 90_000).toISOString()
  const { data: lockRows, error: lockErr } = await supabase
    .from('leads')
    .update({ olivia_lock: new Date().toISOString() })
    .eq('id', leadId)
    .or(`olivia_lock.is.null,olivia_lock.lt.${lockCutoff}`)
    .select('id')
  if (lockErr) console.error('olivia-responder: lock falhou (segue sem trava)', lockErr.message)
  else if (!lockRows || lockRows.length === 0) {
    return json({ skipped: true, reason: 'outra resposta em andamento (lock)' })
  }
  const soltarLock = async () => {
    const { error } = await supabase.from('leads').update({ olivia_lock: null }).eq('id', leadId)
    if (error) console.error('olivia-responder: falha ao soltar lock', error.message)
  }
  // Janela de silêncio (debounce). Respeita OLIVIA_PACING=0 / dry-run / test pra
  // não atrasar os testes. OLIVIA_COALESCE_MS = quanto tempo de silêncio espera
  // antes de responder; OLIVIA_COALESCE_MAX_MS = teto total (custo + não segurar
  // o lock além dos 90s que o tornam órfão). A espera em si roda mais abaixo,
  // depois do gate de estado, só no fluxo normal (nudge/remarcar não debouncam).
  const pacingOff =
    Deno.env.get('OLIVIA_PACING') === '0' ||
    Deno.env.get('OLIVIA_TEST_MODE') === '1' ||
    Deno.env.get('DENO_ENV') === 'test' ||
    Deno.env.get('NODE_ENV') === 'test'
  const quietMs = dryRun || pacingOff ? 0 : envNumber('OLIVIA_COALESCE_MS', 7_000)
  const maxWaitMs = envNumber('OLIVIA_COALESCE_MAX_MS', 45_000)

  try {

  // Gate de estado: não responde quem está em optout/handoff/agendado. Os modos
  // nudge/remarcar são acionados por orquestrador (não por inbound) e têm suas
  // próprias regras de elegibilidade — passam direto pelo gate.
  if (!nudge && !remarcar && !deveResponder(lead.olivia_estado)) {
    return json({ skipped: true, reason: `estado=${lead.olivia_estado}` })
  }

  const destino = lead.whatsapp_dono?.trim() || lead.whatsapp_phone
  if (!destino) return json({ error: 'Lead sem número de destino.' }, 422)

  // --- DEBOUNCE de rajada: espera o lead PARAR de mandar antes de responder ---
  // Sem isto, 3 mensagens seguidas ("oi" / "tudo bem?" / "queria saber do preço")
  // viram 3 respostas (robótico), ou a Olivia responde só à 1ª e perde o resto.
  // Espera `quietMs` de silêncio; CADA mensagem nova reinicia a janela. Um teto
  // (`maxWaitMs`) limita o tempo total. Quem perde o lock (as invocações das
  // outras mensagens da rajada) já saiu lá em cima — esta, dona do lock, fica
  // observando a tabela e só responde quando o lead fica quieto, cobrindo tudo.
  // Só no fluxo normal: nudge/remarcar já retornam antes de chegar aqui.
  if (!nudge && !remarcar && quietMs > 0) {
    const inicioEspera = Date.now()
    let fp = await inboundFingerprint(supabase, leadId)
    while (true) {
      await sleep(quietMs)
      const fp2 = await inboundFingerprint(supabase, leadId)
      if (fp2 === fp) break // silêncio: o lead parou → responde cobrindo a rajada
      fp = fp2 // chegou mensagem nova → reinicia a janela de silêncio
      if (Date.now() - inicioEspera >= maxWaitMs) break // teto de espera
      // Renova o lock pra não virar órfão (>90s) numa rajada longa.
      await supabase.from('leads').update({ olivia_lock: new Date().toISOString() }).eq('id', leadId)
    }
  }

  // Histórico cronológico (a tabela já existe — migration 0011).
  const { data: historico, error: histErr } = await supabase
    .from('whatsapp_mensagens')
    .select('direcao, corpo, enviada_em, tipo, wamid')
    .eq('lead_id', leadId)
    .order('enviada_em', { ascending: true })
    .limit(40)
  // Erro de DB aqui não pode virar "sem mensagens" silencioso (mascararia falha
  // real): aborta explícito em vez de seguir como se não houvesse histórico.
  if (histErr) {
    console.error('olivia-responder: falha ao carregar histórico', histErr.message)
    return json({ error: 'Falha ao carregar histórico da conversa.' }, 502)
  }

  // --- MODO NUDGE: follow-up conversacional de chat que esfriou ---
  // Chamado pelo cron olivia-nudge. Aqui a última mensagem É da Olivia (cliente
  // sumiu) — o oposto do fluxo normal. Só manda mensagem LIVRE dentro da janela
  // de 24h do WhatsApp; fora disso, pula (cabe ao template squad_followup_1).
  if (nudge) {
    const histNudge = historico ?? []
    const ultimaMsg = histNudge[histNudge.length - 1]
    const ultimoInbound = [...histNudge].reverse().find((m) => m.direcao === 'in')
    if (!ultimoInbound) return json({ skipped: true, reason: 'nudge: chat sem inbound (não é conversa)' })
    if (ultimaMsg?.direcao !== 'out') return json({ skipped: true, reason: 'nudge: última msg não é da Olivia' })
    const lastInMs = Date.parse(ultimoInbound.enviada_em)
    if (!podeMensagemLivre(lastInMs, Date.now())) {
      // Fora da janela de 24h: mensagem livre seria bloqueada pelo WhatsApp →
      // precisa de template (squad_followup_1). Não envia aqui.
      return json({ skipped: true, reason: 'nudge: fora da janela de 24h (precisa de template)' })
    }
    const promptNudge = construirSystemPrompt(lead, descreverAgora(Date.now()))
    const msgsNudge = historicoParaMensagens(histNudge)
    msgsNudge.push({
      role: 'user',
      content:
        '[INSTRUÇÃO INTERNA, não é mensagem do cliente: o cliente não respondeu há cerca de um dia. ' +
        'Escreva UMA mensagem curta, calorosa e natural pra retomar a conversa de onde ela parou, ' +
        'SEM repetir o que você já disse e sem soar robótica ou ansiosa. Puxe com leveza pro próximo ' +
        'passo. Não use ferramentas — responda só com o texto da mensagem.]',
    })
    let acaoNudge: OliviaAcao
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Squad Olivia' },
        body: JSON.stringify(montarRequest(promptNudge, msgsNudge, model)),
      })
      if (!resp.ok) {
        await registrarErro(supabase, { fonte: 'olivia-nudge', leadId, mensagem: `LLM HTTP ${resp.status} no nudge` })
        return json({ error: `LLM HTTP ${resp.status}` }, 502)
      }
      acaoNudge = interpretarResposta(await resp.json())
    } catch (e) {
      await registrarErro(supabase, { fonte: 'olivia-nudge', leadId, mensagem: 'Falha no LLM do nudge', contexto: { erro: e instanceof Error ? e.message : String(e) } })
      return json({ error: 'Falha ao chamar o LLM.' }, 502)
    }
    const textoNudge = (acaoNudge as { texto?: string | null }).texto ?? null
    if (!textoNudge) return json({ skipped: true, reason: 'nudge: LLM não gerou texto', acao: acaoNudge.tipo })
    if (dryRun) return json({ nudge: true, dry_run: true, texto_que_enviaria: textoNudge })
    const envNudge = await enviarPorCanal(lead, destino, textoNudge)
    if (envNudge.mensagens.length > 0) await gravarSaidas(supabase, leadId, envNudge.mensagens)
    await aplicarEstado(supabase, leadId, { olivia_nudge_em: new Date().toISOString() })
    return json({ nudge: true, enviado: envNudge.ok, erro_envio: envNudge.erro ?? null })
  }

  // --- MODO REMARCAR: mensagem de reschedule / no-show / confirmação ---
  // Chamado pela olivia-remarcar (manual) ou olivia-noshow (auto). O calendário e
  // o estado já foram tratados por quem chamou; aqui só geramos+enviamos a
  // mensagem natural ao cliente. Não toca olivia_estado.
  if (remarcar) {
    // Janela de 24h do WhatsApp: sem inbound recente, mensagem livre é bloqueada.
    // Pula com motivo claro (o orquestrador/UI mostra; >24h pede template).
    const ultInboundRm = [...(historico ?? [])].reverse().find((m) => m.direcao === 'in')
    if (!ultInboundRm || !podeMensagemLivre(Date.parse(ultInboundRm.enviada_em), Date.now())) {
      return json({ remarcar, skipped: true, reason: 'fora da janela de 24h do WhatsApp (precisa de template)' })
    }
    const instrucaoPorMotivo: Record<string, string> = {
      pedir:
        'Você precisa REMARCAR a reunião já combinada com o cliente. Mande UMA mensagem curta, ' +
        'leve e natural avisando que precisa remarcar e perguntando qual novo dia e horário fica ' +
        'bom pra ele. Não invente horário, não soe robótica, não peça desculpas em excesso.',
      noshow:
        'O cliente NÃO apareceu na call que estava agendada. Mande UMA mensagem curta, gentil e SEM ' +
        'cobrança/culpa, dizendo que não conseguiu encontrá-lo no horário e perguntando se quer ' +
        'remarcar — e qual horário fica melhor. Tom acolhedor, nada passivo-agressivo.',
      definir:
        'A reunião foi REMARCADA para: ' + (novoHorarioLabel ?? '(novo horário)') + '. Confirme isso ' +
        'com o cliente em UMA mensagem curta e natural, usando EXATAMENTE esse horário, e diga que ' +
        'mandou o novo convite. Não invente outro horário.',
    }
    const promptRm = construirSystemPrompt(lead, descreverAgora(Date.now()))
    const msgsRm = historicoParaMensagens(historico ?? [])
    msgsRm.push({ role: 'user', content: '[INSTRUÇÃO INTERNA, não é mensagem do cliente: ' + instrucaoPorMotivo[remarcar] + ' Não use ferramentas — responda só com o texto.]' })
    let acaoRm: OliviaAcao
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Squad Olivia' },
        body: JSON.stringify(montarRequest(promptRm, msgsRm, model)),
      })
      if (!resp.ok) {
        await registrarErro(supabase, { fonte: 'olivia-remarcar', leadId, mensagem: `LLM HTTP ${resp.status} no remarcar (${remarcar})` })
        return json({ error: `LLM HTTP ${resp.status}` }, 502)
      }
      acaoRm = interpretarResposta(await resp.json())
    } catch (e) {
      await registrarErro(supabase, { fonte: 'olivia-remarcar', leadId, mensagem: `Falha no LLM do remarcar (${remarcar})`, contexto: { erro: e instanceof Error ? e.message : String(e) } })
      return json({ error: 'Falha ao chamar o LLM.' }, 502)
    }
    const textoRm = (acaoRm as { texto?: string | null }).texto ?? null
    if (!textoRm) return json({ skipped: true, reason: 'remarcar: LLM não gerou texto' })
    if (dryRun) return json({ remarcar, dry_run: true, texto_que_enviaria: textoRm })
    const envRm = await enviarPorCanal(lead, destino, textoRm)
    if (envRm.mensagens.length > 0) await gravarSaidas(supabase, leadId, envRm.mensagens)
    return json({ remarcar, enviado: envRm.ok, erro_envio: envRm.erro ?? null })
  }

  // Idempotência / anti-spam: se a última mensagem já é da Olivia (out), não há
  // nada novo pra responder — evita resposta dupla em re-invocação/trigger duplo.
  const ultima = historico?.[historico.length - 1]
  if (ultima && ultima.direcao === 'out') {
    return json({ skipped: true, reason: 'última mensagem já é da Olivia (sem inbound novo)' })
  }

  // Rede de segurança p/ MÍDIA que a Olivia não consegue ler. Áudio é transcrito
  // na ingestão (webhook) e imagem/PDF passam por OCR; quando isso FALHA (sem
  // chave do provedor / erro / outra mídia), o corpo fica vazio. Antes a Olivia
  // pulava e ficava muda — ou pior, respondia ao contexto velho (bug relatado).
  // Agora historicoParaMensagens injeta um placeholder ("[a pessoa enviou um
  // áudio que não consegui ouvir]") como último turno do lead, e a Olivia
  // reconhece a mídia e pede pra reenviar. Só pulamos quando NEM placeholder dá
  // pra montar (tipo desconhecido): aí silêncio é mais seguro que chutar.
  if (
    ultima &&
    ultima.direcao === 'in' &&
    !(ultima.corpo ?? '').trim() &&
    !placeholderMidia(ultima.tipo)
  ) {
    return json({ skipped: true, reason: 'última mensagem é mídia sem texto e sem placeholder' })
  }

  // --- Anti-duplicata POR MENSAGEM (wamid): CLAIM atômico do inbound a responder.
  // Fecha o buraco do guard "última msg é out" quando a gravação da saída atrasa/
  // falha (visto em prod): se este wamid já foi reivindicado (re-trigger, echo do
  // HubSpot, retry de webhook, invocação manual), PULA — a Olivia nunca responde a
  // mesma mensagem duas vezes. Aqui `ultima` já é o último inbound (out retornou acima).
  const inboundWamid = ultima?.direcao === 'in' ? ((ultima as { wamid?: string | null }).wamid ?? null) : null
  if (inboundWamid && !dryRun) {
    const { data: claimed, error: claimErr } = await supabase.rpc('olivia_claim_inbound', {
      p_lead: leadId,
      p_wamid: inboundWamid,
    })
    if (claimErr) console.error('olivia-responder: claim inbound falhou (segue sem dedup)', claimErr.message)
    else if (claimed === false) {
      return json({ skipped: true, reason: 'inbound já respondido (dedup por wamid)' })
    }
  }

  const ultimaDoLead = [...(historico ?? [])].reverse().find((m) => m.direcao === 'in')

  // --- Guardrail: opt-out determinístico ANTES do LLM (LGPD) ---
  // Persiste o opt-out só fora do dry-run (dry-run é read-only: só reporta).
  if (detectarOptout(ultimaDoLead?.corpo)) {
    if (!dryRun) await aplicarEstado(supabase, leadId, { olivia_estado: 'optout' })
    return json({ acao: 'optout', via: 'guardrail', dry_run: dryRun })
  }

  // --- Guardrail: número do responsável → registra o dono DIRETO (sem o LLM) ---
  // O lead passa o WhatsApp do responsável — como cartão ("[Contato compartilhado:
  // +55 ...]") OU digitado quase sozinho ("11 98549-5275", "Falar com Edson 119..").
  // Visto em produção: o LLM ora registrava, ora re-perguntava com o número na tela
  // (inconsistente) — e com ruído na conversa (auto-resposta do próprio negócio)
  // chegava a ignorar o cartão. Determinístico como o opt-out: havendo um número BR
  // válido, vai direto pro registrar_dono (cria o contato + dispara a 1ª mensagem).
  let acaoForcada: OliviaAcao | null = null
  const dddLead = extrairDddBr(lead.whatsapp_phone) ?? extrairDddBr(lead.whatsapp_dono)
  const numDono = extrairNumeroDono(ultimaDoLead?.corpo, dddLead)
  if (numDono) acaoForcada = { tipo: 'registrar_dono', texto: null, numero: numDono, nome: null }

  const emailDoLead = extrairEmail(ultimaDoLead?.corpo)
  const slotPendente = typeof lead.olivia_pending_slot_iso === 'string'
    ? lead.olivia_pending_slot_iso
    : null

  if (emailDoLead && !lead.prospect_email && !dryRun) {
    await aplicarEstado(supabase, leadId, { prospect_email: emailDoLead })
  }

  // --- Horário comercial: fora do expediente, ADIA (não responde de madrugada —
  // denuncia o bot). Opt-in via OLIVIA_HORARIO=1. Marca olivia_reply_apos = próxima
  // abertura; a olivia-flush re-invoca quando o expediente abrir (e a resposta é
  // composta lá, com o contexto da noite toda — sem pagar LLM agora). Opt-out já
  // foi tratado acima (LGPD não espera horário). Dry-run só reporta. ---
  if (Deno.env.get('OLIVIA_HORARIO') === '1') {
    const hOpts = {
      inicio: Number(Deno.env.get('OLIVIA_HORARIO_INICIO') ?? '9'),
      fim: Number(Deno.env.get('OLIVIA_HORARIO_FIM') ?? '19'),
      tz: Deno.env.get('OLIVIA_HORARIO_TZ') ?? 'America/Sao_Paulo',
    }
    const agoraIso = new Date().toISOString()
    if (!dentroDoHorario(agoraIso, hOpts)) {
      const replyApos = proximaAbertura(agoraIso, hOpts)
      if (!dryRun) await aplicarEstado(supabase, leadId, { olivia_reply_apos: replyApos })
      return json({ deferred: true, reply_apos: replyApos, dry_run: dryRun })
    }
  }

  if (slotPendente && emailDoLead && mensagemApenasEmail(ultimaDoLead?.corpo, emailDoLead)) {
    if (dryRun) {
      return json({
        dry_run: true,
        acao: 'confirmar_email_pendente',
        slot_iso: slotPendente,
        email_detectado: emailDoLead,
      })
    }

    const r = await chamarAgendar(triggerSecret ?? '', {
      lead_id: leadId,
      modo: 'confirmar',
      slot_iso: slotPendente,
      prospect_email: emailDoLead,
    })
    if (!r || r.status >= 400) {
      await aplicarEstado(supabase, leadId, {
        olivia_estado: 'handoff',
        olivia_handoff_motivo: 'confirmar email: falha ao criar/retomar evento',
      })
      return json({ acao: 'confirmar_email_pendente', erro: 'falha ao confirmar', via: 'agenda' }, 502)
    }
    if (r.data?.aviso_divergencia) {
      console.error('olivia-responder: agendamento com divergência Calendar×DB', leadId, r.data.aviso_divergencia)
    }
    const corpo = String(r.data?.mensagem ?? '').trim()
    let env: EnvioResultado | null = null
    if (corpo) {
      env = await enviarPorCanal(lead, destino, corpo, { urgency: 'system' })
      if (env.mensagens.length > 0) await gravarSaidas(supabase, leadId, env.mensagens)
    }
    return json({
      acao: 'confirmar_email_pendente',
      enviado: env?.ok ?? false,
      erro_envio: env?.erro ?? null,
      via: 'agenda',
    })
  }

  // --- Ação: cartão de contato (determinístico) OU LLM ---
  // Passa "agora" (fuso de Brasília) pro prompt: Olivia resolve hoje/amanhã/semana
  // que vem com base na hora real do envio.
  let acao: OliviaAcao
  if (acaoForcada) {
    // Cartão de contato detectado acima → registra o dono direto, sem gastar LLM.
    acao = acaoForcada
  } else {
    const systemPrompt = construirSystemPrompt(lead, descreverAgora(Date.now()))
    const mensagens = historicoParaMensagens(historico ?? [])
    if (mensagens.length === 0) {
      return json({ skipped: true, reason: 'sem mensagens de texto no histórico' })
    }
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Squad Olivia',
        },
        body: JSON.stringify(montarRequest(systemPrompt, mensagens, model)),
      })
      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '')
        await registrarErro(supabase, {
          fonte: 'olivia-responder',
          leadId,
          mensagem: `LLM retornou HTTP ${resp.status}`,
          contexto: { model, detalhe: errTxt.slice(0, 300) },
        })
        return json({ error: `LLM HTTP ${resp.status}` }, 502)
      }
      acao = interpretarResposta(await resp.json())
    } catch (e) {
      await registrarErro(supabase, {
        fonte: 'olivia-responder',
        leadId,
        mensagem: 'Falha ao chamar o LLM',
        contexto: { model, erro: e instanceof Error ? e.message : String(e) },
      })
      return json({ error: 'Falha ao chamar o LLM.' }, 502)
    }
  }

  // --- Executa a ação ---
  const textoParaEnviar =
    acao.tipo === 'responder'
      ? acao.texto
      : (acao as { texto?: string | null }).texto ?? null

  // DRY-RUN: devolve a ação sem enviar nem mudar estado terminal.
  if (dryRun) {
    return json({ dry_run: true, acao, texto_que_enviaria: textoParaEnviar, model })
  }

  // Fase 3 — MEMÓRIA: extrai/mescla os fatos desta conversa em background (não
  // bloqueia a resposta). Roda em todo turno real (qualquer ação), nunca em
  // dry-run. mergeFatos é idempotente, então re-extrair o histórico não duplica.
  agendarMemoria(
    supabase,
    leadId,
    (lead.conversa_fatos as ConversaFatos | null) ?? null,
    historico ?? [],
    apiKey,
    model,
  )

  // --- Ignorar: a última mensagem não pede resposta (engano, figurinha solta,
  // assunto alheio). Não envia nada e não muda estado — silêncio deliberado é
  // mais natural que responder. ---
  if (acao.tipo === 'ignorar') {
    return json({ acao: 'ignorar', motivo: acao.motivo, enviado: false })
  }

  // --- Fase C: agendamento delega pra olivia-agendar (que fala com o Calendar) ---
  // A mensagem a enviar nesses casos vem da olivia-agendar (horários reais da
  // agenda / confirmação com link do Meet), nunca do LLM (anti-invenção).
  if (acao.tipo === 'agendar' || acao.tipo === 'confirmar' || acao.tipo === 'sugerir_horario') {
    const segredo = triggerSecret ?? ''
    let agendaMsg: string | null = null
    let estadoAgenda: string | null = null

    if (acao.tipo === 'agendar') {
      // Passa o que o lead disse sobre QUANDO pode (resumo_disponibilidade) pra a
      // agenda respeitar adiamentos: "semana que vem", "em duas semanas", etc.
      const r = await chamarAgendar(segredo, { lead_id: leadId, modo: 'propor', janela_texto: acao.resumo || null })
      if (!r || r.status >= 400) {
        await aplicarEstado(supabase, leadId, { olivia_estado: 'handoff', olivia_handoff_motivo: 'agendar: falha ao propor horários' })
        return json({ acao: 'agendar', erro: 'falha ao propor horários', via: 'agenda' }, 502)
      }
      agendaMsg = r.data?.mensagem ?? null
      estadoAgenda = 'agendando'
    } else if (acao.tipo === 'confirmar') {
      // confirmar: opção (1-based) → slot guardado no lead. Cada slot pode ser
      // string (formato antigo) ou {iso, reps} (multi-rep) — extrai o ISO.
      const slots: unknown[] = Array.isArray(lead.olivia_slots) ? lead.olivia_slots : []
      const slotSel = slots[acao.opcao - 1] as string | { iso?: string } | undefined
      const slotIso = typeof slotSel === 'string' ? slotSel : slotSel?.iso
      const expirado = slotsExpirados(lead.olivia_slots_at, Date.parse(new Date().toISOString()))
      if (!slotIso || expirado) {
        // Opção inexistente OU proposta velha → re-propõe em vez de marcar errado.
        const r = await chamarAgendar(segredo, { lead_id: leadId, modo: 'propor' })
        agendaMsg = r?.data?.mensagem ?? 'Deixa eu te passar os horários de novo.'
        estadoAgenda = 'agendando'
      } else {
        const emailAgenda = emailDoLead ?? lead.prospect_email ?? null
        const r = await chamarAgendar(segredo, {
          lead_id: leadId,
          modo: 'confirmar',
          slot_iso: slotIso,
          ...(emailAgenda ? { prospect_email: emailAgenda } : {}),
        })
        if (!r || r.status >= 400) {
          await aplicarEstado(supabase, leadId, { olivia_estado: 'handoff', olivia_handoff_motivo: 'confirmar: falha ao criar evento' })
          return json({ acao: 'confirmar', erro: 'falha ao confirmar', via: 'agenda' }, 502)
        }
        if (r.data?.aviso_divergencia) {
          console.error('olivia-responder: agendamento com divergência Calendar×DB', leadId, r.data.aviso_divergencia)
        }
        agendaMsg = r.data?.mensagem ?? null
        estadoAgenda = null // a olivia-agendar já marcou 'agendado' + status
      }
    } else {
      const r = await chamarAgendar(segredo, {
        lead_id: leadId,
        modo: 'sugerido',
        ...(acao.slot_iso ? { slot_iso: acao.slot_iso } : {}),
        sugestao_texto: acao.texto_original,
        ...((emailDoLead ?? lead.prospect_email) ? { prospect_email: emailDoLead ?? lead.prospect_email } : {}),
      })
      if (!r || r.status >= 400) {
        await aplicarEstado(supabase, leadId, {
          olivia_estado: 'handoff',
          olivia_handoff_motivo: 'sugerido: falha ao validar/criar evento',
        })
        return json({ acao: 'sugerir_horario', erro: 'falha ao validar horário sugerido', via: 'agenda' }, 502)
      }
      if (r.data?.aviso_divergencia) {
        console.error('olivia-responder: agendamento com divergência Calendar×DB', leadId, r.data.aviso_divergencia)
      }
      agendaMsg = r.data?.mensagem ?? null
      estadoAgenda = r.data?.agendado ? null : 'agendando'
    }

    // Prefixo opcional do LLM ("Que ótimo!") + a mensagem autoritativa da agenda.
    const corpo = [acao.texto, agendaMsg].filter(Boolean).join('\n\n').trim()
    let env: EnvioResultado | null = null
    if (corpo) {
      env = await enviarPorCanal(lead, destino, corpo, { urgency: 'system' })
      if (env.mensagens.length > 0) await gravarSaidas(supabase, leadId, env.mensagens)
    }
    if (estadoAgenda) await aplicarEstado(supabase, leadId, { olivia_estado: estadoAgenda })
    if (acao.tipo === 'agendar' && env?.ok) {
      queueHubspotDealStageSync(
        lead.hubspot_deal_id,
        HUBSPOT_STAGE_REUNIAO_PROPOSTA,
        'olivia-responder:agendar',
      )
    }
    return json({ acao: acao.tipo, enviado: env?.ok ?? false, erro_envio: env?.erro ?? null, via: 'agenda' })
  }

  // --- Indicação do dono: registra o número e dispara a 1ª mensagem oficial ---
  // Não sobrescreve o contato original do HubSpot: cria/reusa um contato separado
  // para o responsável, associa ao negócio e enfileira o workflow nele.
  if (acao.tipo === 'registrar_dono') {
    // Completa número local sem DDD ("fala com o Nelson no 981059699") usando a
    // praça do próprio lead (o número dele já é da mesma região). escolherNumeroBr
    // também lida com CARTÃO de contato multi-número (vários números/IDs da Meta
    // numa string só): extrai o BR certo (preferindo o DDD da praça) em vez de
    // falhar e jogar a conversa pro handoff.
    const dddLead = extrairDddBr(lead.whatsapp_phone) ?? extrairDddBr(lead.whatsapp_dono)
    const numero = escolherNumeroBr(acao.numero, dddLead)
    if (!numero) {
      await aplicarEstado(supabase, leadId, {
        olivia_estado: 'handoff',
        olivia_handoff_motivo: `registrar_dono: número não reconhecido (${acao.numero})`,
      })
      return json({ acao: 'registrar_dono', erro: 'número inválido', via: 'handoff' })
    }

    const patchLead: Record<string, unknown> = { whatsapp_dono: numero }
    if (acao.nome && !lead.dono_nome?.trim()) patchLead.dono_nome = acao.nome
    await aplicarEstado(supabase, leadId, patchLead)

    let workflowDisparado = false
    let disparoProvider: OliviaMessagingProvider | null = null
    let metaIntroErro: string | null = null
    const provider = currentMessagingProvider()
    if (provider === 'meta') {
      if (!lead.nome?.trim() || !lead.cidade?.trim()) {
        metaIntroErro = 'lead sem nome/cidade para template'
      } else {
        const metaLead: SendableLead = {
          nome: lead.nome,
          setor: lead.setor,
          cidade: lead.cidade,
          whatsapp_phone: numero,
          whatsapp_status: 'found',
          nome_genero: lead.nome_genero,
        }
        const intro = await enviarTemplateIntroMeta(metaLead, numero)
        if (intro.ok) {
          workflowDisparado = true
          disparoProvider = 'meta'
          await gravarSaida(supabase, leadId, `[template:${intro.template}]`, intro.wamid)
          await aplicarEstado(supabase, leadId, {
            whatsapp_msg_id: intro.wamid,
            whatsapp_send_status: 'sent',
          })
        } else {
          metaIntroErro = intro.erro
          console.error('olivia-responder: registrar_dono envio Meta falhou', intro.erro)
        }
      }
    }
    let responsavelContactId: string | null = null
    let responsavelAssociadoDeal = false
    const hsToken = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')
    if (hsToken) {
      try {
        const responsavel = await ensureResponsibleHubspotContact(
          hsToken,
          {
            numero,
            nome: acao.nome,
            lead: {
              nome: lead.nome,
              setor: lead.setor,
              cidade: lead.cidade,
              nome_genero: lead.nome_genero,
              hubspot_contact_id: lead.hubspot_contact_id,
              hubspot_deal_id: lead.hubspot_deal_id,
            },
          },
          'olivia-responder:registrar_dono',
        )
        responsavelContactId = responsavel.contactId
        responsavelAssociadoDeal = responsavel.associatedToDeal
        if (provider === 'hubspot') {
          workflowDisparado = responsavel.workflowQueued
          disparoProvider = responsavel.workflowQueued ? 'hubspot' : null
        }
        await aplicarEstado(supabase, leadId, { hubspot_responsavel_contact_id: responsavelContactId })
      } catch (e) {
        console.error('olivia-responder: registrar_dono contato responsável erro', e instanceof Error ? e.message : e)
      }
    } else if (provider === 'hubspot') {
      console.error('olivia-responder: registrar_dono sem HUBSPOT_PRIVATE_APP_TOKEN')
    }
    if (!workflowDisparado) {
      // Sem disparo automático → vira tarefa humana (a promessa não pode ficar no ar).
      await aplicarEstado(supabase, leadId, {
        olivia_estado: 'handoff',
        olivia_handoff_motivo: `dono indicado (${acao.nome ?? 'sem nome'}, ${numero}) — contatar manualmente${metaIntroErro ? `; Meta: ${metaIntroErro}` : ''}`,
      })
    }

    // Resposta ao chat ORIGINAL (quem compartilhou o contato). O caminho do LLM
    // costuma trazer um texto de agradecimento; mas o GUARDRAIL determinístico
    // (cartão de contato) força registrar_dono com texto=null — então, quando o
    // disparo ao dono saiu, mandamos um agradecimento PADRÃO pra não deixar quem
    // indicou no vácuo (bug relatado: "compartilhei o contato e não recebi nada").
    // Sem disparo (handoff), não enviamos — um humano assume e não prometemos contato.
    const ackDono = acao.nome?.trim()
      ? `Perfeito, obrigada! Já falo com ${acao.nome.trim()} então. 😊`
      : 'Perfeito, obrigada pela indicação! Já entro em contato com a pessoa então. 😊'
    const textoChat = acao.texto ?? (workflowDisparado ? ackDono : null)
    let env: EnvioResultado | null = null
    if (textoChat) {
      env = await enviarPorCanal(lead, destino, textoChat)
      if (env.mensagens.length > 0) await gravarSaidas(supabase, leadId, env.mensagens)
    }
    queueHubspotDealStageSync(
      lead.hubspot_deal_id,
      HUBSPOT_STAGE_LOCALIZAR_RESPONSAVEL,
      'olivia-responder:registrar_dono',
      workflowDisparado ? 15_000 : 0,
    )
    await aplicarEstado(supabase, leadId, { olivia_reply_apos: null, olivia_estado: workflowDisparado ? 'conversando' : 'handoff' })
    return json({
      acao: 'registrar_dono',
      numero,
      nome: acao.nome,
      responsavel_contact_id: responsavelContactId,
      responsavel_associado_deal: responsavelAssociadoDeal,
      workflow_disparado: workflowDisparado,
      provider: disparoProvider,
      meta_intro_erro: metaIntroErro,
      enviado: env?.ok ?? false,
    })
  }

  // Envio real (texto livre — janela de 24h aberta pela resposta do lead).
  let enviado: EnvioResultado | null = null
  if (textoParaEnviar) {
    enviado = await enviarPorCanal(lead, destino, textoParaEnviar)
    if (enviado.mensagens.length > 0) await gravarSaidas(supabase, leadId, enviado.mensagens)
  }

  // Atualiza estado + campos da ação. Limpa olivia_reply_apos: respondeu agora
  // (dentro do horário), então não há resposta adiada pendente.
  const patch: Record<string, unknown> = { olivia_reply_apos: null }
  const novoEstado = estadoAposAcao(acao)
  if (novoEstado) patch.olivia_estado = novoEstado
  if (acao.tipo === 'handoff') patch.olivia_handoff_motivo = acao.motivo
  await aplicarEstado(supabase, leadId, patch)

  return json({
    acao: acao.tipo,
    enviado: enviado?.ok ?? false,
    erro_envio: enviado?.erro ?? null,
    estado: novoEstado,
    model,
  })
  } finally {
    await soltarLock()
  }
})
