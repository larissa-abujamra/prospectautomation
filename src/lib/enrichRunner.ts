import type { QueryClient } from '@tanstack/react-query'
import { enriquecerLead, LEADS_KEY } from './leads'
import type { Lead } from './types'

const CONCURRENCY = 3
// Dedup por sessão: evita disparo duplo (Buscar + auto-retomada do Enriquecer)
// e loop de re-disparo a cada refetch. Zera ao recarregar a aba (self-healing).
const attempted = new Set<string>()

// Lead avançado que ainda precisa enriquecer (qualificado + enrich pendente/vazio).
export function precisaEnriquecer(lead: Lead): boolean {
  if (lead.status !== 'qualificado') return false
  const es = lead.enrich_status
  return !es || es.cnpj == null || es.cnpj === 'pending'
}

// Dispara o enriquecimento de vários leads em segundo plano, com concorrência
// limitada. Fire-and-forget: NÃO bloqueia a navegação. Cada lead que termina
// invalida o cache pra a UI ir preenchendo. Erro por lead não derruba o lote.
export function runEnrichment(ids: string[], qc: QueryClient): void {
  const queue = ids.filter((id) => !attempted.has(id))
  if (queue.length === 0) return
  queue.forEach((id) => attempted.add(id))

  let i = 0
  const worker = async () => {
    while (i < queue.length) {
      const id = queue[i++]
      try {
        await enriquecerLead(id, false) // force=false → não re-enriquece quem já tem CNPJ
      } catch {
        // Falha transitória (rede/5xx): libera o id pra retentar nesta sessão.
        // Sem isto, um erro momentâneo deixava o lead sem enriquecer até recarregar.
        attempted.delete(id)
      }
      qc.invalidateQueries({ queryKey: LEADS_KEY })
    }
  }
  void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
}
