// Edge Function: olivia-responder
// =============================================================================
// Olivia Autônoma (Fase B): gera e envia a resposta da Olivia a UMA conversa.
// Chamada pelo `whatsapp-webhook` (fire-and-forget) quando o lead manda uma
// mensagem. Plano: .claude/plans/2026-06-10-olivia-autonoma.md
//
// FLUXO: carrega lead + histórico → guardrails (opt-out determinístico, gate de
// estado) → LLM (Claude via OpenRouter, com tools) → executa a ação (envia texto
// via Cloud API / escala / opt-out / agenda) → grava a mensagem de saída e o estado.
//
// SEGURANÇA: não é chamada por usuário final — exige o secret interno
// OLIVIA_TRIGGER_SECRET (header x-olivia-secret) OU um usuário autenticado (pra
// testar manualmente pela ferramenta). Deploy SEM verificação de JWT:
//   supabase functions deploy olivia-responder --no-verify-jwt
//
// DRY-RUN: por padrão (OLIVIA_DRY_RUN != 'false') NÃO envia nada — apenas calcula
// e devolve/loga a ação que TOMARIA. Vire 'false' só depois de validar transcripts.
//
// ANTES DE IR PRO AR (OLIVIA_DRY_RUN=false): adicionar rate limiting por chamador
// (endpoint gasta LLM). Hoje a proteção é o segredo interno + auth + o skip de
// "última msg já é out" (não responde duas vezes ao mesmo inbound). Falta um teto
// por janela/IP — gateway ou tabela de contagem — antes do tráfego real.
//
// Secrets:
//   OPENROUTER_API_KEY            (mesmo do hubspot-sync)
//   OLIVIA_MODEL                  (opcional; default abaixo — modelo Claude via OpenRouter)
//   OLIVIA_TRIGGER_SECRET         (segredo interno que o webhook usa pra chamar)
//   OLIVIA_DRY_RUN=false          (pra realmente enviar; default é dry-run)
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
  type OliviaAcao,
} from '../_shared/olivia_brain.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'

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

  const { data: lead, error: loadErr } = await supabase
    .from('leads')
    .select('id, nome, dono_nome, setor, cidade, nome_genero, whatsapp_phone, whatsapp_dono, olivia_estado, olivia_slots')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

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
      // confirmar: opção (1-based) → slot guardado no lead.
      const slots: string[] = Array.isArray(lead.olivia_slots) ? lead.olivia_slots : []
      const slotIso = slots[acao.opcao - 1]
      if (!slotIso) {
        // Lead escolheu um número que não existe → re-propõe em vez de chutar.
        const r = await chamarAgendar(segredo, { lead_id: leadId, modo: 'propor' })
        agendaMsg = r?.data?.mensagem ?? 'Deixa eu te passar os horários de novo.'
        estadoAgenda = 'agendando'
      } else {
        const r = await chamarAgendar(segredo, { lead_id: leadId, modo: 'confirmar', slot_iso: slotIso })
        if (!r || r.status >= 400) {
          await aplicarEstado(supabase, leadId, { olivia_estado: 'handoff', olivia_handoff_motivo: 'confirmar: falha ao criar evento' })
          return json({ acao: 'confirmar', erro: 'falha ao confirmar', via: 'agenda' }, 502)
        }
        agendaMsg = r.data?.mensagem ?? null
        estadoAgenda = null // a olivia-agendar já marcou 'agendado' + status
      }
    }

    // Prefixo opcional do LLM ("Que ótimo!") + a mensagem autoritativa da agenda.
    const corpo = [acao.texto, agendaMsg].filter(Boolean).join('\n\n').trim()
    let env: { ok: boolean; wamid: string | null; erro: string | null } | null = null
    if (corpo) {
      env = await enviarTexto(destino, corpo)
      if (env.ok) await gravarSaida(supabase, leadId, corpo, env.wamid)
    }
    if (estadoAgenda) await aplicarEstado(supabase, leadId, { olivia_estado: estadoAgenda })
    return json({ acao: acao.tipo, enviado: env?.ok ?? false, erro_envio: env?.erro ?? null, via: 'agenda' })
  }

  // Envio real (texto livre — janela de 24h aberta pela resposta do lead).
  let enviado: { ok: boolean; wamid: string | null; erro: string | null } | null = null
  if (textoParaEnviar) {
    enviado = await enviarTexto(destino, textoParaEnviar)
    if (enviado.ok) await gravarSaida(supabase, leadId, textoParaEnviar, enviado.wamid)
  }

  // Atualiza estado + campos da ação.
  const patch: Record<string, unknown> = {}
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
})
