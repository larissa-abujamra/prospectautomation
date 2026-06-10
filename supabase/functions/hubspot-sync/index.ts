// Edge Function: hubspot-sync
// =============================================================================
// Módulo WhatsApp (Parte B): faz UPSERT de um lead como CONTATO no HubSpot, para
// alimentar o fluxo de WhatsApp do HubSpot (Partes C+). Roda no servidor (Deno);
// o token NUNCA vai pro frontend — é secret:
//   supabase secrets set HUBSPOT_PRIVATE_APP_TOKEN=pat-...
//
// App privado "prospect-automation-whatsapp" (portal Inner AI 50173893).
// Scopes do token: crm.objects.contacts.read/write (+ schemas, p/ setup de props).
//
// DEDUP: leads não têm e-mail; usamos a propriedade CUSTOM única `google_place_id`
// como idProperty no /contacts/batch/upsert → idempotente (re-sync atualiza, não
// duplica). ANTI-INVENÇÃO: só sincroniza quem tem número (achado ou nº manual
// da dona/o) + place_id;
// campos nulos são omitidos (ver _shared/hubspot.ts).
//
// NÃO toca a função `exportar-hubspot` (stub de UI da outra frente) — é uma rota
// separada, criação real de contato. A fiação do botão fica para um passo conjunto.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  canSyncToHubspot,
  leadToContactPropertiesWithTrigger,
  HUBSPOT_DEDUP_PROPERTY,
} from '../_shared/hubspot.ts'
import { parseGenero, generoPrompt, type Genero } from '../_shared/genero.ts'
import { requireAuthenticatedUser } from '../_shared/auth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const HUBSPOT_BASE = 'https://api.hubapi.com'

interface UpsertResult {
  contactId: string
  created: boolean
}

// Upsert por propriedade única (idProperty). 200 = atualizado, 201 = criado.
async function upsertContact(
  token: string,
  properties: Record<string, string>,
): Promise<UpsertResult> {
  const resp = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/upsert`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: [{ idProperty: HUBSPOT_DEDUP_PROPERTY, id: properties[HUBSPOT_DEDUP_PROPERTY], properties }],
    }),
  })

  const data = await resp.json().catch(() => null)
  if (!resp.ok) {
    const msg = data?.message ?? `HubSpot upsert falhou (HTTP ${resp.status})`
    throw new Error(msg)
  }
  const row = data?.results?.[0]
  if (!row?.id) throw new Error('HubSpot não retornou id do contato.')
  // O batch/upsert sempre responde 200 (não 201), então o status code não diz
  // criou vs atualizou. A verdade do HubSpot é a linha: created quando o
  // createdAt coincide com o updatedAt (recém-criado, nunca atualizado depois).
  const created = !!row.createdAt && row.createdAt === row.updatedAt
  return { contactId: String(row.id), created }
}

// Classifica o gênero do nome via OpenRouter (modelo barato). Erro / sem chave /
// incerto → 'f' (default seguro, ver _shared/genero.ts). Usado só quando o lead
// ainda não tem nome_genero — é gravado uma vez.
async function classificarGenero(nome: string, apiKey: string | undefined): Promise<Genero> {
  if (!apiKey) return 'f'
  try {
    const { system, user } = generoPrompt(nome)
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Squad Prospeccao',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini', // barato e confiável; só uma letra de resposta
        temperature: 0,
        max_tokens: 2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!resp.ok) return 'f'
    const data = await resp.json()
    return parseGenero(data?.choices?.[0]?.message?.content)
  } catch {
    return 'f'
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Só um membro logado sincroniza (escreve no CRM + classifica via LLM).
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const token = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')
  if (!token) return json({ error: 'Falta o secret HUBSPOT_PRIVATE_APP_TOKEN.' }, 500)

  let leadId: string
  let trigger = false
  try {
    const body = await req.json()
    leadId = String(body.lead_id ?? '')
    // trigger=true também marca whatsapp_outreach='ready' (Parte C) — é o que o
    // workflow do HubSpot enrola para disparar o template aprovado.
    trigger = Boolean(body.trigger)
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
    .select('*')
    .eq('id', leadId)
    .single()
  if (loadErr || !lead) return json({ error: 'Lead não encontrado.' }, 404)

  // Trava: só vai pro CRM quem é mensageável (nº da loja achado OU nº manual
  // da dona/o em whatsapp_dono) e tem place_id (chave de dedup).
  if (!canSyncToHubspot(lead)) {
    return json(
      { error: 'Lead não sincronizável: precisa de google_place_id e de um número (whatsapp_phone achado ou whatsapp_dono manual).' },
      422,
    )
  }

  try {
    // Gênero do nome (para o workflow escolher template _f/_m). Classifica uma
    // única vez via LLM; persiste no lead. Default 'f' em qualquer incerteza.
    if (!lead.nome_genero) {
      lead.nome_genero = await classificarGenero(lead.nome, Deno.env.get('OPENROUTER_API_KEY'))
      await supabase.from('leads').update({ nome_genero: lead.nome_genero }).eq('id', leadId)
    }

    const properties = leadToContactPropertiesWithTrigger(lead, trigger)
    const { contactId, created } = await upsertContact(token, properties)

    // Guarda o id do contato no lead (idempotência + rastreio). hubspot_synced_at
    // pode não existir ainda no schema → tentamos, e caímos pro mínimo se falhar.
    const fullPatch = { hubspot_contact_id: contactId, hubspot_synced_at: new Date().toISOString() }
    let updErr = (await supabase.from('leads').update(fullPatch).eq('id', leadId)).error
    if (updErr) {
      updErr = (await supabase.from('leads').update({ hubspot_contact_id: contactId }).eq('id', leadId)).error
    }
    if (updErr) throw updErr

    return json({ contactId, created, triggered: trigger, nome_genero: lead.nome_genero, properties })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Erro desconhecido'
    return json({ error: message }, 502)
  }
})
