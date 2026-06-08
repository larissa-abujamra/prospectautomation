import type { QueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { LEADS_KEY } from './leads'
import type { Lead } from './types'

const CONCURRENCY = 3
// Dedup por sessão: evita re-disparo a cada refetch. Zera ao recarregar a aba.
const attempted = new Set<string>()

// Lead que pode ter seguidores buscados automaticamente: tem handle e ainda
// não tem o número. (Quem não tem handle fica "—" — descobrir o handle faltante
// fica como extensão futura.)
export function precisaSeguidores(lead: Lead): boolean {
  return !!lead.instagram_handle && lead.instagram_followers == null
}

// Busca o nº de seguidores em segundo plano (concorrência limitada), via a Edge
// Function (a chave do Scrapingdog fica no servidor). Fire-and-forget: NÃO trava
// a tabela. A célula "Seguidores" preenche conforme cada perfil volta.
export function runFollowers(
  leads: { id: string; handle: string }[],
  qc: QueryClient,
): void {
  const queue = leads.filter((l) => !attempted.has(l.id))
  if (queue.length === 0) return
  queue.forEach((l) => attempted.add(l.id))

  let i = 0
  const worker = async () => {
    while (i < queue.length) {
      const { id, handle } = queue[i++]
      try {
        const { data, error } = await supabase.functions.invoke('instagram-followers', {
          body: { handle },
        })
        const followers = data?.followers
        if (!error && typeof followers === 'number') {
          await supabase.from('leads').update({ instagram_followers: followers }).eq('id', id)
          qc.invalidateQueries({ queryKey: LEADS_KEY })
        }
        // perfil privado/erro → followers null: deixa como está (não trava o resto)
      } catch {
        // idem — segue o lote
      }
    }
  }
  void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
}
