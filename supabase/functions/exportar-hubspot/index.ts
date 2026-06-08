// Edge Function: exportar-hubspot  (STUB — handoff pro HubSpot)
// =============================================================================
// Por enquanto NÃO chama o HubSpot. Valida se cada lead tem o mínimo pra virar
// card e marca hubspot_exported_at = now(). Quando a API for conectada, o token
// vira o secret HUBSPOT_TOKEN (Private App token) — NUNCA no frontend — e o
// `fetch` real entra no ponto marcado com TODO abaixo.
//
// Roda no servidor (Deno), protegida por JWT; usa a service role pra escrever.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Mapeamento que será usado na chamada real ao CRM do HubSpot (v3).
// Documentado aqui pra deixar óbvio o de-para na hora de plugar a API.
export const HUBSPOT_FIELD_MAP = {
  // company:  name=nome, domain=website, phone=telefone, address=endereco,
  //           city=cidade, cnpj=cnpj (custom property), instagram=instagram_handle,
  //           followers=instagram_followers, setor=setor (custom)
  company: {
    name: 'nome',
    domain: 'website',
    phone: 'telefone',
    address: 'endereco',
    city: 'cidade',
    cnpj: 'cnpj', // custom property
    instagram: 'instagram_handle',
    followers: 'instagram_followers',
    setor: 'setor', // custom property
  },
  // contact:  firstname=<1ª palavra de dono_nome>, lastname=<resto>, company=nome
  contact: {
    firstname: 'dono_nome[0]',
    lastname: 'dono_nome[1..]',
    company: 'nome',
  },
  // deal:     dealname="<nome> — prospecção", pipeline/stage = <definir depois>
  deal: {
    dealname: '`${nome} — prospecção`',
    pipeline: 'TODO',
    stage: 'TODO',
  },
} as const

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

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

  try {
    const { data: leads, error: loadErr } = await supabase
      .from('leads')
      .select('id, nome, cnpj, dono_nome')
      .in('id', leadIds)
    if (loadErr) throw loadErr

    const exported: string[] = []
    const skipped: { id: string; motivo: string }[] = []

    for (const lead of leads ?? []) {
      // Mínimo pra virar card: nome + CNPJ + dono (mesma régua do gate da UI).
      if (!lead.nome) {
        skipped.push({ id: lead.id, motivo: 'sem nome' })
        continue
      }
      if (!lead.cnpj) {
        skipped.push({ id: lead.id, motivo: 'sem CNPJ — enriqueça antes' })
        continue
      }
      if (!lead.dono_nome) {
        skipped.push({ id: lead.id, motivo: 'sem dono — enriqueça antes' })
        continue
      }

      // TODO(hubspot): com HUBSPOT_TOKEN configurado, criar os objetos no CRM v3
      //   POST /crm/v3/objects/companies   (props via HUBSPOT_FIELD_MAP.company)
      //   POST /crm/v3/objects/contacts    (props via HUBSPOT_FIELD_MAP.contact)
      //   POST /crm/v3/objects/deals       (props via HUBSPOT_FIELD_MAP.deal)
      //   + associations company↔contact↔deal. Em falha, empurrar pra skipped.
      //   Header: Authorization: `Bearer ${Deno.env.get('HUBSPOT_TOKEN')}`.

      exported.push(lead.id)
    }

    if (exported.length > 0) {
      const { error: updErr } = await supabase
        .from('leads')
        .update({ hubspot_exported_at: new Date().toISOString() })
        .in('id', exported)
      if (updErr) throw updErr
    }

    return json({ exported, skipped })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Erro desconhecido'
    return json({ error: message }, 502)
  }
})
