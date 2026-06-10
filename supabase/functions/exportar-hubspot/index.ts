// Edge Function: exportar-hubspot  ("Importar pra HubSpot")
// =============================================================================
// Cria o CARD de prospecção no HubSpot: um NEGÓCIO no pipeline "Squad Prospects"
// (estágio Prospects) + o CONTATO, associados. Quando o WhatsApp é enviado, um
// workflow do HubSpot move o negócio para "Tentativa de Contato".
//
// Roda no servidor (Deno); o token NUNCA vai pro frontend — é secret:
//   supabase secrets set HUBSPOT_PRIVATE_APP_TOKEN=pat-...
// App "prospect-automation-whatsapp" (portal 50173893). Scopes: contacts + deals
// (read/write).
//
// DEDUP: contato por propriedade única google_place_id (idempotente). Negócio
// não tem chave única → guardamos hubspot_deal_id no lead e NÃO recriamos.
// ANTI-INVENÇÃO: só exporta quem tem nome + place_id; campos nulos omitidos.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  canExportDeal,
  leadToContactProperties,
  leadToDealProperties,
  HUBSPOT_DEDUP_PROPERTY,
  HUBSPOT_DEALS_PIPELINE,
} from '../_shared/hubspot.ts'
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
const HUBSPOT_TIMEOUT_MS = 12_000
// Associação padrão Negócio → Contato (HUBSPOT_DEFINED, typeId 3).
const DEAL_TO_CONTACT_TYPE_ID = 3
// Sentinela do claim atômico de criação de negócio (deals não têm chave única).
const DEAL_CRIANDO = '__criando__'

async function hsFetch(token: string, path: string, body: unknown) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS)
  const resp = await fetch(`${HUBSPOT_BASE}${path}`, {
    method: 'POST',
    signal: controller.signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).finally(() => clearTimeout(timeout))
  const data = await resp.json().catch(() => null)
  if (!resp.ok) {
    throw new Error(data?.message ?? `HubSpot ${path} falhou (HTTP ${resp.status})`)
  }
  return data
}

// GET no HubSpot (associações/leitura de negócio). Não lança em 404 → null.
async function hsGet(token: string, path: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS)
  const resp = await fetch(`${HUBSPOT_BASE}${path}`, {
    signal: controller.signal,
    headers: { Authorization: `Bearer ${token}` },
  }).finally(() => clearTimeout(timeout))
  if (resp.status === 404) return null
  const data = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(data?.message ?? `HubSpot GET ${path} falhou (HTTP ${resp.status})`)
  return data
}

// Dedup de NEGÓCIO sem chave natural: o contato é único (google_place_id), então
// um negócio dele JÁ no pipeline Squad Prospects é o card de prospecção. Reusamos
// em vez de criar outro — robusto mesmo se o lead.hubspot_deal_id não tiver sido
// persistido (ex.: falha no update após criar o negócio numa execução anterior).
async function findExistingDeal(token: string, contactId: string): Promise<string | null> {
  const assoc = await hsGet(token, `/crm/v4/objects/contacts/${contactId}/associations/deals`)
  const dealIds: string[] = (assoc?.results ?? [])
    .map((r: { toObjectId?: string | number }) => (r.toObjectId == null ? '' : String(r.toObjectId)))
    .filter(Boolean)
  for (const id of dealIds) {
    const deal = await hsGet(token, `/crm/v3/objects/deals/${id}?properties=pipeline`)
    if (deal?.properties?.pipeline === HUBSPOT_DEALS_PIPELINE) return String(id)
  }
  return null
}

// Upsert do contato por google_place_id (idempotente). Devolve o id.
async function upsertContact(token: string, props: Record<string, string>): Promise<string> {
  const data = await hsFetch(token, '/crm/v3/objects/contacts/batch/upsert', {
    inputs: [{ idProperty: HUBSPOT_DEDUP_PROPERTY, id: props[HUBSPOT_DEDUP_PROPERTY], properties: props }],
  })
  const id = data?.results?.[0]?.id
  if (!id) throw new Error('HubSpot não retornou id do contato.')
  return String(id)
}

// Cria o negócio (Prospects) já associado ao contato. Devolve o id.
async function createDeal(token: string, props: Record<string, string>, contactId: string): Promise<string> {
  const data = await hsFetch(token, '/crm/v3/objects/deals', {
    properties: props,
    associations: [{
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_CONTACT_TYPE_ID }],
    }],
  })
  const id = data?.id
  if (!id) throw new Error('HubSpot não retornou id do negócio.')
  return String(id)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  // Escreve no CRM → exige um membro logado.
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  const token = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN') ?? Deno.env.get('HUBSPOT_TOKEN')
  if (!token) return json({ error: 'Falta o secret HUBSPOT_PRIVATE_APP_TOKEN.' }, 500)

  let leadIds: string[]
  try {
    const body = await req.json()
    leadIds = Array.isArray(body.lead_ids) ? body.lead_ids.map(String) : []
    if (leadIds.length === 0) return json({ error: 'Informe lead_ids.' }, 400)
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: leads, error: loadErr } = await supabase
    .from('leads')
    .select('*')
    .in('id', leadIds)
  if (loadErr) return json({ error: loadErr.message }, 502)

  const exported: { id: string; dealId: string; contactId: string; created: boolean }[] = []
  const skipped: { id: string; motivo: string }[] = []

  for (const lead of leads ?? []) {
    if (!canExportDeal(lead)) {
      skipped.push({ id: lead.id, motivo: 'precisa de nome e google_place_id' })
      continue
    }
    try {
      const contactId = await upsertContact(token, leadToContactProperties(lead))

      // Negócio: reaproveita o existente p/ não duplicar. 1º a coluna persistida;
      // se vazia, procura no HubSpot um negócio do contato já em Squad Prospects
      // (cobre o caso de uma execução anterior ter criado o negócio mas falhado
      // ao gravar o id). Só cria se realmente não houver nenhum.
      let dealId: string = lead.hubspot_deal_id && lead.hubspot_deal_id !== DEAL_CRIANDO ? lead.hubspot_deal_id : ''
      if (!dealId) dealId = (await findExistingDeal(token, contactId)) ?? ''
      let created = false
      if (!dealId) {
        // CAS atômico: marca a coluna como "criando" SÓ se ainda estiver null.
        // Só uma exportação concorrente do mesmo lead ganha o claim → as outras
        // não criam um 2º negócio (deals não têm chave natural de dedup).
        const { data: claim } = await supabase.from('leads')
          .update({ hubspot_deal_id: DEAL_CRIANDO })
          .eq('id', lead.id).is('hubspot_deal_id', null).select('id')
        if (claim && claim.length > 0) {
          try {
            dealId = await createDeal(token, leadToDealProperties(lead), contactId)
            created = true
          } catch (e) {
            // libera o claim pra não travar a próxima tentativa
            await supabase.from('leads').update({ hubspot_deal_id: null })
              .eq('id', lead.id).eq('hubspot_deal_id', DEAL_CRIANDO)
            throw e
          }
        } else {
          // outra exportação está criando agora → relê o id persistido ou acha
          // pelo contato. Se ainda não materializou, pula (a outra vai gravar).
          const { data: row } = await supabase.from('leads').select('hubspot_deal_id').eq('id', lead.id).single()
          const persisted = row?.hubspot_deal_id
          dealId = persisted && persisted !== DEAL_CRIANDO ? persisted : ((await findExistingDeal(token, contactId)) ?? '')
          if (!dealId) { skipped.push({ id: lead.id, motivo: 'exportação concorrente em andamento' }); continue }
        }
      }

      // Persiste os ids no lead (idempotência + rastreio). A migração 0009 garante
      // a coluna hubspot_deal_id; se o update falhar, o findExistingDeal acima
      // recupera o negócio numa próxima exportação (sem duplicar).
      const { error: updErr } = await supabase.from('leads').update({
        hubspot_contact_id: contactId,
        hubspot_deal_id: dealId,
        hubspot_exported_at: new Date().toISOString(),
      }).eq('id', lead.id)
      if (updErr) throw updErr

      exported.push({ id: lead.id, dealId, contactId, created })
    } catch (e) {
      skipped.push({ id: lead.id, motivo: e instanceof Error ? e.message : 'erro desconhecido' })
    }
  }

  return json({ exported, skipped })
})
