// Edge Function: manual-olivia-lead
// =============================================================================
// Creates or reuses a lead for a manually entered Olivia WhatsApp contact.
// This function only validates/upserts the lead. The actual WhatsApp workflow is
// still triggered by the existing exportar-hubspot + hubspot-sync path.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
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

interface ManualInput {
  nome: string
  whatsapp: string
  cidade: string
  notas: string | null
}

const RETRYABLE_SEND_STATUSES = new Set(['failed', 'invalid'])
const SENT_SEND_STATUSES = new Set(['sent', 'delivered', 'read', 'replied'])
const MAX_NOME_LENGTH = 120
const MAX_CIDADE_LENGTH = 120
const MAX_NOTAS_LENGTH = 1000

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? cleanText(value) : null
}

function toE164Br(raw: unknown): string | null {
  const s = stringField(raw)
  if (!s) return null
  const d = s.replace(/\D/g, '')
  if (s.startsWith('+')) {
    return (d.length === 12 || d.length === 13) && d.startsWith('55') ? '+' + d : null
  }
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return '+' + d
  if (d.length === 10 || d.length === 11) return '+55' + d
  return null
}

function validateInput(body: Record<string, unknown>): { ok: true; input: ManualInput } | { ok: false; error: string } {
  const nome = stringField(body.nome)
  if (!nome) return { ok: false, error: 'Informe o nome do contato ou negócio.' }
  if (nome.length > MAX_NOME_LENGTH) return { ok: false, error: `Nome deve ter até ${MAX_NOME_LENGTH} caracteres.` }

  const whatsapp = toE164Br(body.whatsapp)
  if (!whatsapp) return { ok: false, error: 'Informe um WhatsApp brasileiro com DDD.' }

  const cidade = stringField(body.cidade)
  if (!cidade) return { ok: false, error: 'Informe a cidade.' }
  if (cidade.length > MAX_CIDADE_LENGTH) return { ok: false, error: `Cidade deve ter até ${MAX_CIDADE_LENGTH} caracteres.` }

  const notas = body.notas == null ? '' : stringField(body.notas)
  if (notas == null) return { ok: false, error: 'Notas devem ser texto.' }
  if (notas.length > MAX_NOTAS_LENGTH) return { ok: false, error: `Notas devem ter até ${MAX_NOTAS_LENGTH} caracteres.` }

  return { ok: true, input: { nome, whatsapp, cidade, notas: notas || null } }
}

function manualDedupKey(whatsapp: string): string {
  return `manual_olivia:${whatsapp.replace(/\D/g, '')}`
}

function canRetryOutreach(lead: { whatsapp_sent_at?: string | null; whatsapp_send_status?: string | null }): boolean {
  if (RETRYABLE_SEND_STATUSES.has(String(lead.whatsapp_send_status))) return true
  if (SENT_SEND_STATUSES.has(String(lead.whatsapp_send_status))) return false
  return !lead.whatsapp_sent_at
}

function leadPayload(input: ManualInput, checkedAt: string) {
  return {
    nome: input.nome,
    origem: 'manual_olivia',
    google_place_id: manualDedupKey(input.whatsapp),
    setor: 'Geral',
    cidade: input.cidade,
    whatsapp_phone: input.whatsapp,
    whatsapp_source: 'manual',
    whatsapp_status: 'found',
    whatsapp_checked_at: checkedAt,
    nome_genero: null,
    status: 'qualificado',
    notas: input.notas ? `Manual Olivia: ${input.notas}` : 'Manual Olivia',
    whatsapp_send_status: null,
    whatsapp_msg_id: null,
    whatsapp_sent_at: null,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const validated = validateInput(body)
  if (!validated.ok) return json({ error: validated.error }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const input = validated.input
  const key = manualDedupKey(input.whatsapp)

  const byKey = await supabase.from('leads').select('*').eq('google_place_id', key).maybeSingle()
  if (byKey.error) return json({ error: byKey.error.message }, 502)

  const existingManual = byKey.data
  if (!existingManual) {
    const byWhatsapp = await supabase.from('leads').select('*').eq('whatsapp_phone', input.whatsapp).limit(1)
    if (byWhatsapp.error) return json({ error: byWhatsapp.error.message }, 502)
    const existingPhoneLead = byWhatsapp.data?.[0] ?? null
    if (existingPhoneLead) {
      return json({
        error: 'Este WhatsApp já existe em outro lead. Abra o lead existente para revisar antes de acionar a Olivia.',
        code: 'phone_exists',
        lead: existingPhoneLead,
        created: false,
        reused: true,
      })
    }
  }
  if (!existingManual) {
    const byOwnerWhatsapp = await supabase.from('leads').select('*').eq('whatsapp_dono', input.whatsapp).limit(1)
    if (byOwnerWhatsapp.error) return json({ error: byOwnerWhatsapp.error.message }, 502)
    const existingOwnerPhoneLead = byOwnerWhatsapp.data?.[0] ?? null
    if (existingOwnerPhoneLead) {
      return json({
        error: 'Este WhatsApp já existe como número manual de outro lead. Abra o lead existente para revisar antes de acionar a Olivia.',
        code: 'phone_exists',
        lead: existingOwnerPhoneLead,
        created: false,
        reused: true,
      })
    }
  }

  if (existingManual && !canRetryOutreach(existingManual)) {
    return json({
      error: 'Este WhatsApp já tem disparo registrado. Abra o contato em Disparos para acompanhar, sem reenviar em duplicidade.',
      code: 'already_contacted',
      lead: existingManual,
      created: false,
      reused: true,
    })
  }

  const payload = leadPayload(input, new Date().toISOString())

  if (existingManual) {
    const { data, error } = await supabase
      .from('leads')
      .update(payload)
      .eq('id', existingManual.id)
      .select('*')
      .single()
    if (error) return json({ error: error.message }, 502)
    return json({ lead: data, created: false, reused: true })
  }

  const inserted = await supabase.from('leads').insert(payload).select('*').single()
  if (inserted.error) {
    return json({ error: inserted.error.message }, 502)
  }

  return json({ lead: inserted.data, created: true, reused: false })
})
