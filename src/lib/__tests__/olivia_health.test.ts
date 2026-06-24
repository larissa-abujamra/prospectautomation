import { describe, it, expect } from 'vitest'
import {
  avaliarSaude,
  resumirSaude,
  LIMIARES,
  type HealthExtras,
  type HealthSnapshot,
} from '../../../supabase/functions/_shared/olivia_health'

const snap = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  gerado_em: '2026-06-22T12:00:00Z',
  responder: {
    erros_24h: 0,
    warns_24h: 0,
    erros_por_fonte: {},
    erro_exemplo: null,
    msgs_in_24h: 40,
    msgs_out_24h: 38,
    chats_travados: 0,
    chats_travados_top: [],
    estados: { conversando: 5, agendado: 3 },
    ...(over.responder ?? {}),
  },
  followup: { nudges_24h: 2, continuacoes_24h: 1, nudge_backlog: 0, ...(over.followup ?? {}) },
  reuniao: { reunioes_hoje: 3, proximas_7d: 5, proximas_amostra: [], sync_gaps: 0, ...(over.reuniao ?? {}) },
})

const extras = (over: Partial<HealthExtras> = {}): HealthExtras => ({
  reunioes_sem_props: 0,
  reunioes_checadas: 5,
  hubspot_ok: true,
  ...over,
})

describe('avaliarSaude', () => {
  it('tudo normal → ok, sem issues', () => {
    const { status, issues } = avaliarSaude(snap(), extras())
    expect(status).toBe('ok')
    expect(issues).toHaveLength(0)
  })

  it('inbound sem nenhum outbound em 24h → crit (responder mudo)', () => {
    const { status, issues } = avaliarSaude(snap({ responder: { ...snap().responder, msgs_in_24h: 10, msgs_out_24h: 0 } }), extras())
    expect(status).toBe('crit')
    expect(issues.some((i) => i.area === 'responder' && /NENHUMA/.test(i.msg))).toBe(true)
  })

  it('inbound=0 e outbound=0 → NÃO é crit (dia parado é normal)', () => {
    const { status } = avaliarSaude(snap({ responder: { ...snap().responder, msgs_in_24h: 0, msgs_out_24h: 0 } }), extras())
    expect(status).toBe('ok')
  })

  it('erros >= limiar crit → crit', () => {
    const { status } = avaliarSaude(snap({ responder: { ...snap().responder, erros_24h: LIMIARES.errosCrit, erro_exemplo: 'LLM timeout' } }), extras())
    expect(status).toBe('crit')
  })

  it('erros entre warn e crit → warn (não crit)', () => {
    const { status, issues } = avaliarSaude(snap({ responder: { ...snap().responder, erros_24h: 3, erro_exemplo: 'OCR falhou' } }), extras())
    expect(status).toBe('warn')
    expect(issues.some((i) => /3 erro/.test(i.msg))).toBe(true)
  })

  it('chats travados >= limiar → warn', () => {
    const { status, issues } = avaliarSaude(snap({ responder: { ...snap().responder, chats_travados: LIMIARES.chatsTravadosWarn } }), extras())
    expect(status).toBe('warn')
    expect(issues.some((i) => /esperando resposta/.test(i.msg))).toBe(true)
  })

  it('backlog de nudge alto + zero disparos → warn', () => {
    const { status, issues } = avaliarSaude(snap({ followup: { nudges_24h: 0, continuacoes_24h: 0, nudge_backlog: LIMIARES.nudgeBacklogWarn } }), extras())
    expect(status).toBe('warn')
    expect(issues.some((i) => i.area === 'followup')).toBe(true)
  })

  it('backlog alto MAS com disparos → não acusa (cron está rodando)', () => {
    const { status } = avaliarSaude(snap({ followup: { nudges_24h: 5, continuacoes_24h: 0, nudge_backlog: 99 } }), extras())
    expect(status).toBe('ok')
  })

  it('reuniões futuras sem props (hubspot ok) → warn', () => {
    const { status, issues } = avaliarSaude(snap(), extras({ reunioes_sem_props: 2, reunioes_checadas: 5 }))
    expect(status).toBe('warn')
    expect(issues.some((i) => i.area === 'reuniao' && /lembrete/.test(i.msg))).toBe(true)
  })

  it('props faltando MAS hubspot_ok=false → não acusa (checagem não confiável)', () => {
    const { status } = avaliarSaude(snap(), extras({ reunioes_sem_props: 9, reunioes_checadas: 0, hubspot_ok: false }))
    expect(status).toBe('ok')
  })

  it('gap de sync → warn', () => {
    const { status, issues } = avaliarSaude(snap({ reuniao: { ...snap().reuniao, sync_gaps: 4 } }), extras())
    expect(status).toBe('warn')
    expect(issues.some((i) => /hubspot_contact_id/.test(i.msg))).toBe(true)
  })

  it('crit tem precedência sobre warn', () => {
    const { status } = avaliarSaude(
      snap({ responder: { ...snap().responder, msgs_in_24h: 5, msgs_out_24h: 0, chats_travados: 99 }, reuniao: { ...snap().reuniao, sync_gaps: 3 } }),
      extras({ reunioes_sem_props: 1 }),
    )
    expect(status).toBe('crit')
  })
})

describe('resumirSaude', () => {
  it('ok → linha verde', () => {
    expect(resumirSaude('ok', [])).toMatch(/verde/)
  })
  it('crit → inclui CRIT e a mensagem', () => {
    const s = resumirSaude('crit', [{ nivel: 'crit', area: 'responder', msg: 'X quebrou' }])
    expect(s).toMatch(/CRIT/)
    expect(s).toMatch(/X quebrou/)
  })
})
