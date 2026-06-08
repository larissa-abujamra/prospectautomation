import { Checkbox } from '../Checkbox'
import type { Filters } from './filters'

// Rail de filtros da Etapa 01 — APENAS bairro, setor e seguidores (ICP).
// (Nota e nº de avaliações não existem mais nesta etapa.)
export function BuscarRail({
  filters,
  onChange,
  bairros,
  setores,
}: {
  filters: Filters
  onChange: (next: Filters) => void
  bairros: string[]
  setores: string[]
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })
  const filtering =
    filters.bairro !== '' ||
    filters.setor !== '' ||
    filters.minFollowers !== '' ||
    !filters.includeNoFollowers

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
        <div className="eyebrow">Setor</div>
        <div className="field">
          <select value={filters.setor} onChange={(e) => set({ setor: e.target.value })}>
            <option value="">Todos</option>
            {setores.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="filter-group">
        <div className="eyebrow">Seguidores mínimos</div>
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
          Incluir sem dado de seguidores
        </label>
      </div>

      <button
        type="button"
        className="btn ghost"
        onClick={() => set({ bairro: '', setor: '', minFollowers: '', includeNoFollowers: true })}
        disabled={!filtering}
      >
        Limpar filtros
      </button>
    </aside>
  )
}
