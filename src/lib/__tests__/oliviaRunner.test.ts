import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks ANTES dos imports do módulo testado: nada de rede nos testes.
// O mock do supabase cobre o update direto (qualificar) e evita o throw de
// env ausente em lib/supabase.
const h = vi.hoisted(() => {
  const eq = vi.fn()
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  return { eq, update, from }
})

vi.mock('../supabase', () => ({
  supabase: { from: h.from },
}))

vi.mock('../leads', () => ({
  enriquecerLead: vi.fn(),
  encontrarWhatsapp: vi.fn(),
  exportarHubspot: vi.fn(),
  syncHubspot: vi.fn(),
}))

import { runOlivia } from '../oliviaRunner'
import type { OliviaProgresso } from '../oliviaRunner'
import { enriquecerLead, encontrarWhatsapp, exportarHubspot, syncHubspot } from '../leads'
import type { EnrichResult, ExportResult, HubspotSyncResult, WhatsappResult } from '../leads'
import type { Lead } from '../types'

const enriquecerMock = vi.mocked(enriquecerLead)
const whatsappMock = vi.mocked(encontrarWhatsapp)
const exportarMock = vi.mocked(exportarHubspot)
const syncMock = vi.mocked(syncHubspot)

// ——— Fábricas de retorno (só os campos que o runner lê) ———

const enrichOk = (): EnrichResult =>
  ({ lead: {} as Lead, enrich_status: { cnpj: 'ok' } }) as EnrichResult

const whatsappCom = (phone = '+5511963366136'): WhatsappResult =>
  ({
    lead: { whatsapp_phone: phone, whatsapp_dono: null },
    whatsapp_status: 'found',
    source: 'google',
  }) as unknown as WhatsappResult

const whatsappSem = (): WhatsappResult =>
  ({
    lead: { whatsapp_phone: null, whatsapp_dono: null },
    whatsapp_status: 'missing',
    source: null,
  }) as unknown as WhatsappResult

const exportOk = (): ExportResult => ({ exported: [], skipped: [] })

const syncOk = (): HubspotSyncResult => ({
  contactId: 'c1',
  created: true,
  triggered: true,
  properties: {},
})

// Extrai a trilha [etapa, status] de um lead específico, na ordem emitida.
function trilha(eventos: OliviaProgresso[], leadId: string): [string, string][] {
  return eventos.filter((e) => e.leadId === leadId).map((e) => [e.etapa, e.status])
}

beforeEach(() => {
  vi.clearAllMocks()
  // Caminho feliz por padrão; cada teste sobrescreve o que precisa.
  h.eq.mockResolvedValue({ error: null })
  enriquecerMock.mockResolvedValue(enrichOk())
  whatsappMock.mockResolvedValue(whatsappCom())
  exportarMock.mockResolvedValue(exportOk())
  syncMock.mockResolvedValue(syncOk())
})

describe('runOlivia — caminho feliz', () => {
  it('emite as etapas na ordem e devolve o resumo certo', async () => {
    const eventos: OliviaProgresso[] = []
    const resumo = await runOlivia(
      [{ id: 'l1', nome: 'Pietra Pâtisserie' }],
      (p) => eventos.push(p),
    )

    expect(trilha(eventos, 'l1')).toEqual([
      ['enriquecer', 'rodando'],
      ['enriquecer', 'ok'],
      ['whatsapp', 'rodando'],
      ['whatsapp', 'ok'],
      ['hubspot', 'rodando'],
      ['hubspot', 'ok'],
      ['disparo', 'rodando'],
      ['disparo', 'ok'],
      ['fim', 'ok'],
    ])
    expect(eventos[0].nome).toBe('Pietra Pâtisserie')
    expect(resumo).toEqual({
      total: 1,
      enriquecidos: 1,
      comNumero: 1,
      semNumero: 0,
      disparados: 1,
      erros: 0,
    })
  })

  it('qualifica o lead no Supabase antes do pipeline (entra na Base)', async () => {
    await runOlivia([{ id: 'l1', nome: 'Doceria A' }], () => {})

    expect(h.from).toHaveBeenCalledWith('leads')
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'qualificado' }),
    )
    expect(h.eq).toHaveBeenCalledWith('id', 'l1')
  })

  it('chama as funções com os parâmetros do contrato (force=false, trigger=true)', async () => {
    await runOlivia([{ id: 'l1', nome: 'Doceria A' }], () => {})

    expect(enriquecerMock).toHaveBeenCalledWith('l1', false)
    expect(whatsappMock).toHaveBeenCalledWith('l1', false)
    expect(exportarMock).toHaveBeenCalledWith(['l1'])
    expect(syncMock).toHaveBeenCalledWith('l1', true)
  })
})

describe('runOlivia — lead sem número', () => {
  it('pula o disparo, conta semNumero e AINDA exporta pro HubSpot', async () => {
    whatsappMock.mockResolvedValue(whatsappSem())
    const eventos: OliviaProgresso[] = []

    const resumo = await runOlivia([{ id: 'l1', nome: 'Doceria B' }], (p) => eventos.push(p))

    expect(trilha(eventos, 'l1')).toEqual([
      ['enriquecer', 'rodando'],
      ['enriquecer', 'ok'],
      ['whatsapp', 'rodando'],
      ['whatsapp', 'sem_numero'],
      ['hubspot', 'rodando'],
      ['hubspot', 'ok'],
      ['fim', 'sem_numero'],
    ])
    expect(exportarMock).toHaveBeenCalledWith(['l1']) // negócio entra mesmo sem nº
    expect(syncMock).not.toHaveBeenCalled() // disparo pulado
    expect(resumo).toEqual({
      total: 1,
      enriquecidos: 1,
      comNumero: 0,
      semNumero: 1,
      disparados: 0,
      erros: 0,
    })
  })

  it('nº manual da dona(o) (whatsapp_dono) destrava o disparo mesmo sem nº da loja', async () => {
    whatsappMock.mockResolvedValue({
      lead: { whatsapp_phone: null, whatsapp_dono: '+5511988887777' },
      whatsapp_status: 'missing',
      source: null,
    } as unknown as WhatsappResult)

    const resumo = await runOlivia([{ id: 'l1', nome: 'Doceria C' }], () => {})

    expect(syncMock).toHaveBeenCalledWith('l1', true)
    expect(resumo.comNumero).toBe(1)
    expect(resumo.disparados).toBe(1)
  })
})

describe('runOlivia — erros não derrubam o lote', () => {
  it('erro em enriquecer não aborta o lead: segue até o disparo e conta em erros', async () => {
    enriquecerMock.mockImplementation(async (id) => {
      if (id === 'l1') throw new Error('BrasilAPI fora do ar')
      return enrichOk()
    })
    const eventos: OliviaProgresso[] = []

    const resumo = await runOlivia(
      [
        { id: 'l1', nome: 'Doceria Com Erro' },
        { id: 'l2', nome: 'Doceria OK' },
      ],
      (p) => eventos.push(p),
      { concurrency: 1 },
    )

    // l1: enriquecer falhou mas o pipeline continuou inteiro.
    expect(trilha(eventos, 'l1')).toEqual([
      ['enriquecer', 'rodando'],
      ['enriquecer', 'erro'],
      ['whatsapp', 'rodando'],
      ['whatsapp', 'ok'],
      ['hubspot', 'rodando'],
      ['hubspot', 'ok'],
      ['disparo', 'rodando'],
      ['disparo', 'ok'],
      ['fim', 'erro'],
    ])
    const eventoErro = eventos.find((e) => e.leadId === 'l1' && e.status === 'erro')
    expect(eventoErro?.erro).toBe('BrasilAPI fora do ar')

    // l2: o lote não foi derrubado — terminou ok.
    expect(trilha(eventos, 'l2').at(-1)).toEqual(['fim', 'ok'])
    expect(resumo).toEqual({
      total: 2,
      enriquecidos: 1, // só l2 enriqueceu de verdade
      comNumero: 2,
      semNumero: 0,
      disparados: 2, // l1 ainda disparou (tinha número)
      erros: 1,
    })
  })

  it('erro em disparo conta em erros e não derruba o lote', async () => {
    syncMock.mockRejectedValue(new Error('HubSpot 500'))
    const eventos: OliviaProgresso[] = []

    const resumo = await runOlivia([{ id: 'l1', nome: 'Doceria D' }], (p) => eventos.push(p))

    expect(trilha(eventos, 'l1')).toEqual([
      ['enriquecer', 'rodando'],
      ['enriquecer', 'ok'],
      ['whatsapp', 'rodando'],
      ['whatsapp', 'ok'],
      ['hubspot', 'rodando'],
      ['hubspot', 'ok'],
      ['disparo', 'rodando'],
      ['disparo', 'erro'],
      ['fim', 'erro'],
    ])
    expect(resumo).toEqual({
      total: 1,
      enriquecidos: 1,
      comNumero: 1,
      semNumero: 0,
      disparados: 0, // disparo falhou → não conta como disparado
      erros: 1,
    })
  })

  it('sync sem gatilho confirmado (triggered=false) NÃO conta como disparado', async () => {
    syncMock.mockResolvedValue({ ...syncOk(), triggered: false })

    const resumo = await runOlivia([{ id: 'l1', nome: 'Doceria E' }], () => {})

    expect(resumo.disparados).toBe(0)
    expect(resumo.erros).toBe(1)
  })

  it('erro em encontrar-whatsapp: sem nº confirmado → pula disparo, conta erro, exporta', async () => {
    whatsappMock.mockRejectedValue(new Error('timeout'))

    const resumo = await runOlivia([{ id: 'l1', nome: 'Doceria F' }], () => {})

    expect(exportarMock).toHaveBeenCalledWith(['l1'])
    expect(syncMock).not.toHaveBeenCalled()
    expect(resumo).toEqual({
      total: 1,
      enriquecidos: 1,
      comNumero: 0,
      semNumero: 1,
      disparados: 0,
      erros: 1,
    })
  })
})

describe('runOlivia — concorrência', () => {
  it('respeita o máximo de N leads rodando ao mesmo tempo (default 2)', async () => {
    // Promessas controladas: o enriquecer de cada lead só termina quando o
    // teste manda. Assim dá pra observar quantos pipelines estão ativos.
    const resolvers: (() => void)[] = []
    enriquecerMock.mockImplementation(
      () =>
        new Promise<EnrichResult>((resolve) => {
          resolvers.push(() => resolve(enrichOk()))
        }),
    )

    const leads = [
      { id: 'l1', nome: 'A' },
      { id: 'l2', nome: 'B' },
      { id: 'l3', nome: 'C' },
      { id: 'l4', nome: 'D' },
    ]
    const promessa = runOlivia(leads, () => {})

    // Com concorrência 2, só os 2 primeiros pipelines começam.
    await vi.waitFor(() => expect(enriquecerMock).toHaveBeenCalledTimes(2))
    expect(enriquecerMock).toHaveBeenCalledTimes(2)

    // Libera os 2 primeiros → os workers pegam os 2 próximos da fila.
    resolvers[0]()
    resolvers[1]()
    await vi.waitFor(() => expect(enriquecerMock).toHaveBeenCalledTimes(4))

    resolvers[2]()
    resolvers[3]()
    const resumo = await promessa
    expect(resumo.total).toBe(4)
    expect(resumo.erros).toBe(0)
  })

  it('aceita concorrência customizada via opts', async () => {
    const resolvers: (() => void)[] = []
    enriquecerMock.mockImplementation(
      () =>
        new Promise<EnrichResult>((resolve) => {
          resolvers.push(() => resolve(enrichOk()))
        }),
    )

    const leads = [
      { id: 'l1', nome: 'A' },
      { id: 'l2', nome: 'B' },
      { id: 'l3', nome: 'C' },
    ]
    const promessa = runOlivia(leads, () => {}, { concurrency: 1 })

    await vi.waitFor(() => expect(enriquecerMock).toHaveBeenCalledTimes(1))
    expect(enriquecerMock).toHaveBeenCalledTimes(1)

    resolvers[0]()
    await vi.waitFor(() => expect(enriquecerMock).toHaveBeenCalledTimes(2))
    resolvers[1]()
    await vi.waitFor(() => expect(enriquecerMock).toHaveBeenCalledTimes(3))
    resolvers[2]()

    const resumo = await promessa
    expect(resumo.total).toBe(3)
  })

  it('lote vazio devolve resumo zerado sem chamar nada', async () => {
    const resumo = await runOlivia([], () => {})

    expect(resumo).toEqual({
      total: 0,
      enriquecidos: 0,
      comNumero: 0,
      semNumero: 0,
      disparados: 0,
      erros: 0,
    })
    expect(enriquecerMock).not.toHaveBeenCalled()
  })
})
