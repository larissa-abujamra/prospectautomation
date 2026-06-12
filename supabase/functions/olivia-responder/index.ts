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
//   OLIVIA_PACING=0               (opcional; desliga o atraso humano antes de enviar)
//   OLIVIA_HORARIO=1              (opcional; liga o horário comercial, adia inbound
//                                  fora do expediente. Defaults: seg-sex 9-19 BRT,
//                                  override por OLIVIA_HORARIO_INICIO/FIM/TZ)
//   WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN / WHATSAPP_GRAPH_VERSION
//     (mesmos do enviar-whatsapp; necessários só fora do dry-run)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  construirSystemPrompt,
  detectarOptout,
  deveResponder,
  estadoAposAcao,
  historicoParaMensagens,
  interpretarResposta,
  montarRequest,
  normalizarNumeroBr,
  type OliviaAcao,
} from '../_shared/olivia_brain.ts'
import { slotsExpirados } from '../_shared/olivia_agenda.ts'
import { pacingDelayMs } from '../_shared/olivia_pacing.ts'
import { dentroDoHorario, proximaAbertura } from '../_shared/olivia_horario.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import {
  acharSenderActor,
  extractInbound,
  montarEnvioHubspot,
} from '../_shared/hubspot_conversations.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Default por TIER (qualidade conversacional), sobrescrevível por env OLIVIA_MODEL.
// OpenRouter exige um id concreto E que a conta tenha acesso ao modelo — testado
// nesta conta: claude-sonnet-4 responde; claude-3.5/3.7-sonnet dão 404 (sem acesso).
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4'

type Supabase = ReturnType<typeof createClient>

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
  // Pacing humano: espera proporcional ao tamanho (simula ler + digitar) antes de
  // enviar. É espera ociosa — não consome CPU. Configurável por env; OLIVIA_PACING=0
  // desliga (ex.: testes de transcript em que o atraso só atrapalha).
  const pacingOn = Deno.env.get('OLIVIA_PACING') !== '0'
  if (pacingOn) {
    const espera = pacingDelayMs(texto)
    await new Promise((r) => setTimeout(r, espera))
  }
  try {
    const resp = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/\D/g, ''),
        type: 'text',
        text: { preview_url: false, body: texto },
      }),
    })
    const data = await resp.json().catch(() => ({}))
    const wamid = (data as any)?.messages?.[0]?.id ?? null
    if (resp.ok && wamid) return { ok: true, wamid: String(wamid), erro: null }
    return { ok: false, wamid: null, erro: (data as any)?.error?.message ?? `HTTP ${resp.status}` }
  } catch (e) {
    return { ok: false, wamid: null, erro: e instanceof Error ? e.message : 'erro de rede' }
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

  const pacingOn = Deno.env.get('OLIVIA_PACING') !== '0'
  if (pacingOn) {
    await new Promise((r) => setTimeout(r, pacingDelayMs(texto)))
  }

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

// Despacho do canal: lead com thread no inbox → HubSpot; senão → Cloud API
// direta (caminho legado, segue funcionando para leads fora do HubSpot).
async function enviarPorCanal(
  lead: { hubspot_thread_id?: string | null },
  destino: string,
  texto: string,
): Promise<{ ok: boolean; wamid: string | null; erro: string | null }> {
  const threadId = lead.hubspot_thread_id?.trim()
  if (threadId) return enviarTextoHubspot(threadId, texto)
  return enviarTexto(destino, texto)
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

async function aplicarEstado(
  supabase: Supabase,
  leadId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  const { error } = await supabase.from('leads').update(patch).eq('id', leadId)
  if (error) console.error('olivia-responder: falha ao atualizar estado', error.message)
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
  try {
    const body = await req.json()
    leadId = String(body.lead_id ?? '')
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
    .select('id, nome, dono_nome, setor, cidade, nome_genero, whatsapp_phone, whatsapp_dono, olivia_estado, olivia_slots, olivia_slots_at, hubspot_thread_id, hubspot_contact_id')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // --- Anti-resposta-dupla: trava por lead + coalescência de rajada ---
  // Mensagens em sequência rápida ("minha chefe" + "pode chamar ela") disparam
  // invocações paralelas; sem trava, cada uma responde (parece robô). A trava é
  // CAS na coluna olivia_lock (migration 0019); quem perde sai — quem ganhou
  // espera alguns segundos ANTES de ler o histórico, então a resposta única
  // cobre a rajada inteira. Trava velha (>90s) é considerada órfã e roubável.
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
  // Coalescência: respeita OLIVIA_PACING=0 (testes) para não atrasar.
  if (Deno.env.get('OLIVIA_PACING') !== '0') {
    await new Promise((r) => setTimeout(r, 8_000))
  }

  try {

  // Gate de estado: não responde quem está em optout/handoff/agendado.
  if (!deveResponder(lead.olivia_estado)) {
    return json({ skipped: true, reason: `estado=${lead.olivia_estado}` })
  }

  const destino = lead.whatsapp_dono?.trim() || lead.whatsapp_phone
  if (!destino) return json({ error: 'Lead sem número de destino.' }, 422)

  // Histórico cronológico (a tabela já existe — migration 0011).
  const { data: historico, error: histErr } = await supabase
    .from('whatsapp_mensagens')
    .select('direcao, corpo, enviada_em')
    .eq('lead_id', leadId)
    .order('enviada_em', { ascending: true })
    .limit(40)
  // Erro de DB aqui não pode virar "sem mensagens" silencioso (mascararia falha
  // real): aborta explícito em vez de seguir como se não houvesse histórico.
  if (histErr) {
    console.error('olivia-responder: falha ao carregar histórico', histErr.message)
    return json({ error: 'Falha ao carregar histórico da conversa.' }, 502)
  }

  // Idempotência / anti-spam: se a última mensagem já é da Olivia (out), não há
  // nada novo pra responder — evita resposta dupla em re-invocação/trigger duplo.
  const ultima = historico?.[historico.length - 1]
  if (ultima && ultima.direcao === 'out') {
    return json({ skipped: true, reason: 'última mensagem já é da Olivia (sem inbound novo)' })
  }

  const ultimaDoLead = [...(historico ?? [])].reverse().find((m) => m.direcao === 'in')

  // --- Guardrail: opt-out determinístico ANTES do LLM (LGPD) ---
  // Persiste o opt-out só fora do dry-run (dry-run é read-only: só reporta).
  if (detectarOptout(ultimaDoLead?.corpo)) {
    if (!dryRun) await aplicarEstado(supabase, leadId, { olivia_estado: 'optout' })
    return json({ acao: 'optout', via: 'guardrail', dry_run: dryRun })
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

  // --- LLM ---
  const systemPrompt = construirSystemPrompt(lead)
  const mensagens = historicoParaMensagens(historico ?? [])
  if (mensagens.length === 0) {
    return json({ skipped: true, reason: 'sem mensagens de texto no histórico' })
  }

  let acao: OliviaAcao
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
      console.error('olivia-responder: OpenRouter erro', resp.status, errTxt.slice(0, 200))
      return json({ error: `LLM HTTP ${resp.status}` }, 502)
    }
    acao = interpretarResposta(await resp.json())
  } catch (e) {
    console.error('olivia-responder: falha no LLM', e instanceof Error ? e.message : e)
    return json({ error: 'Falha ao chamar o LLM.' }, 502)
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

  // --- Ignorar: a última mensagem não pede resposta (engano, figurinha solta,
  // assunto alheio). Não envia nada e não muda estado — silêncio deliberado é
  // mais natural que responder. ---
  if (acao.tipo === 'ignorar') {
    return json({ acao: 'ignorar', motivo: acao.motivo, enviado: false })
  }

  // --- Fase C: agendamento delega pra olivia-agendar (que fala com o Calendar) ---
  // A mensagem a enviar nesses casos vem da olivia-agendar (horários reais da
  // agenda / confirmação com link do Meet), nunca do LLM (anti-invenção).
  if (acao.tipo === 'agendar' || acao.tipo === 'confirmar') {
    const segredo = triggerSecret ?? ''
    let agendaMsg: string | null = null
    let estadoAgenda: string | null = null

    if (acao.tipo === 'agendar') {
      const r = await chamarAgendar(segredo, { lead_id: leadId, modo: 'propor' })
      if (!r || r.status >= 400) {
        await aplicarEstado(supabase, leadId, { olivia_estado: 'handoff', olivia_handoff_motivo: 'agendar: falha ao propor horários' })
        return json({ acao: 'agendar', erro: 'falha ao propor horários', via: 'agenda' }, 502)
      }
      agendaMsg = r.data?.mensagem ?? null
      estadoAgenda = 'agendando'
    } else {
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
        const r = await chamarAgendar(segredo, { lead_id: leadId, modo: 'confirmar', slot_iso: slotIso })
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
    }

    // Prefixo opcional do LLM ("Que ótimo!") + a mensagem autoritativa da agenda.
    const corpo = [acao.texto, agendaMsg].filter(Boolean).join('\n\n').trim()
    let env: { ok: boolean; wamid: string | null; erro: string | null } | null = null
    if (corpo) {
      env = await enviarPorCanal(lead, destino, corpo)
      if (env.ok) await gravarSaida(supabase, leadId, corpo, env.wamid)
    }
    if (estadoAgenda) await aplicarEstado(supabase, leadId, { olivia_estado: estadoAgenda })
    return json({ acao: acao.tipo, enviado: env?.ok ?? false, erro_envio: env?.erro ?? null, via: 'agenda' })
  }

  // --- Indicação do dono: registra o número e dispara a 1ª mensagem oficial ---
  // Reusa a esteira inteira: whatsapp_dono no lead + hs_whatsapp_phone_number e
  // whatsapp_outreach='ready' no contato → o workflow segmentado do HubSpot
  // manda o template aprovado pro dono (Meta exige template em 1º contato).
  if (acao.tipo === 'registrar_dono') {
    const numero = normalizarNumeroBr(acao.numero)
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
    const hsToken = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')
    if (hsToken && lead.hubspot_contact_id) {
      try {
        const props: Record<string, string> = {
          hs_whatsapp_phone_number: numero,
          phone: numero,
          whatsapp_outreach: 'ready', // re-inscreve no workflow → template pro dono
        }
        if (acao.nome) props.firstname = acao.nome
        const resp = await fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${lead.hubspot_contact_id}`,
          {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ properties: props }),
          },
        )
        workflowDisparado = resp.ok
        if (!resp.ok) console.error('olivia-responder: registrar_dono PATCH falhou', resp.status)
      } catch (e) {
        console.error('olivia-responder: registrar_dono erro', e instanceof Error ? e.message : e)
      }
    }
    if (!workflowDisparado) {
      // Sem disparo automático → vira tarefa humana (a promessa não pode ficar no ar).
      await aplicarEstado(supabase, leadId, {
        olivia_estado: 'handoff',
        olivia_handoff_motivo: `dono indicado (${acao.nome ?? 'sem nome'}, ${numero}) — contatar manualmente`,
      })
    }

    let env: { ok: boolean; wamid: string | null; erro: string | null } | null = null
    if (acao.texto) {
      env = await enviarPorCanal(lead, destino, acao.texto)
      if (env.ok) await gravarSaida(supabase, leadId, acao.texto, env.wamid)
    }
    await aplicarEstado(supabase, leadId, { olivia_reply_apos: null, olivia_estado: workflowDisparado ? 'conversando' : 'handoff' })
    return json({
      acao: 'registrar_dono',
      numero,
      nome: acao.nome,
      workflow_disparado: workflowDisparado,
      enviado: env?.ok ?? false,
    })
  }

  // Envio real (texto livre — janela de 24h aberta pela resposta do lead).
  let enviado: { ok: boolean; wamid: string | null; erro: string | null } | null = null
  if (textoParaEnviar) {
    enviado = await enviarPorCanal(lead, destino, textoParaEnviar)
    if (enviado.ok) await gravarSaida(supabase, leadId, textoParaEnviar, enviado.wamid)
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
