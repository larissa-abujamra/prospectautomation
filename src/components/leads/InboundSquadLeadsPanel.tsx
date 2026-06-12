import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { useImportarSquadLeads } from '../../lib/leads'
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

function inboundLeads(leads: Lead[]): Lead[] {
  return leads
    .filter((lead) => lead.origem === 'squad_leads_form')
    .sort((a, b) => {
      const at = Date.parse(a.inbound_created_at ?? a.created_at)
      const bt = Date.parse(b.inbound_created_at ?? b.created_at)
      return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at)
    })
}

function importSummary(data: ReturnType<typeof useImportarSquadLeads>['data']): string | null {
  if (!data) return null
  const parts = [
    `${data.imported} ${data.imported === 1 ? 'novo' : 'novos'}`,
    `${data.updated} ${data.updated === 1 ? 'atualizado' : 'atualizados'}`,
  ]
  if (data.skipped > 0) parts.push(`${data.skipped} pulados`)
  return `Squad Leads: ${parts.join(', ')}.`
}

export function InboundSquadLeadsPanel({
  leads,
  onUseInbound,
}: {
  leads: Lead[]
  onUseInbound: () => void
}) {
  const importarSquad = useImportarSquadLeads()
  const [open, setOpen] = useState(false)
  const inbound = useMemo(() => inboundLeads(leads), [leads])
  const actionableCount = inbound.filter((lead) => lead.status === 'descoberto').length
  const summary = importSummary(importarSquad.data)

  return (
    <div className="card search-card inbound-card">
      <div className="inbound-head">
        <div>
          <div className="eyebrow">Inbound Squad Leads</div>
          <h3>Comece pelos leads que levantaram a mão</h3>
          <p className="page-sub" style={{ margin: '4px 0 0' }}>
            Sincroniza a waitlist externa e deixa os leads quentes disponíveis para a Olivia priorizar.
          </p>
        </div>
        <div className="inbound-actions">
          <button
            type="button"
            className="btn"
            onClick={onUseInbound}
            disabled={actionableCount === 0}
          >
            Prospectar {actionableCount} inbound
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => importarSquad.mutate()}
            disabled={importarSquad.isPending}
          >
            {importarSquad.isPending ? (
              <><Loader2 size={16} className="spin" /> Sincronizando...</>
            ) : (
              <><RefreshCw size={16} /> Sincronizar inbound</>
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
        Ver dados importados
        <span className="badge" style={{ marginLeft: 8 }}>{inbound.length}</span>
      </button>

      {open && (
        <div className="inbound-details">
          <div className="inbound-fields">
            <span>Empresa</span>
            <span>Responsável</span>
            <span>Telefone</span>
            <span>Instagram</span>
            <span>Score</span>
            <span>Classificação</span>
            <span>Faturamento</span>
            <span>Pronto para implementar</span>
            <span>UTM</span>
            <span>Data do cadastro</span>
          </div>

          {inbound.length === 0 ? (
            <div className="empty-state compact">
              <h3>Nenhum inbound importado ainda</h3>
              <p>Clique em “Sincronizar inbound” para trazer os cadastros da plataforma Squad Leads.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="leads-table inbound-table">
                <thead>
                  <tr>
                    <th className="eyebrow">Negócio</th>
                    <th className="eyebrow">Contato</th>
                    <th className="eyebrow">Instagram</th>
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
                        <span className="muted-line">{fmtText(lead.telefone)}</span>
                      </td>
                      <td>{lead.instagram_handle ? `@${lead.instagram_handle}` : fmtText(null)}</td>
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
