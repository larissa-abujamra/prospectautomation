// Edge Function: importar-squad-leads
// =============================================================================
// Importa leads inbound do app externo Squad Leads para public.leads.
// A senha de admin do app fonte é secret server-side; nunca vai para o frontend.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import {
  mapSquadLeadToLeadRow,
  type SquadLeadApi,
  type SquadLeadRow,
  type SquadLeadSkipReason,
} from '../_shared/squad_leads.ts'

const SQUAD_LEADS_API = 'https://squad-leads.vercel.app/api'
const SOURCE_TIMEOUT_MS = 15_000

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

class PublicError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message)
  }
}

interface SourceLoginResponse {
  success?: unknown
  token?: unknown
}

interface SourceLeadsResponse {
  leads?: unknown
}

async function fetchJson(path: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS)
  try {
    const response = await fetch(`${SQUAD_LEADS_API}${path}`, {
      ...init,
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new PublicError('Squad Leads respondeu com erro temporário.', 502)
    }
    try {
      return await response.json()
    } catch {
      throw new PublicError('Squad Leads retornou JSON inválido.', 502)
    }
  } catch (error) {
    if (error instanceof PublicError) throw error
    throw new PublicError('Não foi possível conectar ao Squad Leads.', 502)
  } finally {
    clearTimeout(timer)
  }
}

async function loginSquadLeads(password: string): Promise<string> {
  const payload = await fetchJson('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }) as SourceLoginResponse

  if (payload.success !== true || typeof payload.token !== 'string' || !payload.token.trim()) {
    throw new PublicError('Autenticação no Squad Leads falhou.', 502)
  }
  return payload.token.trim()
}

async function fetchSquadLeads(token: string): Promise<unknown[]> {
  const payload = await fetchJson('/admin/leads?sort=date_desc', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }) as SourceLeadsResponse

  if (!Array.isArray(payload.leads)) {
    throw new PublicError('Squad Leads retornou payload inesperado.', 502)
  }

  return payload.leads
}

function updatePatch(row: SquadLeadRow): Record<string, unknown> {
  return {
    origem: row.origem,
    inbound_score: row.inbound_score,
    inbound_classification: row.inbound_classification,
    inbound_revenue_range: row.inbound_revenue_range,
    inbound_ready_to_implement: row.inbound_ready_to_implement,
    inbound_created_at: row.inbound_created_at,
    inbound_utm_source: row.inbound_utm_source,
    inbound_utm_medium: row.inbound_utm_medium,
    inbound_utm_campaign: row.inbound_utm_campaign,
    inbound_meta: row.inbound_meta,
  }
}

type ImportSkipReason = SquadLeadSkipReason | 'invalid_payload' | 'duplicate_source_id'

function incrementReason(
  reasons: Record<ImportSkipReason, number>,
  reason: ImportSkipReason,
) {
  reasons[reason] = (reasons[reason] ?? 0) + 1
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  if (!(await requireAuthenticatedUser(req))) {
    return json({ error: 'Autenticação obrigatória.' }, 401)
  }

  const password = Deno.env.get('SQUAD_LEADS_ADMIN_PASSWORD')?.trim()
  if (!password) {
    console.error('[importar-squad-leads] SQUAD_LEADS_ADMIN_PASSWORD não configurada')
    return json({ error: 'Integração Squad Leads não configurada.' }, 500)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    const token = await loginSquadLeads(password)
    const sourceLeads = await fetchSquadLeads(token)

    const skippedReasons: Record<ImportSkipReason, number> = {
      duplicate_source_id: 0,
      invalid_payload: 0,
      missing_company_name: 0,
      missing_source_id: 0,
    }
    const rowsBySourceId = new Map<number, SquadLeadRow>()

    for (const source of sourceLeads) {
      if (!source || typeof source !== 'object') {
        incrementReason(skippedReasons, 'invalid_payload')
        continue
      }
      const mapped = mapSquadLeadToLeadRow(source as SquadLeadApi)
      if (!mapped.ok) {
        incrementReason(skippedReasons, mapped.reason)
        continue
      }
      if (rowsBySourceId.has(mapped.row.squad_leads_id)) {
        incrementReason(skippedReasons, 'duplicate_source_id')
        continue
      }
      rowsBySourceId.set(mapped.row.squad_leads_id, mapped.row)
    }

    const rows = [...rowsBySourceId.values()]

    if (rows.length === 0) {
      return json({
        imported: 0,
        updated: 0,
        skipped: sourceLeads.length,
        total: sourceLeads.length,
        skipped_reasons: skippedReasons,
      })
    }

    const ids = rows.map((row) => row.squad_leads_id)
    const { data: existingRows, error: selectError } = await supabase
      .from('leads')
      .select('squad_leads_id')
      .in('squad_leads_id', ids)
    if (selectError) throw selectError

    const existing = new Set(
      (existingRows ?? [])
        .map((row: { squad_leads_id: number | null }) => row.squad_leads_id)
        .filter((id: number | null): id is number => id != null),
    )

    const toInsert = rows.filter((row) => !existing.has(row.squad_leads_id))
    const toUpdate = rows.filter((row) => existing.has(row.squad_leads_id))

    let imported = 0
    if (toInsert.length > 0) {
      const { data: insertedRows, error: insertError } = await supabase
        .from('leads')
        .upsert(toInsert, { onConflict: 'squad_leads_id', ignoreDuplicates: true })
        .select('squad_leads_id')
      if (insertError) throw insertError
      imported = insertedRows?.length ?? toInsert.length
    }

    let updated = 0
    for (const row of toUpdate) {
      const { error: updateError } = await supabase
        .from('leads')
        .update(updatePatch(row))
        .eq('squad_leads_id', row.squad_leads_id)
      if (updateError) throw updateError
      updated++
    }

    return json({
      imported,
      updated,
      skipped: sourceLeads.length - rows.length,
      total: sourceLeads.length,
      skipped_reasons: skippedReasons,
    })
  } catch (error) {
    if (error instanceof PublicError) return json({ error: error.message }, error.status)
    console.error('[importar-squad-leads] erro interno sem PII', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown',
    })
    return json({ error: 'Falha ao importar Squad Leads.' }, 502)
  }
})
