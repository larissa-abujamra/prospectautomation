import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { fetchLeads } from './fetchLeads'
import type { EnrichStatus, Lead, LeadStatus, WhatsappMensagem, WhatsappSource, WhatsappStatus } from './types'

export const LEADS_KEY = ['leads'] as const
export const CONVERSA_KEY = (leadId: string) => ['conversa', leadId] as const

// Histórico da conversa de UM lead (whatsapp_mensagens, ordem cronológica) — a
// janela do time pra ver o que a Olivia falou. refetch a cada 15s pra acompanhar
// uma conversa viva enquanto a aba está aberta. Erro NUNCA vira "sem mensagens"
// silencioso (mascararia falha de DB): propaga pro componente exibir o erro.
export function useOliviaConversa(leadId: string) {
  return useQuery({
    queryKey: CONVERSA_KEY(leadId),
    queryFn: async (): Promise<WhatsappMensagem[]> => {
      const { data, error } = await supabase
        .from('whatsapp_mensagens')
        .select('id, lead_id, direcao, wamid, tipo, corpo, enviada_em, created_at')
        .eq('lead_id', leadId)
        .order('enviada_em', { ascending: true })
      if (error) throw error
      return (data ?? []) as WhatsappMensagem[]
    },
    refetchInterval: 15_000,
  })
}

// Lê todos os leads ATIVOS (workspace compartilhado — RLS libera para autenticados).
// A busca pagina em blocos (ver fetchLeads): sem isso a tabela truncava em 1000 e o
// funil perdia os leads mais antigos. Filtros/ordenação finos acontecem client-side.
export function useLeads() {
  return useQuery({
    queryKey: LEADS_KEY,
    queryFn: () => fetchLeads(supabase),
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

// Avança leads para 'qualificado' E já marca o enrich_status como pendente,
// para a UI mostrar "enriquecendo" imediatamente (o disparo real é orquestrado
// pelo frontend em segundo plano — ver lib/enrichRunner).
const ENRICH_PENDING: EnrichStatus = { cnpj: 'pending', dono: 'pending', instagram: 'pending' }
export function useAdvanceToEnrich() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return
      const { error } = await supabase
        .from('leads')
        .update({ status: 'qualificado', enrich_status: ENRICH_PENDING })
        .in('id', ids)
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

// Hard delete de leads por id (RLS já permite a usuários autenticados).
export function useDeleteLeads() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return
      const { error } = await supabase.from('leads').delete().in('id', ids)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}

export interface BuscarResult {
  inserted: number
  updated: number
  total: number
  // place_ids de TODOS os resultados desta busca (novos + já existentes). O wizard
  // da Olivia filtra por eles p/ mostrar exatamente esta busca, não todos os leads.
  place_ids: string[]
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
  exported: { id: string; dealId: string; contactId: string; created: boolean }[]
  skipped: { id: string; motivo: string }[]
}

// Vira card no pipeline Squad Prospects com o mínimo: nome + place_id (chave de
// dedup). CNPJ/dono não são exigidos — prospect entra cru e é enriquecido depois.
export function podeExportar(lead: Lead): boolean {
  return !!lead.nome && !!lead.google_place_id
}

// Cria o negócio (Prospects) + contato no HubSpot, associados. Idempotente.
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

export interface HubspotSyncResult {
  contactId: string
  created: boolean
  triggered?: boolean
  properties: Record<string, string>
}

// Faz upsert de UM lead como contato no HubSpot (Parte B) via Edge Function.
// Só funciona para leads sincronizáveis: whatsapp_status=found + número + place_id.
// Idempotente (dedup por google_place_id). NÃO mexe no fluxo `exportar-hubspot`.
// `trigger=true` também marca whatsapp_outreach='ready' (Parte C) — gatilho do
// workflow de WhatsApp do HubSpot.
export async function syncHubspot(leadId: string, trigger = false): Promise<HubspotSyncResult> {
  const { data, error } = await supabase.functions.invoke('hubspot-sync', {
    body: { lead_id: leadId, trigger },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as HubspotSyncResult
}

export function useSyncHubspot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { leadId: string; trigger?: boolean }) =>
      syncHubspot(params.leadId, params.trigger),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}

// NOTA: o envio do WhatsApp é 100% via HubSpot — syncHubspot(trigger=true) marca
// whatsapp_outreach='ready' e os workflows "Squad Prospeccao WhatsApp F/M" disparam
// o template. O caminho direto pela Meta Cloud API (Edge Function enviar-whatsapp)
// foi descontinuado no app: os secrets da Meta não são configurados neste projeto.
