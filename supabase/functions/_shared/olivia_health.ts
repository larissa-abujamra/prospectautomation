// _shared/olivia_health.ts
// =============================================================================
// Lógica PURA de avaliação de saúde da plataforma Olivia (sem I/O) — usada pela
// Edge Function olivia-health-check e coberta por testes. Recebe o snapshot do
// banco (RPC olivia_health_snapshot) + o resultado da checagem de props no
// HubSpot e decide o status (ok | warn | crit) e a lista de problemas.
//
// Princípio: NUNCA conserta nada — só classifica e descreve. A decisão/correção
// é humana (mesma regra do resto da plataforma: nada de auto-mutação).
// =============================================================================

export interface SnapshotResponder {
  erros_24h: number
  warns_24h: number
  erros_por_fonte: Record<string, number>
  erro_exemplo: string | null
  msgs_in_24h: number
  msgs_out_24h: number
  chats_travados: number
  chats_travados_top: Array<{ lead_id: string; estado: string; horas: number }>
  estados: Record<string, number>
}

export interface SnapshotFollowup {
  nudges_24h: number
  continuacoes_24h: number
  nudge_backlog: number
}

export interface SnapshotReuniao {
  reunioes_hoje: number
  proximas_7d: number
  proximas_amostra: Array<{ lead_id: string; hubspot_contact_id: string | null; reuniao_at: string }>
  sync_gaps: number
}

export interface HealthSnapshot {
  gerado_em: string
  responder: SnapshotResponder
  followup: SnapshotFollowup
  reuniao: SnapshotReuniao
}

// Resultado da checagem feita contra a API do HubSpot (fora do banco).
export interface HealthExtras {
  reunioes_sem_props: number // reuniões futuras (amostra) sem data_reuniao/hora_reuniao
  reunioes_checadas: number
  hubspot_ok: boolean // false = token ausente ou API falhou → checagem não confiável
}

export type HealthStatus = 'ok' | 'warn' | 'crit'

export interface HealthIssue {
  nivel: 'crit' | 'warn'
  area: 'responder' | 'followup' | 'reuniao'
  msg: string
}

// Limiares — ajustar AQUI (um lugar só). Conservadores de propósito: o objetivo é
// pegar pane real, não gerar ruído diário.
export const LIMIARES = {
  errosCrit: 25, // >= erros/24h → responder em pane
  errosWarn: 1, // >= → vale um aviso
  chatsTravadosWarn: 8, // conversas vivas esperando resposta há >1h
  nudgeBacklogWarn: 20, // backlog alto + zero disparos = cron de nudge parado
}

// Classifica a saúde. Retorna o status agregado e os problemas encontrados.
export function avaliarSaude(snap: HealthSnapshot, extras: HealthExtras): {
  status: HealthStatus
  issues: HealthIssue[]
} {
  const issues: HealthIssue[] = []
  const r = snap.responder
  const f = snap.followup
  const m = snap.reuniao

  // CRIT — responder mudo: recebeu inbound mas não respondeu NADA em 24h.
  if (r.msgs_in_24h > 0 && r.msgs_out_24h === 0) {
    issues.push({
      nivel: 'crit',
      area: 'responder',
      msg: `Olivia não enviou NENHUMA mensagem em 24h (${r.msgs_in_24h} recebidas). Webhook/responder provavelmente fora do ar.`,
    })
  }

  // CRIT/WARN — volume de erros operacionais (olivia_erros).
  if (r.erros_24h >= LIMIARES.errosCrit) {
    issues.push({ nivel: 'crit', area: 'responder', msg: `${r.erros_24h} erros em 24h (ex.: ${r.erro_exemplo ?? '—'}).` })
  } else if (r.erros_24h >= LIMIARES.errosWarn) {
    issues.push({ nivel: 'warn', area: 'responder', msg: `${r.erros_24h} erro(s) em 24h (ex.: ${r.erro_exemplo ?? '—'}).` })
  }

  // WARN — chats travados (cliente esperando há >1h).
  if (r.chats_travados >= LIMIARES.chatsTravadosWarn) {
    issues.push({ nivel: 'warn', area: 'responder', msg: `${r.chats_travados} conversas vivas com cliente esperando resposta há >1h.` })
  }

  // WARN — cron de nudge possivelmente parado (backlog alto, zero disparos).
  if (f.nudge_backlog >= LIMIARES.nudgeBacklogWarn && f.nudges_24h === 0 && f.continuacoes_24h === 0) {
    issues.push({ nivel: 'warn', area: 'followup', msg: `${f.nudge_backlog} chats elegíveis a nudge e 0 disparos em 24h — cron de nudge pode estar parado.` })
  }

  // WARN — reuniões futuras sem as props do HubSpot → não recebem lembrete.
  if (extras.hubspot_ok && extras.reunioes_sem_props > 0) {
    issues.push({
      nivel: 'warn',
      area: 'reuniao',
      msg: `${extras.reunioes_sem_props}/${extras.reunioes_checadas} reuniões futuras sem data_reuniao/hora_reuniao no HubSpot — NÃO receberão lembrete.`,
    })
  }

  // WARN — leads ativos sem hubspot_contact_id (gap de sync).
  if (m.sync_gaps > 0) {
    issues.push({ nivel: 'warn', area: 'reuniao', msg: `${m.sync_gaps} leads ativos sem hubspot_contact_id (gap de sync HubSpot↔Supabase).` })
  }

  const status: HealthStatus = issues.some((i) => i.nivel === 'crit')
    ? 'crit'
    : issues.some((i) => i.nivel === 'warn')
    ? 'warn'
    : 'ok'

  return { status, issues }
}

// Resumo de uma linha — vai pro olivia_erros (canal de alerta interno) e pro log.
export function resumirSaude(status: HealthStatus, issues: HealthIssue[]): string {
  if (status === 'ok') return 'Olivia health: tudo verde.'
  return `Olivia health: ${status.toUpperCase()} — ${issues.map((i) => i.msg).join(' | ')}`
}
