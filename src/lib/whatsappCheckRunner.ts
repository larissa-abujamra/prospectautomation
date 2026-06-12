import type { QueryClient } from '@tanstack/react-query'
import { encontrarWhatsapp, LEADS_KEY } from './leads'
import type { Lead } from './types'
import { aguardandoWhatsapp } from './oliviaSelecao'

// Verificação de WhatsApp em segundo plano (wizard da Olivia, passo 2).
// =============================================================================
// O gate "só aparece quem tem WhatsApp" precisa do whatsapp_status ANTES da
// seleção — não dá pra esperar o processamento (passo 3) pra saber quem é
// mensageável. Este runner roda a `encontrar-whatsapp` (waterfall Google →
// Instagram → site → Perplexity) para os leads ainda sem verificação, com
// concorrência limitada, e invalida a query de leads conforme cada um volta.
// A Edge Function já tem a trava anti-re-gasto (skip se whatsapp_phone existe).

const CONCURRENCY = 3
// Teto de tentativas por lead por sessão: erro transitório ganha UMA segunda
// chance; depois desiste (sem isso, uma function quebrada viraria loop infinito
// de chamadas pagas a cada refetch). Zera ao recarregar a aba.
const MAX_TENTATIVAS = 2
const tentativas = new Map<string, number>()

/** Leads desta busca que ainda precisam da verificação. */
export function precisaVerificarWhatsapp(lead: Lead): boolean {
  return aguardandoWhatsapp(lead)
}

// Fire-and-forget: erro num lead não derruba os outros. Resultado legítimo
// 'missing' persiste no banco e não re-roda (o filtro acima já o exclui).
export function runWhatsappCheck(leads: Lead[], qc: QueryClient): void {
  const queue = leads.filter(
    (l) => precisaVerificarWhatsapp(l) && (tentativas.get(l.id) ?? 0) < MAX_TENTATIVAS,
  )
  if (queue.length === 0) return
  // Conta a tentativa JÁ na enfileirada: o teto vale mesmo se a chamada falhar
  // antes de responder. Sucesso persiste o status no banco e o lead sai do
  // filtro acima sozinho; falha pode retentar até esgotar o teto.
  queue.forEach((l) => tentativas.set(l.id, (tentativas.get(l.id) ?? 0) + 1))

  let i = 0
  const worker = async () => {
    while (i < queue.length) {
      const lead = queue[i++]
      try {
        await encontrarWhatsapp(lead.id, false)
        qc.invalidateQueries({ queryKey: LEADS_KEY })
      } catch {
        /* fica para a próxima passada do efeito, dentro do teto */
      }
    }
  }
  void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
}
