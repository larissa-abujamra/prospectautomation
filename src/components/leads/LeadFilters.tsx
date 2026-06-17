import { Checkbox } from '../Checkbox'
import {
  INBOUND_CLASSIFICATIONS,
  INBOUND_CLASSIFICATION_LABEL,
  LEAD_ORIGEM_LABEL,
  STATUS_META,
} from '../../lib/types'
import type { LeadStatus } from '../../lib/types'
import { EMPTY_FILTERS, HUBSPOT_FILTERS, hubspotFilterLabel, isFiltering } from './filters'
import type { Filters } from './filters'

// Rail de filtros compartilhado entre Buscar e Enriquecer.
// Sempre: Bairro, Setor, Seguidores mínimos (+ toggle ICP).
// Opcional: Status (multi-select) — passe `statusOptions` para exibir.
// (Sem nota/avaliações em nenhuma das duas etapas.)
export function LeadFilters({
  filters,
  onChange,
  bairros,
  setores,
  statusOptions,
  showHubspotFilters = false,
  heading,
}: {
  filters: Filters
  onChange: (next: Filters) => void
  bairros: string[]
  setores: string[]
  statusOptions?: LeadStatus[]
  showHubspotFilters?: boolean
  heading?: string
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })

  function toggleStatus(s: LeadStatus) {
    const has = filters.statuses.includes(s)
    set({ statuses: has ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s] })
  }

  function toggleHubspot(filter: Filters['hubspot'][number]) {
    const has = filters.hubspot.includes(filter)
    set({
      hubspot: has ? filters.hubspot.filter((x) => x !== filter) : [...filters.hubspot, filter],
    })
  }

  function toggleInboundClassification(classification: Filters['inboundClassifications'][number]) {
    const has = filters.inboundClassifications.includes(classification)
    set({
      inboundClassifications: has
        ? filters.inboundClassifications.filter((x) => x !== classification)
        : [...filters.inboundClassifications, classification],
    })
  }

  return (
    <aside className="filter-panel">
      {heading && <div className="eyebrow filter-rail-title">{heading}</div>}

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
        <div className="eyebrow">Origem</div>
        <div className="field">
          <select value={filters.origem} onChange={(e) => set({ origem: e.target.value as Filters['origem'] })}>
            <option value="">Todas</option>
            <option value="google_places">{LEAD_ORIGEM_LABEL.google_places}</option>
            <option value="squad_leads_form">{LEAD_ORIGEM_LABEL.squad_leads_form}</option>
            <option value="manual_olivia">{LEAD_ORIGEM_LABEL.manual_olivia}</option>
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
      </div>

      {statusOptions && statusOptions.length > 0 && (
        <div className="filter-group">
          <div className="eyebrow">Status</div>
          <div className="status-options">
            {statusOptions.map((s) => (
              <label key={s} className="check-line">
                <Checkbox checked={filters.statuses.includes(s)} onChange={() => toggleStatus(s)} />
                <span className="status-cell">
                  <span className="status-dot" style={{ background: STATUS_META[s].color }} />
                  {STATUS_META[s].label}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {showHubspotFilters && (
        <div className="filter-group">
          <div className="eyebrow">HubSpot</div>
          <div className="status-options">
            {HUBSPOT_FILTERS.map((filter) => (
              <label key={filter} className="check-line">
                <Checkbox
                  checked={filters.hubspot.includes(filter)}
                  onChange={() => toggleHubspot(filter)}
                />
                <span>{hubspotFilterLabel(filter)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="filter-group">
        <div className="eyebrow">Inbound Squad</div>
        <div className="status-options">
          {INBOUND_CLASSIFICATIONS.map((classification) => (
            <label key={classification} className="check-line">
              <Checkbox
                checked={filters.inboundClassifications.includes(classification)}
                onChange={() => toggleInboundClassification(classification)}
              />
              <span>{INBOUND_CLASSIFICATION_LABEL[classification]}</span>
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
