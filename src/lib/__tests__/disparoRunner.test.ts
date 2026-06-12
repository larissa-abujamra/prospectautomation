import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks ANTES do import do módulo testado: zero rede. Mesmo padrão do oliviaRunner.test.
vi.mock('../leads', () => ({
  encontrarWhatsapp: vi.fn(),
  syncHubspot: vi.fn(),
}))

import { dispararLead, dispararLote } from '../disparoRunner'
import { encontrarWhatsapp, syncHubspot } from '../leads'
import type { HubspotSyncResult, WhatsappResult } from '../leads'
import type { Lead } from '../types'

const whatsappMock = vi.mocked(encontrarWhatsapp)
const syncMock = vi.mocked(syncHubspot)

const whatsappCom = (phone = '+5511963366136'): WhatsappResult =>
  ({ lead: { whatsapp_phone: phone } as Lead, whatsapp_status: 'found', source: 'google' }) as WhatsappResult
const whatsappSem = (): WhatsappResult =>
  ({ lead: { whatsapp_phone: null } as Lead, whatsapp_status: 'missing', source: null }) as WhatsappResult
const syncTriggered = (triggered = true): HubspotSyncResult =>
  ({ contactId: 'c1', created: false, triggered, properties: {} }) as HubspotSyncResult
const syncWorkflowTriggered = (workflowTriggered: boolean, triggered = false): HubspotSyncResult =>
  ({ contactId: 'c1', created: false, triggered, workflow_triggered: workflowTriggered, properties: {} }) as HubspotSyncResult

const lead = (over: Partial<Lead> = {}): Pick<Lead, 'id' | 'whatsapp_phone' | 'whatsapp_dono'> =>
  ({ id: 'L1', whatsapp_phone: null, whatsapp_dono: null, ...over })

beforeEach(() => {
  whatsappMock.mockReset()
  syncMock.mockReset()
})

describe('dispararLead', () => {
  it('com número da loja: aciona o gatilho e não procura número de novo', async () => {
    syncMock.mockResolvedValue(syncTriggered())
    const r = await dispararLead(lead({ whatsapp_phone: '+5511999990000' }))
    expect(whatsappMock).not.toHaveBeenCalled()
    expect(syncMock).toHaveBeenCalledWith('L1', true)
    expect(r).toMatchObject({ leadId: 'L1', ok: true, semNumero: false })
  })

  it('prefere o whatsapp_dono ao número da loja (não procura)', async () => {
    syncMock.mockResolvedValue(syncTriggered())
    const r = await dispararLead(lead({ whatsapp_phone: '+5511111111111', whatsapp_dono: '+5511988887777' }))
    expect(whatsappMock).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('sem número: procura, acha e dispara', async () => {
    whatsappMock.mockResolvedValue(whatsappCom())
    syncMock.mockResolvedValue(syncTriggered())
    const r = await dispararLead(lead())
    expect(whatsappMock).toHaveBeenCalledWith('L1', false)
    expect(syncMock).toHaveBeenCalledWith('L1', true)
    expect(r.ok).toBe(true)
  })

  it('sem número e não acha: marca semNumero e NÃO chama o HubSpot (anti-invenção)', async () => {
    whatsappMock.mockResolvedValue(whatsappSem())
    const r = await dispararLead(lead())
    expect(syncMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: false, semNumero: true })
  })

  it('gatilho não confirmado (triggered=false): erro, não finge disparo', async () => {
    syncMock.mockResolvedValue(syncTriggered(false))
    const r = await dispararLead(lead({ whatsapp_phone: '+5511999990000' }))
    expect(r.ok).toBe(false)
    expect(r.semNumero).toBe(false)
    expect(r.motivo).toBeTruthy()
  })

  it('aceita workflow_triggered=true mesmo quando o flag legado vem falso', async () => {
    syncMock.mockResolvedValue(syncWorkflowTriggered(true, false))
    const r = await dispararLead(lead({ whatsapp_phone: '+5511999990000' }))
    expect(r).toMatchObject({ ok: true, semNumero: false })
  })

  it('workflow_triggered=false tem precedência sobre triggered legado', async () => {
    syncMock.mockResolvedValue(syncWorkflowTriggered(false, true))
    const r = await dispararLead(lead({ whatsapp_phone: '+5511999990000' }))
    expect(r.ok).toBe(false)
    expect(r.motivo).toContain('Gatilho do workflow')
  })

  it('syncHubspot lança: erro capturado com motivo', async () => {
    syncMock.mockRejectedValue(new Error('HubSpot 422'))
    const r = await dispararLead(lead({ whatsapp_phone: '+5511999990000' }))
    expect(r.ok).toBe(false)
    expect(r.motivo).toContain('HubSpot 422')
  })
})

describe('dispararLote', () => {
  it('agrega resumo (disparados / semNumero / erros) e erro num lead não derruba o lote', async () => {
    // L1 dispara ok; L2 sem número; L3 estoura no sync
    whatsappMock.mockResolvedValue(whatsappSem())
    syncMock.mockImplementation((id) =>
      id === 'L3' ? Promise.reject(new Error('boom')) : Promise.resolve(syncTriggered()),
    )
    const progresso: { leadId: string; ok: boolean }[] = []
    const resumo = await dispararLote(
      [lead({ id: 'L1', whatsapp_phone: '+5511900000001' }), lead({ id: 'L2' }), lead({ id: 'L3', whatsapp_phone: '+5511900000003' })],
      (p) => progresso.push({ leadId: p.leadId, ok: p.ok }),
    )
    expect(resumo).toEqual({ total: 3, disparados: 1, semNumero: 1, erros: 1 })
    expect(progresso).toHaveLength(3)
  })

  it('lote vazio: resumo zerado, sem chamadas', async () => {
    const resumo = await dispararLote([])
    expect(resumo).toEqual({ total: 0, disparados: 0, semNumero: 0, erros: 0 })
    expect(syncMock).not.toHaveBeenCalled()
  })
})
