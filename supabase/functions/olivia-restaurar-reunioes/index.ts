// Edge Function: olivia-restaurar-reunioes  (one-shot, manual)
// =============================================================================
// Restaura reuniões que o antigo no-show automático "comeu": ele zerava
// reuniao_at e mudava olivia_estado de 'agendado' → 'agendando', fazendo o card
// sumir da coluna "Reunião agendada". A DATA REAL sobrevive no HubSpot, na
// propriedade de contato `olivia_reuniao_em` (o no-show só mexia na tabela leads,
// não no HubSpot). Esta função relê essa data e devolve o lead para 'agendado'.
//
// Critério: leads com olivia_noshow_em != null E reuniao_at null (mexidos pelo
// no-show e ainda sem reunião). Pula optout e descartado (restaurar seria errado)
// e quem não tem data recuperável no HubSpot.
//
// SEGURANÇA: dry-run por padrão — só RELATA o que faria. Para aplicar de verdade,
// mande {"dry_run": false}. AUTH: OLIVIA_TRIGGER_SECRET (server-to-server).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const HUBSPOT_BASE = 'https://api.hubapi.com'
const MAX_POR_RUN = 200

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

interface LeadRow {
  id: string
  nome: string | null
  olivia_estado: string | null
  status: string | null
  hubspot_contact_id: string | null
}

// Lê a propriedade olivia_reuniao_em de um contato no HubSpot. Devolve ISO ou null.
async function lerReuniaoEm(token: string, contactId: string): Promise<string | null> {
  const resp = await fetch(
    `${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}?properties=olivia_reuniao_em`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!resp.ok) return null
  const data = await resp.json().catch(() => null) as { properties?: { olivia_reuniao_em?: string | null } } | null
  const v = data?.properties?.olivia_reuniao_em
  if (!v) return null
  // HubSpot devolve datetime como epoch ms (string) ou ISO; normaliza pra ISO.
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) return json({ error: 'Não autorizado.' }, 401)

  let dryRun = true
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object' && (b as { dry_run?: unknown }).dry_run === false) dryRun = false
  } catch { /* dry-run */ }

  const token = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN')
  if (!token) return json({ error: 'Falta o secret HUBSPOT_PRIVATE_APP_TOKEN.' }, 500)

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Candidatos: mexidos pelo no-show e ainda sem reunião.
  const { data, error } = await supabase
    .from('leads')
    .select('id, nome, olivia_estado, status, hubspot_contact_id')
    .not('olivia_noshow_em', 'is', null)
    .is('reuniao_at', null)
    .neq('olivia_estado', 'optout')
    .neq('status', 'descartado')
    .limit(MAX_POR_RUN)
  if (error) return json({ error: `Falha ao selecionar leads: ${error.message}` }, 502)

  const candidatos = (data ?? []) as LeadRow[]
  const restaurados: { lead_id: string; nome: string | null; reuniao_at: string }[] = []
  const semData: { lead_id: string; nome: string | null; motivo: string }[] = []
  const erros: { lead_id: string; erro: string }[] = []

  for (const l of candidatos) {
    try {
      if (!l.hubspot_contact_id) {
        semData.push({ lead_id: l.id, nome: l.nome, motivo: 'sem hubspot_contact_id' })
        continue
      }
      const reuniaoAt = await lerReuniaoEm(token, l.hubspot_contact_id)
      if (!reuniaoAt) {
        semData.push({ lead_id: l.id, nome: l.nome, motivo: 'olivia_reuniao_em ausente no HubSpot' })
        continue
      }
      if (!dryRun) {
        const { error: upErr } = await supabase
          .from('leads')
          .update({ olivia_estado: 'agendado', reuniao_at: reuniaoAt })
          .eq('id', l.id)
        if (upErr) { erros.push({ lead_id: l.id, erro: upErr.message }); continue }
      }
      restaurados.push({ lead_id: l.id, nome: l.nome, reuniao_at: reuniaoAt })
    } catch (e) {
      erros.push({ lead_id: l.id, erro: e instanceof Error ? e.message : String(e) })
    }
  }

  return json({
    dry_run: dryRun,
    candidatos: candidatos.length,
    restaurados: restaurados.length,
    restaurados_detalhe: restaurados,
    sem_data: semData.length,
    sem_data_detalhe: semData,
    erros: erros.length,
    erros_detalhe: erros,
  })
})
