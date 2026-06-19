import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'

// Agregados de desfecho da Olivia (Fase 4 / goal 8). Vêm prontos da RPC
// olivia_outcomes_agg (1 chamada): contagem por desfecho, média de mensagens e,
// quando houver scoring, média de qualidade + temas. Read-only — a decisão de
// mudar prompt/estratégia é humana (esta tela é o insumo).

export interface OutcomesAgg {
  desde_dias: number
  total: number
  por_outcome: Record<string, number>
  media_mensagens: number
  media_qualidade: number | null
  temas_top: { tema: string; n: number }[]
}

export function useOutcomesAgg(dias = 30) {
  return useQuery({
    queryKey: ['olivia-outcomes-agg', dias],
    queryFn: async (): Promise<OutcomesAgg> => {
      const { data, error } = await supabase.rpc('olivia_outcomes_agg', { p_dias: dias })
      if (error) throw new Error(error.message)
      return data as OutcomesAgg
    },
    staleTime: 60_000,
  })
}

// Rótulos pt-BR dos estados terminais (espelham o enum olivia_estado).
export const OUTCOME_LABELS: Record<string, string> = {
  agendado: 'Reuniões agendadas',
  handoff: 'Escalado pro time',
  optout: 'Pediram pra parar',
  pausada: 'Humano assumiu',
}
