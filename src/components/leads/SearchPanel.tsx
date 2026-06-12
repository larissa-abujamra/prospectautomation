import { useState } from 'react'
import { Search, Loader2, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useBuscarNegocios } from '../../lib/leads'
import { SETORES, termoBusca } from '../../lib/setores'
import { LocalAutocomplete } from '../LocalAutocomplete'
import { Checkbox } from '../Checkbox'
import type { Filters } from './filters'
import { EMPTY_FILTERS, isFiltering } from './filters'
import {
  INBOUND_CLASSIFICATIONS,
  INBOUND_CLASSIFICATION_LABEL,
  LEAD_ORIGEM_LABEL,
} from '../../lib/types'

export function SearchPanel({
  filters,
  onFiltersChange,
}: {
  filters?: Filters
  onFiltersChange?: (f: Filters) => void
} = {}) {
  const [setor, setSetor] = useState('')
  const [local, setLocal] = useState('')
  const [max, setMax] = useState(40)
  const [showMore, setShowMore] = useState(false)
  const buscar = useBuscarNegocios()

  const setF = (patch: Partial<Filters>) => {
    if (filters && onFiltersChange) onFiltersChange({ ...filters, ...patch })
  }

  function toggleInbound(c: Filters['inboundClassifications'][number]) {
    if (!filters || !onFiltersChange) return
    const has = filters.inboundClassifications.includes(c)
    setF({
      inboundClassifications: has
        ? filters.inboundClassifications.filter((x) => x !== c)
        : [...filters.inboundClassifications, c],
    })
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = setor.trim()
    const l = local.trim()
    if (!s || !l || buscar.isPending) return
    buscar.mutate({ setor: termoBusca(s), local: l, max, comSeguidores: false })
  }

  function limpar() {
    setSetor('')
    setLocal('')
    setMax(40)
    buscar.reset()
  }

  const filtering = filters ? isFiltering(filters) : false
  const hasFilterControls = !!(filters && onFiltersChange)

  return (
    <div className="card search-card">
      <div className="eyebrow" style={{ marginBottom: 16 }}>Buscar no Google</div>

      <form className="search-row" onSubmit={handleSubmit}>
        <div className="field">
          <label className="eyebrow" htmlFor="setor">Setor</label>
          <input
            id="setor"
            list="setores-sugestoes"
            placeholder="Ex.: Confeitaria"
            value={setor}
            onChange={(e) => setSetor(e.target.value)}
          />
          <datalist id="setores-sugestoes">
            {SETORES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>

        <div className="field" style={{ flex: 1.4 }}>
          <label className="eyebrow" htmlFor="local">Local (bairro, cidade ou região)</label>
          <LocalAutocomplete id="local" value={local} onChange={setLocal} />
        </div>

        <div className="field narrow">
          <label className="eyebrow" htmlFor="qtd">Quantidade</label>
          <select id="qtd" value={max} onChange={(e) => setMax(Number(e.target.value))}>
            <option value={20}>20</option>
            <option value={40}>40</option>
            <option value={60}>60</option>
          </select>
        </div>

        <button
          type="submit"
          className="btn-glow"
          disabled={buscar.isPending || !setor.trim() || !local.trim()}
        >
          <span className="btn-glow-bg" />
          <span className="btn-glow-content">
            {buscar.isPending ? (
              <><Loader2 size={16} className="spin" /> Buscando…</>
            ) : (
              <><Search size={16} /> Buscar</>
            )}
          </span>
        </button>

        <button type="button" className="btn ghost" onClick={limpar} disabled={buscar.isPending}>
          <RotateCcw size={15} /> Limpar
        </button>

        {hasFilterControls && (
          <button
            type="button"
            className={`btn ghost search-more-toggle${filtering ? ' is-active' : ''}`}
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
          >
            <SlidersHorizontal size={15} />
            {filtering ? 'Filtros ·' : 'Filtros'}
          </button>
        )}
      </form>

      {showMore && hasFilterControls && filters && onFiltersChange && (
        <div className="search-more-row">
          <div className="field">
            <label className="eyebrow" htmlFor="min-followers">Seguidores mínimos</label>
            <input
              id="min-followers"
              type="number"
              min={0}
              placeholder="Ex.: 3000"
              value={filters.minFollowers}
              onChange={(e) =>
                setF({ minFollowers: e.target.value === '' ? '' : Number(e.target.value) })
              }
            />
          </div>

          <div className="field narrow">
            <label className="eyebrow" htmlFor="origem-filter">Origem</label>
            <select
              id="origem-filter"
              value={filters.origem}
              onChange={(e) => setF({ origem: e.target.value as Filters['origem'] })}
            >
              <option value="">Todas</option>
              <option value="google_places">{LEAD_ORIGEM_LABEL.google_places}</option>
              <option value="squad_leads_form">{LEAD_ORIGEM_LABEL.squad_leads_form}</option>
            </select>
          </div>

          <div className="search-more-checks">
            <div className="eyebrow">Inbound Squad</div>
            {INBOUND_CLASSIFICATIONS.map((c) => (
              <label key={c} className="check-line">
                <Checkbox
                  checked={filters.inboundClassifications.includes(c)}
                  onChange={() => toggleInbound(c)}
                />
                <span>{INBOUND_CLASSIFICATION_LABEL[c]}</span>
              </label>
            ))}
          </div>

          <div className="search-more-checks">
            <div className="eyebrow">Seguidores</div>
            <label className="check-line">
              <Checkbox
                checked={filters.includeNoFollowers}
                onChange={() => setF({ includeNoFollowers: !filters.includeNoFollowers })}
              />
              <span>Incluir sem dado</span>
            </label>
          </div>

          <button
            type="button"
            className="btn ghost"
            onClick={() => onFiltersChange(EMPTY_FILTERS)}
            disabled={!filtering}
          >
            Limpar filtros
          </button>
        </div>
      )}

      {buscar.isError && (
        <div className="search-status err">
          {(buscar.error as Error)?.message ?? 'Falha na busca.'}
        </div>
      )}
      {buscar.isSuccess && !buscar.isPending && (
        <div className="search-status">
          {buscar.data.inserted} {buscar.data.inserted === 1 ? 'nova' : 'novas'},{' '}
          {buscar.data.updated} {buscar.data.updated === 1 ? 'atualizada' : 'atualizadas'}.
        </div>
      )}
    </div>
  )
}
