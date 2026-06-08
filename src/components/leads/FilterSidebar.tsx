import { LEAD_STATUSES, STATUS_META } from '../../lib/types'
import type { LeadStatus } from '../../lib/types'
import { Checkbox } from '../Checkbox'
import { EMPTY_FILTERS, isFiltering } from './filters'
import type { Filters } from './filters'

export function FilterSidebar({
  filters,
  onChange,
  bairros,
}: {
  filters: Filters
  onChange: (next: Filters) => void
  bairros: string[]
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })

  function toggleStatus(s: LeadStatus) {
    const has = filters.statuses.includes(s)
    set({
      statuses: has
        ? filters.statuses.filter((x) => x !== s)
        : [...filters.statuses, s],
    })
  }

  return (
    <aside className="filter-panel">
      <div className="filter-group">
        <div className="eyebrow">Bairro</div>
        <div className="field">
          <select value={filters.bairro} onChange={(e) => set({ bairro: e.target.value })}>
            <option value="">Todos</option>
            {bairros.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="filter-group">
        <div className="filter-head">
          <div className="eyebrow">Nota mínima</div>
          <span className="range-val">{filters.minRating.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
        </div>
        <input
          type="range"
          min={0}
          max={5}
          step={0.5}
          value={filters.minRating}
          onChange={(e) => set({ minRating: Number(e.target.value) })}
        />
      </div>

      <div className="filter-group">
        <div className="eyebrow">Mínimo de avaliações</div>
        <div className="field">
          <input
            type="number"
            min={0}
            placeholder="0"
            value={filters.minReviews}
            onChange={(e) =>
              set({ minReviews: e.target.value === '' ? '' : Number(e.target.value) })
            }
          />
        </div>
      </div>

      <div className="filter-group">
        <div className="eyebrow">Mínimo de seguidores</div>
        <div className="field">
          <input
            type="number"
            min={0}
            placeholder="Ex.: 3000"
            value={filters.minFollowers}
            onChange={(e) =>
              set({ minFollowers: e.target.value === '' ? '' : Number(e.target.value) })
            }
          />
        </div>
        <label className="check-line">
          <Checkbox
            checked={filters.includeNoFollowers}
            onChange={(v) => set({ includeNoFollowers: v })}
          />
          Incluir leads sem dado de seguidores
        </label>
      </div>

      <div className="filter-group">
        <div className="eyebrow">Status</div>
        <div className="status-options">
          {LEAD_STATUSES.map((s) => (
            <label key={s} className="check-line">
              <Checkbox
                checked={filters.statuses.includes(s)}
                onChange={() => toggleStatus(s)}
              />
              <span className="status-cell">
                <span className="status-dot" style={{ background: STATUS_META[s].color }} />
                {STATUS_META[s].label}
              </span>
            </label>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="btn ghost"
        onClick={() => onChange(EMPTY_FILTERS)}
        disabled={!isFiltering(filters)}
      >
        Limpar filtros
      </button>
    </aside>
  )
}
