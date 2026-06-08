import type { QueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { LEADS_KEY } from './leads'
import type { Lead } from './types'

const CONCURRENCY = 3
// Dedup por sessão: evita re-disparo a cada refetch. Zera ao recarregar a aba.
const attempted = new Set<string>()

// Lead elegível: ainda não tem o nº de seguidores. (Se tiver handle, busca direto;
// se não tiver, a Edge Function tenta descobrir o @handle pelo Google.)
export function precisaSeguidores(lead: Lead): boolean {
  return lead.instagram_followers == null
}

interface FollowerJob {
  id: string
  handle: string | null
  nome: string
  cidade: string | null
}

// Em segundo plano (concorrência limitada): descobre o @handle (se faltar) e
// busca os seguidores, tudo via Edge Function (a chave do Scrapingdog fica no
// servidor). Fire-and-forget — NÃO trava a tabela; as células preenchem conforme
// cada perfil volta. Erro/perfil privado/sem handle → deixa como está.
export function runFollowers(jobs: FollowerJob[], qc: QueryClient): void {
  const queue = jobs.filter((j) => !attempted.has(j.id))
  if (queue.length === 0) return
  queue.forEach((j) => attempted.add(j.id))

  let i = 0
  const worker = async () => {
    while (i < queue.length) {
      const job = queue[i++]
      try {
        const { data, error } = await supabase.functions.invoke('instagram-followers', {
          body: { handle: job.handle ?? undefined, nome: job.nome, cidade: job.cidade },
        })
        if (!error && data) {
          const patch: Partial<Lead> = {}
          // grava o handle descoberto só se o lead ainda não tinha um
          if (!job.handle && typeof data.handle === 'string' && data.handle) {
            patch.instagram_handle = data.handle
          }
          if (typeof data.followers === 'number') {
            patch.instagram_followers = data.followers
          }
          if (Object.keys(patch).length > 0) {
            await supabase.from('leads').update(patch).eq('id', job.id)
            qc.invalidateQueries({ queryKey: LEADS_KEY })
          }
        }
      } catch {
        // segue o lote
      }
    }
  }
  void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
}
