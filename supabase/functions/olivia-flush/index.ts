// Edge Function: olivia-flush
// =============================================================================
// Olivia Autônoma (Fase B — horário comercial): envia as respostas que foram
// ADIADAS por terem chegado fora do expediente. Acionada por um cron (pg_cron)
// que roda dentro do horário comercial — ver migration 0014.
//
// FLUXO: seleciona leads com olivia_reply_apos <= now() → para cada um, "reivindica"
// (limpa o marcador, pra um próximo flush não repicar) e dispara a olivia-responder
// (fire-and-forget; a responder agora roda DENTRO do horário, então compõe e envia).
//
// SEGURANÇA: só servidor — exige OLIVIA_TRIGGER_SECRET (x-olivia-secret) OU usuário
// logado (teste manual). Deploy: supabase functions deploy olivia-flush --no-verify-jwt
//
// Secrets: OLIVIA_TRIGGER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const MAX_LOTE = 50 // teto por execução; o próximo tick do cron pega o resto

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  const headerSecret = req.headers.get('x-olivia-secret')
  const autorizado = (!!secret && headerSecret === secret) || (await requireAuthenticatedUser(req))
  if (!autorizado) return json({ error: 'Não autorizado.' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabase = createClient(supabaseUrl!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Vencidos: têm resposta adiada cujo horário de envio já chegou.
  const { data: vencidos, error } = await supabase
    .from('leads')
    .select('id')
    .not('olivia_reply_apos', 'is', null)
    .lte('olivia_reply_apos', new Date().toISOString())
    .limit(MAX_LOTE)
  if (error) {
    console.error('olivia-flush: falha ao buscar vencidos', error.message)
    return json({ error: 'Falha ao buscar respostas adiadas.' }, 502)
  }
  if (!vencidos || vencidos.length === 0) return json({ processados: 0 })

  const responderUrl = `${supabaseUrl}/functions/v1/olivia-responder`
  const pendentes: Promise<unknown>[] = []
  let n = 0
  for (const lead of vencidos) {
    // Reivindica: limpa o marcador antes de disparar, pra um flush concorrente/seguinte
    // não processar o mesmo lead duas vezes. A responder também o limpa ao concluir.
    await supabase.from('leads').update({ olivia_reply_apos: null }).eq('id', lead.id)
    // Fire-and-forget: a responder faz o trabalho (LLM + pacing + envio) por conta.
    pendentes.push(
      fetch(responderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-olivia-secret': secret ?? '' },
        body: JSON.stringify({ lead_id: lead.id }),
      })
        .then((r) => { if (!r.ok) console.error('olivia-flush: responder', lead.id, r.status) })
        .catch((e) => console.error('olivia-flush: falha ao chamar responder', lead.id, e?.message)),
    )
    n++
  }

  // Mantém a function viva até os disparos terminarem, sem bloquear o return.
  try {
    ;(globalThis as { EdgeRuntime?: { waitUntil?: (pr: Promise<unknown>) => void } }).EdgeRuntime
      ?.waitUntil?.(Promise.allSettled(pendentes))
  } catch { /* runtime sem waitUntil (local): os disparos seguem no event loop */ }

  return json({ processados: n })
})
