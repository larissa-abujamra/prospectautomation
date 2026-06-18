import type { QueryClient } from '@tanstack/react-query'
import { enriquecerLead, LEADS_KEY } from './leads'
import type { Lead } from './types'

const CONCURRENCY = 3
// Dedup por sessão: evita disparo duplo (Buscar + auto-retomada do Enriquecer)
// e loop de re-disparo a cada refetch. Zera ao recarregar a aba (self-healing).
const attempted = new Set<string>()
// Tentativas falhas por lead nesta sessão. Um lead cujo pipeline falha sempre
// (ex.: site gigante → scrape estoura o tempo → 502) era liberado a cada falha
// e re-enfileirado pelo refetch → LOOP INFINITO, gastando crédito de
// Scrapingdog/OpenRouter a cada volta. Acima do teto, desistimos nesta sessão.
const failureCount = new Map<string, number>()
const MAX_RETRIES = 1

// Zera o estado de sessão (usado em testes; em produção o reload da aba já zera).
export function __resetEnrichRunnerState(): void {
  attempted.clear()
  failureCount.clear()
}

// Lead avançado que ainda precisa enriquecer (qualificado + enrich pendente/vazio).
export function precisaEnriquecer(lead: Lead): boolean {
  if (lead.status !== 'qualificado') return false
  const es = lead.enrich_status
  return !es || es.cnpj == null || es.cnpj === 'pending'
}

// Dispara o enriquecimento de vários leads em segundo plano, com concorrência
// limitada. Fire-and-forget: NÃO bloqueia a navegação. Cada lead que termina
// invalida o cache pra a UI ir preenchendo. Erro por lead não derruba o lote.
export function runEnrichment(ids: string[], qc: QueryClient): Promise<void> {
  const queue = ids.filter((id) => !attempted.has(id))
  if (queue.length === 0) return Promise.resolve()
  queue.forEach((id) => attempted.add(id))

  let i = 0
  const worker = async () => {
    while (i < queue.length) {
      const id = queue[i++]
      try {
        await enriquecerLead(id, false) // force=false → não re-enriquece quem já tem CNPJ
      } catch {
        // Falha transitória (rede/5xx): libera o id pra retentar nesta sessão —
        // MAS só até o teto. Sem o teto, um lead que falha sempre (pipeline lento
        // → 502) era re-enfileirado a cada refetch num loop infinito (custo de
        // API a cada volta). Acima do teto, fica em `attempted` e não re-dispara.
        const n = (failureCount.get(id) ?? 0) + 1
        failureCount.set(id, n)
        if (n <= MAX_RETRIES) attempted.delete(id)
      }
      qc.invalidateQueries({ queryKey: LEADS_KEY })
    }
  }
  return Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  ).then(() => undefined)
}
