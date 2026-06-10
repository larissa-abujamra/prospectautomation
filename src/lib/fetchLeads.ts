import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead } from './types'

// Limite de linhas por resposta do PostgREST (config "Max Rows" do Supabase).
// Sem paginar, a query truncava em 1000 e, ordenada por created_at desc, os leads
// MAIS ANTIGOS sumiam do funil silenciosamente (finding High da auditoria 10/06).
const PAGE = 1000

// Busca TODOS os leads ativos, paginando em blocos até esgotar. Exclui 'descartado'
// (terminal): o lead continua no banco para histórico/dedup, mas fora da visão de
// trabalho (decisão de funil — fechado/perdido filtra, não deleta).
export async function fetchLeads(client: SupabaseClient): Promise<Lead[]> {
  const todos: Lead[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('leads')
      .select('*')
      .neq('status', 'descartado')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const lote = (data ?? []) as Lead[]
    todos.push(...lote)
    // Página incompleta = última página. Evita um round-trip extra vazio.
    if (lote.length < PAGE) break
  }
  return todos
}
