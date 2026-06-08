import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { EnrichStatus, Lead, LeadStatus, WhatsappSource, WhatsappStatus } from './types'

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

// Move um conjunto de leads de etapa no funil (ex.: descoberto → qualificado,
// ou → descartado). Update em lote por id.
export function useSetStatusBulk() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ ids, status }: { ids: string[]; status: LeadStatus }) => {
      if (ids.length === 0) return
      const { error } = await supabase.from('leads').update({ status }).in('id', ids)
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

export interface ExportResult {
  exported: string[]
  skipped: { id: string; motivo: string }[]
}

// Lead "enriquecido o suficiente" pra virar card no HubSpot (CNPJ + dono).
export function podeExportar(lead: Lead): boolean {
  return !!lead.cnpj && !!lead.dono_nome
}

// Handoff pro HubSpot (stub no servidor — marca hubspot_exported_at). Idempotente.
export async function exportarHubspot(leadIds: string[]): Promise<ExportResult> {
  const { data, error } = await supabase.functions.invoke('exportar-hubspot', {
    body: { lead_ids: leadIds },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as ExportResult
}

export function useExportarHubspot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (leadIds: string[]) => exportarHubspot(leadIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}

export interface BuscarParams {
  setor: string
  bairro: string
  max: number
  comSeguidores: boolean
}

// Dispara a Edge Function de sourcing (genérica por setor) e devolve a contagem.
export function useBuscarNegocios() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (params: BuscarParams): Promise<BuscarResult> => {
      const { data, error } = await supabase.functions.invoke('buscar-negocios', {
        body: params,
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      return data as BuscarResult
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}

export interface WhatsappResult {
  lead: Lead
  whatsapp_status: WhatsappStatus
  source: WhatsappSource | null
  skipped?: boolean
}

// Descobre o número WhatsApp de UM lead (Google → Instagram → site) via Edge
// Function. `force` reprocessa mesmo se já houver número.
export async function encontrarWhatsapp(
  leadId: string,
  force = false,
): Promise<WhatsappResult> {
  const { data, error } = await supabase.functions.invoke('encontrar-whatsapp', {
    body: { lead_id: leadId, force },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as WhatsappResult
}

export function useEncontrarWhatsapp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { leadId: string; force?: boolean }) =>
      encontrarWhatsapp(params.leadId, params.force),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}
