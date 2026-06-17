import { useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { OLIVIA_ESTADO_META } from '../../lib/types'
import { fmtCnpj, fmtInt, fmtText } from '../../lib/format'
import { Checkbox } from '../Checkbox'
import { ScoreChip } from './ScoreChip'

type SortKey = 'nome' | 'instagram_followers' | 'lead_score'
type SortDir = 'asc' | 'desc'

function SortHeader({
  label, col, sort, dir, onSort, align,
}: {
  label: string; col: SortKey; sort: SortKey | null; dir: SortDir
  onSort: (c: SortKey) => void; align?: 'right'
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


// Disparo conta como feito a partir de 'sent' (inclui delivered/read/replied).
// 'failed'/'invalid' NÃO contam — check verde só com envio real.
const DISPARO_OK: ReadonlySet<string> = new Set(['sent', 'delivered', 'read', 'replied'])

// Check das colunas de verificação (re-layout Fase 2): ✓ verde quando o dado
// existe; "—" quando não (anti-invenção: ausência aparece como traço).
function CheckMark({ ok }: { ok: boolean }) {
  return ok ? <span className="check-yes">✓</span> : <span className="check-no">—</span>
}

export function EnriquecerTable({
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
  const [sort, setSort] = useState<SortKey | null>('lead_score')
  const [dir, setDir] = useState<SortDir>('desc')

  function handleSort(col: SortKey) {
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(col); setDir(col === 'nome' ? 'asc' : 'desc') }
  }

  const sorted = useMemo(() => {
    if (!sort) return leads
    const copy = [...leads]
    copy.sort((a, b) => {
      const av = a[sort], bv = b[sort]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' && typeof bv === 'string'
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
            <SortHeader label="Score" col="lead_score" sort={sort} dir={dir} onSort={handleSort} align="right" />
            <SortHeader label="Nome" col="nome" sort={sort} dir={dir} onSort={handleSort} />
            <th className="eyebrow">Bairro</th>
            <th className="eyebrow">Setor</th>
            <th className="eyebrow" style={{ textAlign: 'right' }}>Seguidores</th>
            <th className="eyebrow">CNPJ</th>
            <th className="eyebrow">Dono</th>
            <th className="eyebrow th-center">HubSpot</th>
            <th className="eyebrow th-center">Disparo</th>
            <th className="eyebrow th-center">C. Oculto</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((lead) => {
            const selected = selectedIds.has(lead.id)
            return (
              <tr key={lead.id} className={selected ? 'selected' : undefined} onClick={() => onOpen(lead.id)}>
                <td className="col-check">
                  <Checkbox checked={selected} onChange={() => onToggleOne(lead.id)} ariaLabel={`Selecionar ${lead.nome}`} />
                </td>
                <td className="cell-num" style={{ textAlign: 'right' }}><ScoreChip score={lead.lead_score} /></td>
                <td className="cell-nome">
                  {lead.nome}
                  {/* Estado da Olivia inline — só aparece quando há conversa (sem
                      coluna vazia). handoff puxa o olhar (dot rosa via 'missing'). */}
                  {lead.olivia_estado && (
                    <span className="olivia-chip" title={OLIVIA_ESTADO_META[lead.olivia_estado].label}>
                      <span className="status-dot" data-status={OLIVIA_ESTADO_META[lead.olivia_estado].dot} />
                      {OLIVIA_ESTADO_META[lead.olivia_estado].label}
                    </span>
                  )}
                </td>
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
                {/* Colunas de check (re-layout Fase 2) */}
                <td className="cell-checkmark" title="Negócio/contato criado no HubSpot">
                  <CheckMark ok={!!(lead.hubspot_contact_id || lead.hubspot_deal_id)} />
                </td>
                <td className="cell-checkmark" title="Template de WhatsApp disparado">
                  <CheckMark ok={lead.whatsapp_send_status != null && DISPARO_OK.has(lead.whatsapp_send_status)} />
                </td>
                <td className="cell-checkmark" title="Visita de cliente oculto feita">
                  <CheckMark ok={lead.cliente_oculto_at != null} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
