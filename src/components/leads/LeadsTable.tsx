import { useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, PanelRightOpen } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { STATUS_META } from '../../lib/types'
import { fmtCnpj, fmtInt, fmtRating } from '../../lib/format'
import { useUpdateLead } from '../../lib/leads'
import { Checkbox } from '../Checkbox'

type SortKey = 'nome' | 'rating' | 'reviews_count' | 'instagram_followers'
type SortDir = 'asc' | 'desc'

// Edição inline de seguidores direto na célula. Vazio = null (volta a "—").
function InlineFollowers({ lead }: { lead: Lead }) {
  const update = useUpdateLead()
  const [val, setVal] = useState(
    lead.instagram_followers == null ? '' : String(lead.instagram_followers),
  )

  function commit() {
    const next = val.trim() === '' ? null : Number(val.replace(/\D/g, ''))
    if (next === lead.instagram_followers) return
    if (next != null && !Number.isFinite(next)) return
    update.mutate({ id: lead.id, patch: { instagram_followers: next } })
  }

  return (
    <input
      className="inline-edit"
      inputMode="numeric"
      placeholder="—"
      value={val}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

function SortHeader({
  label,
  col,
  sort,
  dir,
  onSort,
  align,
}: {
  label: string
  col: SortKey
  sort: SortKey | null
  dir: SortDir
  onSort: (c: SortKey) => void
  align?: 'right'
}) {
  const active = sort === col
  return (
    <th className="sortable eyebrow" style={align ? { textAlign: 'right' } : undefined}>
      <span className="th-label" onClick={() => onSort(col)}>
        {label}
        <span className="chev">
          {!active ? (
            <ChevronsUpDown size={13} />
          ) : dir === 'asc' ? (
            <ChevronUp size={13} />
          ) : (
            <ChevronDown size={13} />
          )}
        </span>
      </span>
    </th>
  )
}

export function LeadsTable({
  leads,
  selectedIds,
  onToggleOne,
  onToggleAll,
  onOpen,
}: {
  leads: Lead[]
  selectedIds: Set<string>
  onToggleOne: (id: string) => void
  onToggleAll: (ids: string[], select: boolean) => void
  onOpen: (id: string) => void
}) {
  const [sort, setSort] = useState<SortKey | null>(null)
  const [dir, setDir] = useState<SortDir>('asc')

  function handleSort(col: SortKey) {
    if (sort === col) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSort(col)
      setDir(col === 'nome' ? 'asc' : 'desc')
    }
  }

  const sorted = useMemo(() => {
    if (!sort) return leads
    const copy = [...leads]
    copy.sort((a, b) => {
      const av = a[sort]
      const bv = b[sort]
      // Anti-invenção: nulos sempre por último, independente da direção.
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      let cmp: number
      if (typeof av === 'string' && typeof bv === 'string') {
        cmp = av.localeCompare(bv, 'pt-BR')
      } else {
        cmp = (av as number) - (bv as number)
      }
      return dir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [leads, sort, dir])

  const visibleIds = sorted.map((l) => l.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  return (
    <div className="table-wrap">
      <table className="leads-table">
        <thead>
          <tr>
            <th className="col-check">
              <Checkbox
                checked={allSelected}
                onChange={(v) => onToggleAll(visibleIds, v)}
                title="Selecionar todos os visíveis"
              />
            </th>
            <SortHeader label="Nome" col="nome" sort={sort} dir={dir} onSort={handleSort} />
            <th className="eyebrow">Bairro</th>
            <SortHeader label="Nota" col="rating" sort={sort} dir={dir} onSort={handleSort} align="right" />
            <SortHeader label="Avaliações" col="reviews_count" sort={sort} dir={dir} onSort={handleSort} align="right" />
            <th className="eyebrow">Instagram</th>
            <SortHeader label="Seguidores" col="instagram_followers" sort={sort} dir={dir} onSort={handleSort} align="right" />
            <th className="eyebrow">CNPJ</th>
            <th className="eyebrow">Dono</th>
            <th className="eyebrow">Status</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((lead) => {
            const selected = selectedIds.has(lead.id)
            const meta = STATUS_META[lead.status]
            return (
              <tr
                key={lead.id}
                className={selected ? 'selected' : undefined}
                onClick={() => onOpen(lead.id)}
              >
                <td className="col-check">
                  <Checkbox checked={selected} onChange={() => onToggleOne(lead.id)} />
                </td>
                <td className="cell-nome">{lead.nome}</td>
                <td className={lead.bairro ? undefined : 'cell-dash'}>{lead.bairro ?? '—'}</td>
                <td className="cell-num" style={{ textAlign: 'right' }}>
                  {lead.rating == null ? <span className="cell-dash">—</span> : fmtRating(lead.rating)}
                </td>
                <td className="cell-num" style={{ textAlign: 'right' }}>
                  {lead.reviews_count == null ? <span className="cell-dash">—</span> : fmtInt(lead.reviews_count)}
                </td>
                <td>
                  {lead.instagram_handle ? (
                    <a
                      className="ig-link"
                      href={`https://instagram.com/${lead.instagram_handle}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      @{lead.instagram_handle}
                    </a>
                  ) : (
                    <span className="cell-dash">—</span>
                  )}
                </td>
                <td className="cell-num" style={{ textAlign: 'right' }}>
                  <InlineFollowers lead={lead} />
                </td>
                <td>
                  {lead.cnpj ? (
                    <span className="status-cell">
                      <span className="status-dot" data-status={lead.enrich_status?.cnpj ?? 'ok'} />
                      {fmtCnpj(lead.cnpj)}
                    </span>
                  ) : (
                    <span className="status-cell">
                      <span className="status-dot" data-status={lead.enrich_status?.cnpj ?? 'empty'} />
                      <span className="cell-dash">—</span>
                    </span>
                  )}
                </td>
                <td className={lead.dono_nome ? undefined : 'cell-dash'}>{lead.dono_nome ?? '—'}</td>
                <td>
                  <span className="status-cell">
                    <span className="status-dot" style={{ background: meta.color }} />
                    {meta.label}
                  </span>
                </td>
                <td className="col-actions">
                  <button
                    className="icon-btn"
                    title="Ver detalhes"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpen(lead.id)
                    }}
                  >
                    <PanelRightOpen size={16} />
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
