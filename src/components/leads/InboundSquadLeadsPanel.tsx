import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { useImportarSquadLeads } from '../../lib/leads'
import { leadsInboundParaAprendizado } from '../../lib/oliviaSelecao'
import { fmtDate, fmtInt, fmtText } from '../../lib/format'
import {
  INBOUND_CLASSIFICATION_LABEL,
  STATUS_META,
  type InboundReadyToImplement,
  type InboundRevenueRange,
  type Lead,
} from '../../lib/types'

const REVENUE_LABEL: Record<InboundRevenueRange, string> = {
  menos_10k: 'Menos de R$ 10k/mês',
  '10k_20k': 'R$ 10k a 20k/mês',
  '20k_50k': 'R$ 20k a 50k/mês',
  '50k_100k': 'R$ 50k a 100k/mês',
  acima_100k: 'Acima de R$ 100k/mês',
}

const READY_LABEL: Record<InboundReadyToImplement, string> = {
  sim_certeza: 'Sim, com certeza',
  talvez: 'Talvez',
  nao_proximos_7dias: 'Não nos próximos 7 dias',
}

function importSummary(data: ReturnType<typeof useImportarSquadLeads>['data']): string | null {
  if (!data) return null
  const parts = [
    `${data.imported} ${data.imported === 1 ? 'novo sinal' : 'novos sinais'}`,
    `${data.updated} ${data.updated === 1 ? 'sinal atualizado' : 'sinais atualizados'}`,
  ]
  if (data.skipped > 0) parts.push(`${data.skipped} pulados`)
  return `Base de aprendizado: ${parts.join(', ')}.`
}

function maskPhone(phone: string | null): string {
  if (!phone) return fmtText(null)
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '****'
  return `**** ${digits.slice(-4)}`
}

function metaBool(lead: Lead, key: string): boolean | null {
  const value = lead.inbound_meta?.[key]
  return typeof value === 'boolean' ? value : null
}

function signalLabel(label: string, value: boolean | null): string {
  if (value == null) return `${label}: ?`
  return `${label}: ${value ? 'sim' : 'nao'}`
}

export function InboundSquadLeadsPanel({ leads }: { leads: Lead[] }) {
  const importarSquad = useImportarSquadLeads()
  const [open, setOpen] = useState(false)
  const inbound = useMemo(() => leadsInboundParaAprendizado(leads), [leads])
  const summary = importSummary(importarSquad.data)

  return (
    <div className="card search-card inbound-card">
      <div className="inbound-head">
        <div>
          <div className="eyebrow">Base de aprendizado</div>
          <h3>Aprender com leads reais</h3>
          <p className="page-sub" style={{ margin: '4px 0 0' }}>
            Sincroniza os clientes/leads ativos do Squad Leads como sinais de referência.
            Eles não entram em lote, HubSpot ou disparo da Olivia.
          </p>
        </div>
        <div className="inbound-actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => importarSquad.mutate()}
            disabled={importarSquad.isPending}
          >
            {importarSquad.isPending ? (
              <><Loader2 size={16} className="spin" /> Atualizando...</>
            ) : (
              <><RefreshCw size={16} /> Sincronizar Squad Leads</>
            )}
          </button>
        </div>
      </div>

      {importarSquad.isError && (
        <div className="search-status err">
          {(importarSquad.error as Error)?.message ?? 'Falha ao sincronizar Squad Leads.'}
        </div>
      )}
      {summary && !importarSquad.isPending && <div className="search-status">{summary}</div>}

      <button
        type="button"
        className="inbound-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Ver sinais aprendidos
        <span className="badge" style={{ marginLeft: 8 }}>{inbound.length}</span>
      </button>

      {open && (
        <div className="inbound-details">
          <div className="inbound-fields">
            <span>Empresa</span>
            <span>Responsável</span>
            <span>Telefone</span>
            <span>Instagram</span>
            <span>Sinais</span>
            <span>Score</span>
            <span>Classificação</span>
            <span>Faturamento</span>
            <span>Pronto para implementar</span>
            <span>UTM</span>
            <span>Data do cadastro</span>
          </div>

          {inbound.length === 0 ? (
            <div className="empty-state compact">
              <h3>Nenhum sinal de aprendizado ainda</h3>
              <p>Clique em “Sincronizar Squad Leads” para trazer os cadastros reais da plataforma Squad Leads.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="leads-table inbound-table">
                <thead>
                  <tr>
                    <th className="eyebrow">Negócio</th>
                    <th className="eyebrow">Contato</th>
                    <th className="eyebrow">Instagram</th>
                    <th className="eyebrow">Sinais</th>
                    <th className="eyebrow">Score</th>
                    <th className="eyebrow">Classificação</th>
                    <th className="eyebrow">Status</th>
                    <th className="eyebrow">Faturamento</th>
                    <th className="eyebrow">Implementar</th>
                    <th className="eyebrow">UTM</th>
                    <th className="eyebrow">Cadastro</th>
                  </tr>
                </thead>
                <tbody>
                  {inbound.map((lead) => (
                    <tr key={lead.id}>
                      <td className="cell-nome">{lead.nome}</td>
                      <td>
                        <div>{fmtText(lead.dono_nome)}</div>
                        <span className="muted-line">{maskPhone(lead.telefone)}</span>
                      </td>
                      <td>{lead.instagram_handle ? `@${lead.instagram_handle}` : fmtText(null)}</td>
                      <td>
                        <span className="muted-line">
                          {[
                            signalLabel('IG', metaBool(lead, 'has_instagram_self_declared')),
                            signalLabel('WA', metaBool(lead, 'has_whatsapp_self_declared')),
                            signalLabel('CNPJ', metaBool(lead, 'has_cnpj_self_declared')),
                            signalLabel('vende WA', metaBool(lead, 'sells_on_whatsapp_self_declared')),
                          ].join(' · ')}
                        </span>
                      </td>
                      <td>{fmtInt(lead.inbound_score)}</td>
                      <td>
                        {lead.inbound_classification
                          ? INBOUND_CLASSIFICATION_LABEL[lead.inbound_classification]
                          : fmtText(null)}
                      </td>
                      <td>
                        <span className="status-cell">
                          <span className="status-dot" style={{ background: STATUS_META[lead.status].color }} />
                          {STATUS_META[lead.status].label}
                        </span>
                      </td>
                      <td>
                        {lead.inbound_revenue_range
                          ? REVENUE_LABEL[lead.inbound_revenue_range]
                          : fmtText(null)}
                      </td>
                      <td>
                        {lead.inbound_ready_to_implement
                          ? READY_LABEL[lead.inbound_ready_to_implement]
                          : fmtText(null)}
                      </td>
                      <td>
                        {[lead.inbound_utm_source, lead.inbound_utm_medium, lead.inbound_utm_campaign]
                          .filter(Boolean)
                          .join(' / ') || fmtText(null)}
                      </td>
                      <td>{fmtDate(lead.inbound_created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
