// Edge Function: olivia-sim  (sandbox de conversa — NÃO envia, NÃO grava)
// =============================================================================
// Roda o MESMO cérebro da Olivia (construirSystemPrompt + montarRequest +
// interpretarResposta, mesmo modelo via OpenRouter) sobre uma conversa simulada
// passada no corpo, e devolve a AÇÃO que ela tomaria (texto ou tool-call) — sem
// nenhum efeito colateral. Serve pra testar mudanças de prompt antes de irem a
// produção (ex.: não repetir "você é o dono?", reconhecer contato compartilhado).
//
// Body: { lead: LeadContexto, messages: [{role:'user'|'assistant', content}] }
// AUTH: só servidor — OLIVIA_TRIGGER_SECRET.
// =============================================================================

import {
  construirSystemPrompt,
  montarRequest,
  interpretarResposta,
  descreverAgora,
  type LeadContexto,
  type ChatMessage,
} from '../_shared/olivia_brain.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-olivia-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) return json({ error: 'Não autorizado.' }, 401)

  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  if (!apiKey) return json({ error: 'OPENROUTER_API_KEY ausente.' }, 500)

  let lead: LeadContexto
  let messages: ChatMessage[]
  try {
    const b = await req.json()
    lead = b.lead as LeadContexto
    messages = (b.messages ?? []) as ChatMessage[]
    if (!lead?.nome || !Array.isArray(messages) || messages.length === 0) {
      return json({ error: 'Body esperado: { lead: {nome,...}, messages: [{role,content}] }' }, 400)
    }
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const model = Deno.env.get('OLIVIA_MODEL') ?? DEFAULT_MODEL
  const system = construirSystemPrompt(lead, descreverAgora(Date.now()))

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Squad Olivia Sim' },
    body: JSON.stringify(montarRequest(system, messages, model)),
  })
  if (!resp.ok) return json({ error: `LLM HTTP ${resp.status}`, detalhe: (await resp.text()).slice(0, 300) }, 502)

  const data = await resp.json()
  const acao = interpretarResposta(data)
  const msg = data?.choices?.[0]?.message ?? {}
  return json({
    acao,
    texto: (acao as { texto?: string | null }).texto ?? msg.content ?? null,
    tool_calls: msg.tool_calls ?? null,
    model,
  })
})
