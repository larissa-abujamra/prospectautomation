import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { fetchLeads } from './fetchLeads'
import type { EnrichStatus, Lead, LeadStatus, OliviaErro, WhatsappMensagem, WhatsappSource, WhatsappStatus } from './types'
export { podeExportar } from './hubspotLead'

export const LEADS_KEY = ['leads'] as const
export const CONVERSA_KEY = (leadId: string) => ['conversa', leadId] as const
export const ERROS_KEY = ['olivia-erros'] as const

// Erros operacionais recentes (tabela olivia_erros) — alimenta o painel "Erros"
// pro time ver o que quebrou sem abrir o painel do Supabase. refetch a cada 30s.
// Erro de leitura propaga (não vira lista vazia silenciosa).
export function useOliviaErros(limit = 100) {
  return useQuery({
    queryKey: ERROS_KEY,
    queryFn: async (): Promise<OliviaErro[]> => {
      const { data, error } = await supabase
        .from('olivia_erros')
        .select('id, created_at, fonte, nivel, lead_id, mensagem, contexto')
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      return (data ?? []) as OliviaErro[]
    },
    refetchInterval: 30_000,
  })
}

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

// Remarca uma reunião (e dispara a mensagem da Olivia ao cliente).
//   - 'pedir'   : reabre o agendamento; Olivia pede um novo horário.
//   - 'noshow'  : cliente não compareceu; Olivia oferece remarcar.
//   - 'definir' : move o evento pro novo horário (novoSlotIso) e Olivia confirma.
export interface RemarcarParams {
  leadId: string
  motivo: 'pedir' | 'noshow' | 'definir'
  novoSlotIso?: string
}
export function useRemarcar() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ leadId, motivo, novoSlotIso }: RemarcarParams) => {
      const { data, error } = await supabase.functions.invoke('olivia-remarcar', {
        body: { lead_id: leadId, motivo, ...(novoSlotIso ? { novo_slot_iso: novoSlotIso } : {}) },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      return data as { ok: boolean; mensagem_enviada?: boolean; erro_mensagem?: string | null }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
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
  stats?: {
    candidates_before_dedupe: number
    candidates_after_dedupe: number
    whatsapp_rediscovery_queued: number
    outreach_dedupe_skipped?: number
    queries: {
      termo: string
      text_query: string
      included_type: string | null
      localizacao: string
      modo_localizacao: string
      returned: number
    }[]
  }
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

export interface ManualOliviaLeadParams {
  nome: string
  whatsapp: string
  cidade: string
  notas?: string | null
}

export interface ManualOliviaLeadResult {
  lead: Lead
  created: boolean
  reused: boolean
}

// Cria/reusa o lead manual no servidor (auth + validação), sem disparar WhatsApp.
// O envio continua no caminho existente: exportar-hubspot + hubspot-sync(trigger).
export async function criarLeadManualOlivia(params: ManualOliviaLeadParams): Promise<ManualOliviaLeadResult> {
  const { data, error } = await supabase.functions.invoke('manual-olivia-lead', {
    body: params,
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as ManualOliviaLeadResult
}

export interface BuscarParams {
  setor: string
  // Local desambiguado (descrição completa escolhida no autocomplete, ex.:
  // "Alta Floresta, MT, Brasil"). Tem precedência sobre bairro/cidade.
  local?: string
  bairro?: string
  // Cidade/região da busca (fallback legado). O backend usa 'São Paulo' como
  // default quando tudo está vazio (compatibilidade).
  cidade?: string
  max: number
  comSeguidores: boolean
}

export interface LocalSugestao {
  place_id: string
  principal: string
  secundario: string | null
  descricao: string
}

// Sugestões de localidade (Google Places Autocomplete via Edge Function — a
// chave fica no servidor). Erro degrada para lista vazia: o campo continua
// funcionando como texto livre.
export async function autocompleteLocal(input: string): Promise<LocalSugestao[]> {
  const { data, error } = await supabase.functions.invoke('autocomplete-local', {
    body: { input },
  })
  if (error || data?.error) return []
  return (data?.sugestoes ?? []) as LocalSugestao[]
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

export interface ImportarSquadLeadsResult {
  imported: number
  updated: number
  skipped: number
  total: number
  skipped_reasons?: Record<string, number>
}

export function useImportarSquadLeads() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<ImportarSquadLeadsResult> => {
      const { data, error } = await supabase.functions.invoke('importar-squad-leads', {
        body: {},
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      return data as ImportarSquadLeadsResult
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
  contactId: string | null
  created: boolean
  // true means whatsapp_outreach='ready' was written for the HubSpot workflow.
  triggered?: boolean
  workflow_triggered?: boolean
  workflow_property?: string | null
  workflow_value?: string | null
  skipped?: boolean
  skip_reason?: string
  properties: Record<string, string>
}

// Faz upsert de UM lead como contato no HubSpot (Parte B) via Edge Function.
// Só funciona para leads sincronizáveis: whatsapp_status=found + número + place_id.
// Idempotente (dedup por google_place_id). NÃO mexe no fluxo `exportar-hubspot`.
// `trigger=true` também marca whatsapp_outreach='ready' (Parte C): este é o
// contrato ativo de automação. O workflow de WhatsApp do HubSpot faz o envio.
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

export interface MarcarReuniaoParams {
  leadId: string
  reuniaoAt: string // ISO
  reuniaoLink?: string
  prospectEmail?: string
  repEmail?: string
  repNome?: string
}

// Marca uma reunião manualmente: grava no lead (vai pra coluna "Reunião agendada")
// e reflete no HubSpot (estágio do deal + propriedades). Via Edge Function porque
// o sync do HubSpot precisa do token (server-side).
export function useMarcarReuniao() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (p: MarcarReuniaoParams) => {
      const { data, error } = await supabase.functions.invoke('marcar-reuniao', {
        body: {
          lead_id: p.leadId,
          reuniao_at: p.reuniaoAt,
          reuniao_link: p.reuniaoLink ?? null,
          prospect_email: p.prospectEmail ?? null,
          rep_email: p.repEmail ?? null,
          rep_nome: p.repNome ?? null,
        },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      return data as { ok: boolean; lead_id: string; reuniao_at: string }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}

// NOTA: o envio do WhatsApp é 100% via HubSpot — syncHubspot(trigger=true) marca
// whatsapp_outreach='ready' e os workflows "Squad Prospeccao WhatsApp F/M" disparam
// o template. O caminho direto pela Meta Cloud API (Edge Function enviar-whatsapp)
// foi descontinuado no app: os secrets da Meta não são configurados neste projeto.

// Disparo em LOTE: aciona o workflow de WhatsApp do HubSpot para os leads prontos
// (whatsapp_status=found, nunca disparados, sem DDD divergente), em lotes pequenos
// e controlados. Mesmo caminho do botão por lead — só que em massa. `dry_run`
// (padrão) apenas lista quem seria disparado, sem enviar nada.
export interface BulkDispatchPreview { id: string; nome: string | null; setor: string | null }
export interface BulkDispatchResult {
  dry_run: boolean
  selecionados: number
  // só em dry_run=true
  leads?: BulkDispatchPreview[]
  // só em dry_run=false
  disparados?: number
  erros?: number
  erros_detalhe?: { id: string; erro: string }[]
}

export async function bulkDispatch(params: {
  dryRun?: boolean
  limite?: number
  setor?: string | null
}): Promise<BulkDispatchResult> {
  const body: Record<string, unknown> = {
    dry_run: params.dryRun ?? true,
    limite: params.limite ?? 20,
  }
  if (params.setor && params.setor.trim()) body.setor = params.setor.trim()
  const { data, error } = await supabase.functions.invoke('bulk-dispatch', { body })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as BulkDispatchResult
}

export function useBulkDispatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: bulkDispatch,
    onSuccess: (res) => {
      // Só invalida a Base quando algo foi de fato disparado (muda whatsapp_sent_at).
      if (!res.dry_run) qc.invalidateQueries({ queryKey: LEADS_KEY })
    },
  })
}

// Enriquecimento em LOTE: roda encontrar-whatsapp (+ opcional enriquecer-lead)
// nos leads pendentes (ex.: descobertos pela busca-massa). NÃO envia WhatsApp —
// só acha o número (gate do disparo). Bounded por tick (~20); re-rode pra drenar.
export interface BulkEnrichResult {
  dry_run: boolean
  selecionados?: number
  enriquecer?: boolean
  leads?: { id: string; nome: string | null; setor: string | null }[]
  // só em dry_run=false
  processados?: number
  found?: number
  missing?: number
  erros?: number
}

export async function bulkEnrich(params: {
  dryRun?: boolean
  limite?: number
  setor?: string | null
  enriquecer?: boolean
}): Promise<BulkEnrichResult> {
  const body: Record<string, unknown> = {
    dry_run: params.dryRun ?? true,
    limite: params.limite ?? 12,
    enriquecer: params.enriquecer ?? false,
  }
  if (params.setor && params.setor.trim()) body.setor = params.setor.trim()
  const { data, error } = await supabase.functions.invoke('bulk-enrich', { body })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as BulkEnrichResult
}

export function useBulkEnrich() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: bulkEnrich,
    onSuccess: (res) => {
      if (!res.dry_run) qc.invalidateQueries({ queryKey: LEADS_KEY })
    },
  })
}

// Normaliza um número digitado à mão para E.164 BR (+55DDDNXXXXXXXX). Só dígitos;
// se vier com DDI 55 já completo usa como está, senão assume Brasil. Sem inventar:
// devolve null se não sobrar dígito nenhum.
function normalizarTelefoneBR(input: string): string | null {
  const digitos = input.replace(/\D/g, '')
  if (!digitos) return null
  if (digitos.startsWith('55')) return `+${digitos}`
  return `+55${digitos}`
}

export interface CadastroManual {
  empresa: string
  pessoa: string
  whatsapp: string
}

// Cadastro manual de um contato para disparo pela Olivia (aba Disparos).
// Cria o lead (com google_place_id sintético — sem essa chave de dedup o
// hubspot-sync recusa) e dispara o gatilho do HubSpot. O número vai em
// whatsapp_dono (campo do nº pessoal preenchido à mão, que o disparo prefere).
export function useCadastrarManual() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ empresa, pessoa, whatsapp }: CadastroManual) => {
      const numero = normalizarTelefoneBR(whatsapp)
      if (!numero) throw new Error('Informe um número de WhatsApp válido.')
      const nome = empresa.trim()
      if (!nome) throw new Error('Informe o nome da empresa.')

      const { data, error } = await supabase
        .from('leads')
        .insert({
          nome,
          dono_nome: pessoa.trim() || null,
          whatsapp_dono: numero,
          // Chave de dedup sintética: leads manuais não têm Google Places, mas o
          // hubspot-sync exige uma chave de origem para o upsert idempotente.
          google_place_id: `manual:${crypto.randomUUID()}`,
          status: 'enriquecido' as LeadStatus,
        })
        .select('id')
        .single()
      if (error) throw error

      // Dispara: upsert do contato no HubSpot + whatsapp_outreach='ready' (o
      // workflow envia) + olivia_estado='aguardando' (entra no funil).
      await syncHubspot(data.id, true)
      return data.id as string
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })
}
