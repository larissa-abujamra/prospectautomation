import { useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { fmtInt, fmtText } from '../../lib/format'
import { Checkbox } from '../Checkbox'

type SortKey = 'nome' | 'instagram_followers'
type SortDir = 'asc' | 'desc'

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
          {!active ? <ChevronsUpDown size={13} /> : dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </span>
    </th>
  )
}

export function BuscarTable({
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
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
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
      if (av == null && bv == null) return 0
      if (av == null) return 1 // nulos sempre por último (anti-invenção)
      if (bv == null) return -1
      const cmp =
        typeof av === 'string' && typeof bv === 'string'
          ? av.localeCompare(bv, 'pt-BR')
          : (av as number) - (bv as number)
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
              <Checkbox checked={allSelected} onChange={(v) => onToggleAll(visibleIds, v)} title="Selecionar todos os visíveis" />
            </th>
            <SortHeader label="Nome" col="nome" sort={sort} dir={dir} onSort={handleSort} />
            <th className="eyebrow">Bairro</th>
            <th className="eyebrow">Setor</th>
            <th className="eyebrow">Instagram</th>
            <SortHeader label="Seguidores" col="instagram_followers" sort={sort} dir={dir} onSort={handleSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((lead) => {
            const selected = selectedIds.has(lead.id)
            return (
              <tr key={lead.id} className={selected ? 'selected' : undefined} onClick={() => onOpen(lead.id)}>
                <td className="col-check">
                  <Checkbox checked={selected} onChange={() => onToggleOne(lead.id)} />
                </td>
                <td className="cell-nome">{lead.nome}</td>
                <td className={lead.bairro ? undefined : 'cell-dash'}>{fmtText(lead.bairro)}</td>
                <td className={lead.setor ? undefined : 'cell-dash'}>{fmtText(lead.setor)}</td>
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
                  {lead.instagram_followers == null ? (
                    <span className="cell-dash">—</span>
                  ) : (
                    fmtInt(lead.instagram_followers)
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
