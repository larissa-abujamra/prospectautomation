import { Check, Trash2 } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { fmtCnpj, fmtDate, fmtInt, fmtText } from '../../lib/format'
import { Checkbox } from '../Checkbox'

export function EnriquecerTable({
  leads,
  selectedIds,
  onToggleOne,
  onToggleAll,
  onOpen,
  onDelete,
}: {
  leads: Lead[]
  selectedIds: Set<string>
  onToggleOne: (id: string) => void
  onToggleAll: (ids: string[], select: boolean) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}) {
  const visibleIds = leads.map((l) => l.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  return (
    <div className="table-wrap">
      <table className="leads-table">
        <thead>
          <tr>
            <th className="col-check">
              <Checkbox checked={allSelected} onChange={(v) => onToggleAll(visibleIds, v)} title="Selecionar todos os visíveis" />
            </th>
            <th className="eyebrow">Nome</th>
            <th className="eyebrow">Bairro</th>
            <th className="eyebrow">Setor</th>
            <th className="eyebrow" style={{ textAlign: 'right' }}>Seguidores</th>
            <th className="eyebrow">CNPJ</th>
            <th className="eyebrow">Dono</th>
            <th className="eyebrow">HubSpot</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const selected = selectedIds.has(lead.id)
            return (
              <tr key={lead.id} className={selected ? 'selected' : undefined} onClick={() => onOpen(lead.id)}>
                <td className="col-check">
                  <Checkbox checked={selected} onChange={() => onToggleOne(lead.id)} ariaLabel={`Selecionar ${lead.nome}`} />
                </td>
                <td className="cell-nome">{lead.nome}</td>
                <td className={lead.bairro ? undefined : 'cell-dash'}>{fmtText(lead.bairro)}</td>
                <td className={lead.setor ? undefined : 'cell-dash'}>{fmtText(lead.setor)}</td>
                <td className="cell-num" style={{ textAlign: 'right' }}>
                  {lead.instagram_followers == null ? <span className="cell-dash">—</span> : fmtInt(lead.instagram_followers)}
                </td>
                <td>
                  <span className="status-cell">
                    {/* O dot reflete o dado real: tem CNPJ → ok; senão, o status do
                      pipeline (pending/missing) ou vazio. Nunca "ok" sem CNPJ. */}
                  <span className="status-dot" data-status={lead.cnpj ? 'ok' : lead.enrich_status?.cnpj ?? 'empty'} />
                    {lead.cnpj ? fmtCnpj(lead.cnpj) : <span className="cell-dash">—</span>}
                  </span>
                </td>
                <td className={lead.dono_nome ? undefined : 'cell-dash'}>{fmtText(lead.dono_nome)}</td>
                <td>
                  {lead.hubspot_exported_at ? (
                    <span className="hs-exported">
                      <span className="badge"><Check size={11} /> no HubSpot</span>
                      <span className="hs-date">{fmtDate(lead.hubspot_exported_at)}</span>
                    </span>
                  ) : (
                    <span className="cell-dash">—</span>
                  )}
                </td>
                <td className="col-actions">
                  <button
                    className="icon-btn danger"
                    title="Deletar lead"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(lead.id)
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
