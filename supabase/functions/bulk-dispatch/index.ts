// Edge Function: bulk-dispatch  (BATCH — ENVIA mensagens, escala pra milhares)
// =============================================================================
// Aciona o disparo de WhatsApp em LOTE: grava whatsapp_outreach='ready' nos
// contatos do HubSpot (via /contacts/batch/upsert, 100 por requisição) — o
// WORKFLOW "Squad Prospeccao WhatsApp F/M" é quem envia o template. Mesma
// propriedade/efeito do botão por lead (hubspot-sync trigger=true), mas SEM
// chamar hubspot-sync por lead: a versão antiga estourava o rate de invocação
// function->function do Supabase (~30/janela). Aqui é 1 chamada ao HubSpot por
// 100 contatos → milhares por execução.
//
// SELEÇÃO + DEDUP por NÚMERO na RPC leads_disparaveis: exclui números já
// contatados (qualquer linha com whatsapp_sent_at) e dedup dentro do lote — redes
// com WhatsApp central viram várias linhas com o MESMO número.
//
// SEGURANÇA: membro logado (UI) OU segredo interno (GH Action). DRY-RUN por padrão.
// CLAIM atômico antes do upsert; se um chunk falha no HubSpot, faz rollback do
// claim daquele chunk (whatsapp_sent_at volta a null) → re-tentável, sem estado preso.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import {
  canSyncToHubspot,
  leadToContactPropertiesWithTrigger,
  HUBSPOT_DEDUP_PROPERTY,
  type SyncableLead,
} from '../_shared/hubspot.ts'
import { parseGenero, generoPrompt, type Genero } from '../_shared/genero.ts'
import { estadoDeDisparo } from '../_shared/disparo_estado.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-olivia-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const HUBSPOT_BASE = 'https://api.hubapi.com'
// Teto por execução. Limitado a caber no timeout do edge (a classificação de
// gênero por LLM dos leads sem gênero é a parte mais lenta). Pra milhares, rode
// algumas execuções em sequência — não há mais a janela de ~48s da versão antiga.
const MAX_POR_LOTE = 300
const UPSERT_CHUNK = 100 // limite do /contacts/batch/upsert do HubSpot
const GENERO_CONCORRENCIA = 6

// Lead vindo do banco: SyncableLead + colunas de controle do disparo.
type LeadRow = SyncableLead & {
  id: string
  olivia_estado: string | null
}

// Classifica o gênero do nome via OpenRouter. Devolve null em erro/sem chave —
// assim NÃO persistimos um 'f' default errado; quem chama usa ('f') só na hora.
async function classificarGenero(nome: string, apiKey: string | undefined): Promise<Genero | null> {
  if (!apiKey || !nome?.trim()) return null
  try {
    const { system, user } = generoPrompt(nome)
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Squad Prospeccao' },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        temperature: 0,
        max_tokens: 2,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    return parseGenero(data?.choices?.[0]?.message?.content)
  } catch {
    return null
  }
}

// Roda fn(item) em chunks de tamanho `concorrencia` (espaça chamadas externas).
async function emChunks<T>(items: T[], concorrencia: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += concorrencia) {
    await Promise.all(items.slice(i, i + concorrencia).map(fn))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Membro logado (UI) OU segredo interno (GH Action). Ação de custo → auth no código.
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  const autorizado =
    (!!secret && req.headers.get('x-olivia-secret') === secret) ||
    (await requireAuthenticatedUser(req))
  if (!autorizado) return json({ error: 'Autenticação obrigatória.' }, 401)

  const base = Deno.env.get('SUPABASE_URL')
  if (!base) return json({ error: 'SUPABASE_URL ausente.' }, 500)
  const token = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')

  let dryRun = true
  let limite = 100
  let setor: string | null = null
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object') {
      if ((b as { dry_run?: unknown }).dry_run === false) dryRun = false
      const l = Number((b as { limite?: unknown }).limite)
      if (Number.isFinite(l) && l > 0) limite = Math.min(Math.floor(l), MAX_POR_LOTE)
      const s = (b as { setor?: unknown }).setor
      if (typeof s === 'string' && s.trim()) setor = s.trim()
    }
  } catch {
    /* corpo vazio → dry-run */
  }

  const supabase = createClient(base, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Seleção + dedup por número (exclui números já contatados, um por número).
  const { data: selecionados, error: selErr } = await supabase.rpc('leads_disparaveis', {
    p_setor: setor,
    p_limite: limite,
  })
  if (selErr) {
    console.error('bulk-dispatch: falha na seleção', selErr.message)
    return json({ error: 'Falha ao selecionar leads.' }, 502)
  }
  const lista = (selecionados ?? []) as { id: string; nome: string | null; setor: string | null }[]

  if (dryRun) {
    return json({ dry_run: true, selecionados: lista.length, leads: lista })
  }
  if (lista.length === 0) {
    return json({ dry_run: false, selecionados: 0, disparados: 0, erros: 0 })
  }
  if (!token) return json({ error: 'Falta o secret HUBSPOT_PRIVATE_APP_TOKEN.' }, 500)

  // CLAIM atômico em massa: marca whatsapp_sent_at antes do efeito no HubSpot.
  // Duas execuções concorrentes não disparam o mesmo lead duas vezes; falhas/
  // inválidos seguem re-claimáveis. Só seguimos com o que foi efetivamente travado.
  const claimedAt = new Date().toISOString()
  const { data: claimed, error: claimErr } = await supabase
    .from('leads')
    .update({ whatsapp_sent_at: claimedAt, whatsapp_send_status: null })
    .in('id', lista.map((l) => l.id))
    .or('whatsapp_sent_at.is.null,whatsapp_send_status.in.(failed,invalid)')
    .select('*')
  if (claimErr) {
    console.error('bulk-dispatch: falha no claim', claimErr.message)
    return json({ error: 'Falha ao reservar leads.' }, 502)
  }
  const travados = (claimed ?? []) as LeadRow[]

  // Guarda de sincronizabilidade (place_id + número). Quem não passa é solto.
  const aprovados = travados.filter((l) => canSyncToHubspot(l))
  const reprovadosIds = travados.filter((l) => !canSyncToHubspot(l)).map((l) => l.id)
  if (reprovadosIds.length) {
    await supabase.from('leads').update({ whatsapp_sent_at: null }).in('id', reprovadosIds)
  }

  // Gênero (template _f/_m): classifica os sem gênero em chunks (OpenRouter direto,
  // não conta no rate de function do Supabase). Persiste só classificação real;
  // em memória cai pra 'f' (default seguro) pra a propriedade sempre ir preenchida.
  const apiKey = Deno.env.get('OPENROUTER_API_KEY')
  const semGenero = aprovados.filter((l) => !l.nome_genero)
  await emChunks(semGenero, GENERO_CONCORRENCIA, async (l) => {
    const g = await classificarGenero(l.nome, apiKey)
    l.nome_genero = g ?? 'f'
    if (g) await supabase.from('leads').update({ nome_genero: g }).eq('id', l.id)
  })

  // UPSERT em lotes de 100 no HubSpot. Cada upsert grava whatsapp_outreach='ready'
  // → o workflow enfileira e envia. 1 requisição por 100 contatos.
  let disparados = 0
  const errosLotes: { lote: number; erro: string; leads: number }[] = []

  for (let i = 0; i < aprovados.length; i += UPSERT_CHUNK) {
    const chunk = aprovados.slice(i, i + UPSERT_CHUNK)
    const inputs = chunk.map((l) => {
      const properties = leadToContactPropertiesWithTrigger(l, true)
      return { idProperty: HUBSPOT_DEDUP_PROPERTY, id: properties[HUBSPOT_DEDUP_PROPERTY], properties }
    })
    try {
      const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/upsert`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      })
      const data = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(data?.message ?? `HubSpot upsert HTTP ${resp.status}`)

      // place_id -> contactId (pra bookkeeping local).
      const porPlace = new Map<string, string>()
      for (const r of (data?.results ?? []) as { id?: string; properties?: Record<string, string> }[]) {
        const pid = r.properties?.[HUBSPOT_DEDUP_PROPERTY]
        if (pid && r.id) porPlace.set(String(pid), String(r.id))
      }
      disparados += chunk.length

      // Bookkeeping local best-effort: a mensagem já foi acionada (claim + ready);
      // se a escrita local falhar, NÃO faz rollback do claim (a msg foi enviada).
      await Promise.all(
        chunk.map(async (l) => {
          const patch: Record<string, string> = { hubspot_synced_at: claimedAt }
          const contactId = l.google_place_id ? porPlace.get(String(l.google_place_id)) : undefined
          if (contactId) patch.hubspot_contact_id = contactId
          const novoEstado = estadoDeDisparo(l.olivia_estado)
          if (novoEstado) patch.olivia_estado = novoEstado
          const { error } = await supabase.from('leads').update(patch).eq('id', l.id)
          if (error && contactId) {
            // fallback mínimo (coluna hubspot_synced_at pode não existir no schema)
            await supabase.from('leads').update({ hubspot_contact_id: contactId }).eq('id', l.id)
          }
        }),
      )
    } catch (e) {
      // Rollback do claim deste chunk: o upsert NÃO aconteceu → re-tentável.
      const chunkIds = chunk.map((l) => l.id)
      await supabase.from('leads').update({ whatsapp_sent_at: null, whatsapp_send_status: null }).in('id', chunkIds)
      errosLotes.push({ lote: Math.floor(i / UPSERT_CHUNK), erro: e instanceof Error ? e.message : String(e), leads: chunkIds.length })
    }
  }

  return json({
    dry_run: false,
    selecionados: lista.length,
    travados: travados.length,
    disparados,
    erros: errosLotes.reduce((acc, e) => acc + e.leads, 0),
    erros_lotes: errosLotes,
  })
})
