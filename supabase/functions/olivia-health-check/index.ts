// Edge Function: olivia-health-check
// =============================================================================
// Monitoramento de saúde server-side da plataforma Olivia. Roda 2x/dia (GitHub
// Actions → x-olivia-secret). Em UMA chamada ao banco (RPC olivia_health_snapshot)
// coleta: erros do responder, chats travados, throughput, pipeline de follow-up
// e integridade dos dados de reunião. Complementa com a API do HubSpot (as
// reuniões futuras têm data_reuniao/hora_reuniao?). Classifica ok|warn|crit
// (olivia_health.ts), grava em olivia_health_checks e, se crit/warn, registra em
// olivia_erros (canal de alerta interno que o time já enxerga).
//
// READ-ONLY no que toca à operação: NUNCA muda workflow/contato/lead nem envia
// mensagem. A única escrita é o log de saúde (e o alerta em olivia_erros).
//
// GAP CONHECIDO: a execução do workflow de lembrete (enrollment runs) não é
// checada aqui — a private app não tem o escopo `automation`. Verificação dessa
// parte continua pelo runbook (Playwright). Ver .claude/plans/.../README.md.
//
// SEGURANÇA: só servidor/cron — OLIVIA_TRIGGER_SECRET (header x-olivia-secret).
// Deploy SEM JWT. DRY-RUN por padrão: { "dry_run": false } persiste de verdade.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OLIVIA_TRIGGER_SECRET,
//          HUBSPOT_PRIVATE_APP_TOKEN (opcional — sem ele, pula a checagem HubSpot).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  avaliarSaude,
  resumirSaude,
  type HealthExtras,
  type HealthSnapshot,
  type SnapshotReuniao,
} from '../_shared/olivia_health.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const HUBSPOT_BASE = 'https://api.hubapi.com'
const HUBSPOT_TIMEOUT_MS = 10_000

// Checa, na amostra de reuniões futuras, quantas estão sem data_reuniao/hora_reuniao
// no HubSpot (essas NÃO recebem lembrete). Sem token → checagem pulada (hubspot_ok=false).
async function checarPropsHubspot(
  amostra: SnapshotReuniao['proximas_amostra'],
  token: string | undefined,
): Promise<HealthExtras> {
  if (!token) return { reunioes_sem_props: 0, reunioes_checadas: 0, hubspot_ok: false }
  const comContato = amostra.filter((a) => a.hubspot_contact_id)
  if (comContato.length === 0) return { reunioes_sem_props: 0, reunioes_checadas: 0, hubspot_ok: true }

  const resultados = await Promise.all(
    comContato.map(async (a) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), HUBSPOT_TIMEOUT_MS)
      try {
        const r = await fetch(
          `${HUBSPOT_BASE}/crm/v3/objects/contacts/${a.hubspot_contact_id}?properties=data_reuniao,hora_reuniao`,
          { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
        )
        if (!r.ok) return { erro: true as const }
        const d = await r.json()
        const p = (d?.properties ?? {}) as { data_reuniao?: string; hora_reuniao?: string }
        return { falta: !p.data_reuniao || !p.hora_reuniao }
      } catch {
        return { erro: true as const }
      } finally {
        clearTimeout(timeout)
      }
    }),
  )

  let sem = 0
  let checadas = 0
  let ok = true
  for (const x of resultados) {
    if ('erro' in x) {
      ok = false // qualquer falha de API torna a checagem não confiável
      continue
    }
    checadas++
    if (x.falta) sem++
  }
  return { reunioes_sem_props: sem, reunioes_checadas: checadas, hubspot_ok: ok }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  const secret = Deno.env.get('OLIVIA_TRIGGER_SECRET')
  if (!secret || req.headers.get('x-olivia-secret') !== secret) {
    return json({ error: 'Não autorizado.' }, 401)
  }

  let dryRun = true
  let runKind = 'manual'
  try {
    const b = await req.json().catch(() => ({}))
    if (b && typeof b === 'object') {
      if ((b as { dry_run?: unknown }).dry_run === false) dryRun = false
      const k = (b as { run_kind?: unknown }).run_kind
      if (k === 'morning' || k === 'evening' || k === 'manual') runKind = k
    }
  } catch {
    /* corpo vazio → dry-run, manual */
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // 1) Snapshot do banco em uma chamada.
  const { data: snapData, error: snapErr } = await supabase.rpc('olivia_health_snapshot')
  if (snapErr || !snapData) {
    console.error('olivia-health-check: falha no snapshot', snapErr?.message)
    return json({ error: 'Falha ao coletar snapshot.', detalhe: snapErr?.message ?? null }, 502)
  }
  const snapshot = snapData as HealthSnapshot

  // 2) Complemento HubSpot: reuniões futuras sem props (não recebem lembrete).
  const extras = await checarPropsHubspot(
    snapshot.reuniao.proximas_amostra,
    Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN'),
  )

  // 3) Classifica.
  const { status, issues } = avaliarSaude(snapshot, extras)
  const resumo = resumirSaude(status, issues)
  const resultado = {
    status,
    run_kind: runKind,
    gerado_em: snapshot.gerado_em,
    issues,
    snapshot,
    hubspot: extras,
    // Parte que precisa de escopo `automation` — não checada aqui (ver runbook).
    flow_execution_check: 'não verificado server-side (private app sem escopo automation) — usar runbook Playwright',
  }

  if (dryRun) {
    return json({ dry_run: true, status, issues_n: issues.length, resumo, resultado })
  }

  // 4) Persiste o log de saúde. Falha aqui não derruba a checagem (retorna 200 com aviso).
  const { error: insErr } = await supabase.from('olivia_health_checks').insert({
    run_kind: runKind,
    status,
    issues: issues.length,
    resultado,
  })
  if (insErr) console.error('olivia-health-check: falha ao gravar health log', insErr.message)

  // 5) Alerta interno: crit/warn vira linha em olivia_erros (o time já enxerga lá).
  if (status !== 'ok') {
    const { error: errLogErr } = await supabase.from('olivia_erros').insert({
      fonte: 'olivia-health-check',
      nivel: status === 'crit' ? 'error' : 'warn',
      mensagem: resumo.slice(0, 1000),
      contexto: { status, run_kind: runKind, issues },
    })
    if (errLogErr) console.error('olivia-health-check: falha ao registrar alerta', errLogErr.message)
  }

  return json({ dry_run: false, status, issues_n: issues.length, resumo, persisted: !insErr, resultado })
})
