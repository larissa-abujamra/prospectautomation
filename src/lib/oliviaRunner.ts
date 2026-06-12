import { supabase } from './supabase'
import { encontrarWhatsapp, enriquecerLead, exportarHubspot, syncHubspot } from './leads'
import type { EnrichStatus } from './types'

// Orquestrador do fluxo Olivia (Fase 3 do re-layout). Por lead, em sequência:
// qualifica (entra na Base) → enriquece → acha WhatsApp → exporta HubSpot
// (negócio em Squad Prospects) → aciona o workflow (sync com trigger; o workflow
// F/M do HubSpot envia o template). Concorrência limitada no padrão worker
// do enrichRunner. Erro num lead NUNCA derruba o lote; cada etapa é isolada e
// o resumo agrega tudo no fim.

export type OliviaEtapa = 'enriquecer' | 'whatsapp' | 'hubspot' | 'disparo' | 'fim'
export type OliviaStatus = 'pendente' | 'rodando' | 'ok' | 'sem_numero' | 'erro' | 'cancelado'

export interface OliviaProgresso {
  leadId: string
  nome: string
  etapa: OliviaEtapa
  status: OliviaStatus
  erro?: string
}

export interface OliviaResumo {
  total: number
  enriquecidos: number
  comNumero: number
  semNumero: number
  disparados: number
  erros: number
  cancelados: number
}

// Concorrência default conservadora: as Edge Functions chamam APIs externas
// com rate limit (BrasilAPI, HubSpot); 2 workers é o equilíbrio seguro.
const CONCORRENCIA_PADRAO = 2

// Mesmo payload do useAdvanceToEnrich (lib/leads): a UI mostra "enriquecendo"
// imediatamente enquanto o pipeline roda.
const ENRICH_PENDENTE: EnrichStatus = { cnpj: 'pending', dono: 'pending', instagram: 'pending' }

// Resultado interno por lead, agregado no resumo ao final do lote.
interface ResultadoLead {
  enriquecido: boolean
  comNumero: boolean
  disparado: boolean
  teveErro: boolean
  cancelado: boolean
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro)
}

// Pipeline de UM lead. Nunca lança: toda falha vira progresso 'erro' + flag no
// resultado. Erro numa etapa NÃO aborta o lead; ele fica na Base para
// completar depois (anti-perda de dado).
async function processarLead(
  lead: { id: string; nome: string },
  onProgresso: (p: OliviaProgresso) => void,
): Promise<ResultadoLead> {
  const emitir = (etapa: OliviaEtapa, status: OliviaStatus, erro?: string) =>
    onProgresso({
      leadId: lead.id,
      nome: lead.nome,
      etapa,
      status,
      ...(erro ? { erro } : {}),
    })

  let enriquecido = false
  let comNumero = false
  let disparado = false
  let teveErro = false

  // 1) Entra na Base: marca 'qualificado' + enrich pendente (update direto no
  // Supabase, igual ao useAdvanceToEnrich). Falha aqui não aborta o lead.
  try {
    const { error } = await supabase
      .from('leads')
      .update({ status: 'qualificado', enrich_status: ENRICH_PENDENTE })
      .eq('id', lead.id)
    if (error) throw error
  } catch {
    teveErro = true
  }

  // 2) Enriquecer (CNPJ + dono + seguidores). Erro NÃO aborta: o lead segue na
  // Base para completar o enriquecimento depois.
  emitir('enriquecer', 'rodando')
  try {
    await enriquecerLead(lead.id, false) // force=false → não re-gasta saldo
    enriquecido = true
    emitir('enriquecer', 'ok')
  } catch (erro) {
    teveErro = true
    emitir('enriquecer', 'erro', mensagemDe(erro))
  }

  // 3) WhatsApp (descoberta do número). Sem número confirmado = sem número
  // (anti-invenção): pula só o disparo; o negócio ainda entra no HubSpot.
  emitir('whatsapp', 'rodando')
  try {
    const r = await encontrarWhatsapp(lead.id, false)
    const semNumeroAchado =
      r.whatsapp_status === 'missing' ||
      r.whatsapp_status === 'invalid' ||
      r.lead?.whatsapp_phone == null
    // Nº manual da dona(o) também destrava o disparo (preferido no template).
    const temNumeroManual = !!r.lead?.whatsapp_dono?.trim()
    comNumero = !semNumeroAchado || temNumeroManual
    emitir('whatsapp', comNumero ? 'ok' : 'sem_numero')
  } catch (erro) {
    // Erro na descoberta: nenhum número confirmado → segue sem disparo.
    teveErro = true
    emitir('whatsapp', 'erro', mensagemDe(erro))
  }

  // 4) HubSpot: cria o negócio em Squad Prospects; mesmo sem número, o lead
  // entra no pipeline (follow-up manual depois).
  emitir('hubspot', 'rodando')
  try {
    await exportarHubspot([lead.id])
    emitir('hubspot', 'ok')
  } catch (erro) {
    teveErro = true
    emitir('hubspot', 'erro', mensagemDe(erro))
  }

  // 5) Disparo (só com número): sync com trigger=true marca
  // whatsapp_outreach='ready'. O workflow F/M do HubSpot faz o envio.
  if (comNumero) {
    emitir('disparo', 'rodando')
    try {
      const r = await syncHubspot(lead.id, true)
      if (r.workflow_triggered ?? r.triggered) {
        disparado = true
        emitir('disparo', 'ok')
      } else {
        // Sync passou mas o gatilho não foi confirmado: não inventa "disparado".
        teveErro = true
        emitir('disparo', 'erro', 'Gatilho do workflow não confirmado pelo sync')
      }
    } catch (erro) {
      teveErro = true
      emitir('disparo', 'erro', mensagemDe(erro))
    }
  }

  // 6) Fim, status final do lead no lote.
  const statusFinal: OliviaStatus = teveErro ? 'erro' : comNumero ? 'ok' : 'sem_numero'
  emitir('fim', statusFinal)

  return { enriquecido, comNumero, disparado, teveErro, cancelado: false }
}

// Resultado de um lead que NUNCA iniciou o pipeline (lote cancelado).
function resultadoCancelado(): ResultadoLead {
  return { enriquecido: false, comNumero: false, disparado: false, teveErro: false, cancelado: true }
}

// Roda o fluxo Olivia para um lote de leads com concorrência limitada
// (default 2, padrão worker do enrichRunner). Emite onProgresso a cada
// transição etapa/status e devolve o resumo agregado do lote.
// Cancelamento (opts.signal): quando abortado, NENHUM lead novo inicia o
// pipeline; leads já em andamento completam normalmente. Cada lead
// nunca-iniciado emite UM evento 'cancelado' (etapa 'fim') e conta em
// resumo.cancelados. Sem signal, o comportamento é idêntico ao anterior.
export async function runOlivia(
  leads: { id: string; nome: string }[],
  onProgresso: (p: OliviaProgresso) => void,
  opts?: { concurrency?: number; signal?: AbortSignal },
): Promise<OliviaResumo> {
  const concorrencia = Math.max(1, Math.floor(opts?.concurrency ?? CONCORRENCIA_PADRAO))
  const signal = opts?.signal
  const resultados: ResultadoLead[] = []

  // Índice compartilhado entre workers: cada lead é pego exatamente uma vez,
  // inclusive no dreno de cancelamento (garante UM evento por lead).
  let i = 0
  const worker = async () => {
    while (i < leads.length) {
      const idx = i++
      // Aborto checado ANTES de iniciar o pipeline: o lead nunca-iniciado é
      // drenado da fila com status 'cancelado' (etapa 'fim'), uma única vez.
      if (signal?.aborted) {
        onProgresso({
          leadId: leads[idx].id,
          nome: leads[idx].nome,
          etapa: 'fim',
          status: 'cancelado',
        })
        resultados[idx] = resultadoCancelado()
        continue
      }
      // processarLead nunca lança; erro num lead não derruba o lote.
      resultados[idx] = await processarLead(leads[idx], onProgresso)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concorrencia, leads.length) }, worker),
  )

  return resultados.reduce<OliviaResumo>(
    (acc, r) => ({
      ...acc,
      enriquecidos: acc.enriquecidos + (r.enriquecido ? 1 : 0),
      comNumero: acc.comNumero + (r.comNumero ? 1 : 0),
      // Lead cancelado não conta como "sem número"; ele nem foi avaliado.
      semNumero: acc.semNumero + (r.cancelado || r.comNumero ? 0 : 1),
      disparados: acc.disparados + (r.disparado ? 1 : 0),
      erros: acc.erros + (r.teveErro ? 1 : 0),
      cancelados: acc.cancelados + (r.cancelado ? 1 : 0),
    }),
    {
      total: leads.length,
      enriquecidos: 0,
      comNumero: 0,
      semNumero: 0,
      disparados: 0,
      erros: 0,
      cancelados: 0,
    },
  )
}
