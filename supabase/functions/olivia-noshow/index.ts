// Edge Function: olivia-noshow  (cron) — REPORT-ONLY
// =============================================================================
// DECISÃO DE PRODUTO (jun/2026): uma reunião agendada deve PERMANECER na coluna
// "Reunião agendada" do funil mesmo depois da data — quem conduziu a call move o
// lead manualmente quando quiser arquivar. Por isso esta função NÃO mexe mais no
// funil: não muda olivia_estado, não zera reuniao_at, não apaga o evento do
// Google Calendar e não dispara a mensagem de "não te encontrei, quer remarcar?".
//
// Ficou só como RELATÓRIO: lista as reuniões que já passaram do grace e ainda
// estão 'agendado' (possíveis no-shows), pra diagnóstico/visibilidade. Nada é
// alterado. (Histórico: antes ela reabria o agendamento automaticamente — o que
// fazia os cards sumirem da coluna após a data.)
//
// AUTH: só servidor/cron — OLIVIA_TRIGGER_SECRET.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const GRACE_HORAS = 2
const MAX_POR_RUN = 25

interface NoshowRow {
  id: string
  nome: string | null
  reuniao_at: string
  horas_desde_reuniao: number | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) return json({ error: 'Não autorizado.' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: reunioes, error } = await supabase.rpc('olivia_reunioes_noshow', { grace_horas: GRACE_HORAS, limite: MAX_POR_RUN })
  if (error) {
    console.error('olivia-noshow: falha na seleção (RPC)', error.message)
    return json({ error: 'Falha ao selecionar reuniões.' }, 502)
  }
  const lista = (reunioes ?? []) as NoshowRow[]

  // Report-only: nada é alterado (ver cabeçalho).
  return json({
    report_only: true,
    selecionados: lista.length,
    reunioes: lista.map((r) => ({ lead_id: r.id, nome: r.nome, reuniao_at: r.reuniao_at, horas_desde_reuniao: r.horas_desde_reuniao })),
  })
})
