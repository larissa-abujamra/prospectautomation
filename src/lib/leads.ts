import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { EnrichStatus, Lead } from './types'

export const LEADS_KEY = ['leads'] as const

// Lê todos os leads (workspace compartilhado — RLS libera para autenticados).
// São poucos; filtros e ordenação acontecem client-side sobre este resultado.
export function useLeads() {
  return useQuery({
    queryKey: LEADS_KEY,
    queryFn: async (): Promise<Lead[]> => {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Lead[]
    },
  })
}

// Atualiza campos editáveis de um lead (notas, status, instagram_followers…).
export function useUpdateLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Lead> }) => {
      const { error } = await supabase.from('leads').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}

export interface BuscarResult {
  inserted: number
  updated: number
  total: number
}

export interface EnrichResult {
  lead: Lead
  enrich_status: EnrichStatus
  skipped?: boolean
}

// Enriquece UM lead (CNPJ + dono + seguidores) via Edge Function.
// `force` re-consulta mesmo se já houver CNPJ (gasta saldo de novo).
export async function enriquecerLead(leadId: string, force = false): Promise<EnrichResult> {
  const { data, error } = await supabase.functions.invoke('enriquecer-lead', {
    body: { lead_id: leadId, force },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as EnrichResult
}

export function useEnriquecerLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { leadId: string; force?: boolean }) =>
      enriquecerLead(params.leadId, params.force),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}

// Dispara a Edge Function de sourcing e devolve a contagem.
export function useBuscarDocerias() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      bairro: string
      max: number
    }): Promise<BuscarResult> => {
      const { data, error } = await supabase.functions.invoke('buscar-docerias', {
        body: params,
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      return data as BuscarResult
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}
