import { encontrarWhatsapp, syncHubspot } from './leads'

// disparoRunner: o ÚNICO lugar que aciona o workflow de WhatsApp via HubSpot.
// Antes essa lógica existia copiada em src/pages/Enriquecer.tsx (engolindo erro com
// catch {}) e em oliviaRunner. Aqui ela vira um átomo testado, com resultado
// estruturado para a UI mostrar o que saiu e o que falhou (auditoria 10/06, finding
// da falha silenciosa). Anti-invenção: sem número confirmado, NÃO chama o HubSpot.

interface LeadDisparavel {
  id: string
  whatsapp_phone: string | null
  whatsapp_dono: string | null
}

export interface DisparoLeadResultado {
  leadId: string
  ok: boolean // gatilho do workflow confirmado
  semNumero: boolean // não havia número e não foi achado → nada disparado
  jaContatado?: boolean // guard idempotente: já havia disparo/outreach registrado
  motivo?: string // preenchido quando ok=false e semNumero=false (erro real)
}

export interface DisparoResumo {
  total: number
  disparados: number
  semNumero: number
  erros: number
  jaContatados?: number
  pausados?: number
}

// Número conhecido sem custo: nº manual da dona(o) tem preferência sobre o da loja.
function numeroConhecido(lead: LeadDisparavel): string | null {
  const dono = lead.whatsapp_dono?.trim()
  if (dono) return dono
  return lead.whatsapp_phone?.trim() || null
}

const mensagemDe = (e: unknown): string => (e instanceof Error ? e.message : 'Falha no disparo.')

function syncPulouLeadJaContatado(r: { skipped?: boolean; skip_reason?: string }): boolean {
  return r.skipped === true && r.skip_reason === 'already_contacted'
}

// Dispara UM lead: garante o número (acha se faltar) e aciona o gatilho do HubSpot
// (syncHubspot trigger=true -> workflow F/M envia o template). Nunca lança.
export async function dispararLead(lead: LeadDisparavel): Promise<DisparoLeadResultado> {
  try {
    let numero = numeroConhecido(lead)
    if (!numero) {
      const res = await encontrarWhatsapp(lead.id, false)
      numero = res.lead?.whatsapp_phone ?? null
    }
    // Anti-invenção: sem número não há disparo; o lead fica na base como está.
    if (!numero) return { leadId: lead.id, ok: false, semNumero: true }

    const r = await syncHubspot(lead.id, true)
    if (!(r.workflow_triggered ?? r.triggered)) {
      if (syncPulouLeadJaContatado(r)) {
        return { leadId: lead.id, ok: false, semNumero: false, jaContatado: true }
      }
      // Sync passou mas o gatilho não foi confirmado: não finge "disparado".
      return { leadId: lead.id, ok: false, semNumero: false, motivo: 'Gatilho do workflow não confirmado pelo sync' }
    }
    return { leadId: lead.id, ok: true, semNumero: false }
  } catch (erro) {
    return { leadId: lead.id, ok: false, semNumero: false, motivo: mensagemDe(erro) }
  }
}

// Lote sequencial (mesma cadência do antigo BatchWhatsapp). Erro num lead nunca
// derruba o lote; o callback de progresso recebe cada resultado para a UI; o resumo
// agregado distingue disparados / sem número / erros; fim da falha silenciosa.
export async function dispararLote(
  leads: LeadDisparavel[],
  onProgresso?: (r: DisparoLeadResultado, indice: number) => void,
  opts?: {
    sinalParar?: () => boolean
    maxDisparos?: number
    delayMs?: number
    wait?: (ms: number) => Promise<void>
  },
): Promise<DisparoResumo> {
  const resumo: DisparoResumo = { total: leads.length, disparados: 0, semNumero: 0, erros: 0 }
  const maxDisparos = opts?.maxDisparos == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(opts.maxDisparos))
  const delayMs = Math.max(0, Math.floor(opts?.delayMs ?? 0))
  const wait = opts?.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let pausados = 0

  for (let i = 0; i < leads.length; i++) {
    if (opts?.sinalParar?.()) break
    if (resumo.disparados >= maxDisparos) {
      pausados = leads.length - i
      break
    }
    const r = await dispararLead(leads[i])
    if (r.ok) resumo.disparados++
    else if (r.semNumero) resumo.semNumero++
    else if (r.jaContatado) resumo.jaContatados = (resumo.jaContatados ?? 0) + 1
    else resumo.erros++
    onProgresso?.(r, i)
    if (r.ok && delayMs > 0 && i < leads.length - 1 && resumo.disparados < maxDisparos && !opts?.sinalParar?.()) {
      await wait(delayMs)
    }
  }
  if (pausados > 0) resumo.pausados = pausados
  return resumo
}
