import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from 'lucide-react'
import { useImportarSquadLeads } from '../../lib/leads'
import { leadsInboundParaAprendizado } from '../../lib/oliviaSelecao'
import { fmtInt, fmtText } from '../../lib/format'
import {
  INBOUND_CLASSIFICATION_LABEL,
  STATUS_META,
  type InboundClassification,
  type InboundRevenueRange,
  type Lead,
} from '../../lib/types'

// Classificação → classe do badge de temperatura (cor via CSS, não hardcode).
const CLF_CLASSE: Record<InboundClassification, string> = {
  quente: 'clf-quente',
  nutrir: 'clf-morno',
  descartar: 'clf-frio',
}

const REVENUE_LABEL: Record<InboundRevenueRange, string> = {
  menos_10k: 'Menos de R$ 10k/mês',
  '10k_20k': 'R$ 10k a 20k/mês',
  '20k_50k': 'R$ 20k a 50k/mês',
  '50k_100k': 'R$ 50k a 100k/mês',
  acima_100k: 'Acima de R$ 100k/mês',
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

export function InboundSquadLeadsPanel({ leads }: { leads: Lead[] }) {
  const importarSquad = useImportarSquadLeads()
  const [open, setOpen] = useState(false)
  const [busca, setBusca] = useState('')
  const inbound = useMemo(() => leadsInboundParaAprendizado(leads), [leads])
  const summary = importSummary(importarSquad.data)

  // Mais relevante primeiro (score desc) + filtro por nome/dono/Instagram, pra
  // navegar mais fácil quando a lista cresce.
  const visiveis = useMemo(() => {
    const ordenado = [...inbound].sort((a, b) => (b.inbound_score ?? 0) - (a.inbound_score ?? 0))
    const t = busca.trim().toLowerCase()
    if (!t) return ordenado
    return ordenado.filter(
      (l) =>
        l.nome.toLowerCase().includes(t) ||
        (l.dono_nome?.toLowerCase().includes(t) ?? false) ||
        (l.instagram_handle?.toLowerCase().includes(t) ?? false),
    )
  }, [inbound, busca])

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
          {inbound.length === 0 ? (
            <div className="empty-state compact">
              <h3>Nenhum sinal de aprendizado ainda</h3>
              <p>Clique em “Sincronizar Squad Leads” para trazer os cadastros reais da plataforma Squad Leads.</p>
            </div>
          ) : (
            <>
              <div className="search-field inbound-search">
                <Search size={15} />
                <input
                  type="search"
                  placeholder="Buscar por empresa, responsável ou @instagram…"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  aria-label="Buscar sinal de aprendizado"
                />
              </div>

              {visiveis.length === 0 ? (
                <p className="muted-line" style={{ marginTop: 12 }}>Nada com esse termo.</p>
              ) : (
            <div className="table-wrap">
              <table className="apr-table">
                <colgroup>
                  <col style={{ width: '34%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '16%' }} />
                  <col style={{ width: '20%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="eyebrow">Negócio</th>
                    <th className="eyebrow">Score</th>
                    <th className="eyebrow">Classificação</th>
                    <th className="eyebrow">Status</th>
                    <th className="eyebrow">Faturamento</th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((lead) => (
                    <tr key={lead.id}>
                      <td>
                        <div className="neg-name">{lead.nome}</div>
                        <div className="neg-sub">
                          {[lead.dono_nome?.trim(), lead.telefone ? maskPhone(lead.telefone) : null]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </div>
                        {lead.instagram_handle && (
                          <div className="neg-sub">@{lead.instagram_handle}</div>
                        )}
                      </td>
                      <td><span className="chip">{fmtInt(lead.inbound_score)}</span></td>
                      <td>
                        {lead.inbound_classification ? (
                          <span className={`clf ${CLF_CLASSE[lead.inbound_classification]}`}>
                            {INBOUND_CLASSIFICATION_LABEL[lead.inbound_classification]}
                          </span>
                        ) : (
                          fmtText(null)
                        )}
                      </td>
                      <td>
                        <span className="st">
                          <span className="st-dot" />
                          {STATUS_META[lead.status].label}
                        </span>
                      </td>
                      <td>
                        {lead.inbound_revenue_range
                          ? REVENUE_LABEL[lead.inbound_revenue_range]
                          : fmtText(null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
