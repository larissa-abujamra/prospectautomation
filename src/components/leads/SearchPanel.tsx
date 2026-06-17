import { useRef, useState } from 'react'
import { Search, Loader2, RotateCcw, ShieldCheck, Square, SlidersHorizontal } from 'lucide-react'
import { useBuscarNegocios } from '../../lib/leads'
import { SETORES, termoBusca } from '../../lib/setores'
import { buildSafeProspectingQueue, GRANDE_SP_SAFE_PRESET } from '../../lib/safeProspecting'
import { LocalAutocomplete } from '../LocalAutocomplete'
import { Checkbox } from '../Checkbox'
import type { Filters } from './filters'
import { EMPTY_FILTERS, isFiltering } from './filters'
import {
  INBOUND_CLASSIFICATIONS,
  INBOUND_CLASSIFICATION_LABEL,
  LEAD_ORIGEM_LABEL,
} from '../../lib/types'

interface PresetProgress {
  running: boolean
  done: number
  total: number
  inserted: number
  updated: number
  errors: number
  current: string | null
}

// Painel "Buscar negócios" — dispara a Edge Function de sourcing (genérica).
// O Local usa o autocomplete do Places (desambigua lugares homônimos) e o
// setor é texto livre com sugestões (sinônimos expandem no backend).
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
  const [preset, setPreset] = useState<PresetProgress | null>(null)
  const [showMore, setShowMore] = useState(false)
  const stopPresetRef = useRef(false)
  const buscar = useBuscarNegocios()
  const presetTotal = SETORES.length * GRANDE_SP_SAFE_PRESET.locations.length

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
    setPreset(null)
    buscar.reset()
  }

  async function rodarPresetSeguro() {
    if (preset?.running || buscar.isPending) return
    const queue = buildSafeProspectingQueue()
    stopPresetRef.current = false
    buscar.reset()
    let inserted = 0
    let updated = 0
    let errors = 0
    let consecutiveErrors = 0

    setPreset({
      running: true,
      done: 0,
      total: queue.length,
      inserted,
      updated,
      errors,
      current: null,
    })

    for (let i = 0; i < queue.length; i++) {
      if (stopPresetRef.current) break
      const item = queue[i]
      setPreset((prev) => prev && { ...prev, current: `${item.setorLabel} · ${item.local}` })
      try {
        const result = await buscar.mutateAsync(item.params)
        inserted += result.inserted
        updated += result.updated
        consecutiveErrors = 0
      } catch {
        errors += 1
        consecutiveErrors += 1
      }
      setPreset((prev) => prev && {
        ...prev,
        done: i + 1,
        inserted,
        updated,
        errors,
      })
      if (consecutiveErrors >= 3) break
    }

    setPreset((prev) => prev && { ...prev, running: false, current: null })
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

      <div className="safe-preset-card">
        <div className="safe-preset-copy">
          <span className="eyebrow">Preset seguro</span>
          <h3>{GRANDE_SP_SAFE_PRESET.label}</h3>
          <p>
            {GRANDE_SP_SAFE_PRESET.description} A busca roda em fila, uma combinação por vez,
            e o disparo depois respeita cap diário e lotes pequenos.
          </p>
          <div className="safe-preset-metrics" aria-label="Escopo do preset">
            <span>{SETORES.length} setores</span>
            <span>{GRANDE_SP_SAFE_PRESET.locations.length} cidades/regiões</span>
            <span>{presetTotal} buscas sequenciais</span>
            <span>até {GRANDE_SP_SAFE_PRESET.maxPerSearch} por busca</span>
          </div>
        </div>

        <div className="safe-preset-actions">
          {preset?.running ? (
            <>
              <button
                type="button"
                className="btn ghost"
                onClick={() => (stopPresetRef.current = true)}
                title="Para após a busca atual terminar."
              >
                <Square size={14} /> Parar
              </button>
              <div className="progress safe-preset-progress">
                <span style={{ width: `${preset.total ? (preset.done / preset.total) * 100 : 0}%` }} />
              </div>
            </>
          ) : (
            <button type="button" className="btn" onClick={rodarPresetSeguro} disabled={buscar.isPending}>
              <ShieldCheck size={15} /> Rodar preset seguro
            </button>
          )}
        </div>
      </div>

      {buscar.isError && (
        <div className="search-status err">
          {(buscar.error as Error)?.message ?? 'Falha na busca.'}
        </div>
      )}
      {preset && (
        <div className={`search-status${preset.errors > 0 ? ' err' : ''}`} role="status">
          Preset: {preset.done}/{preset.total} buscas · {preset.inserted} novas · {preset.updated} atualizadas
          {preset.errors > 0 && <> · {preset.errors} erro(s)</>}
          {preset.current && <> · agora: {preset.current}</>}
        </div>
      )}
      {buscar.isSuccess && !buscar.isPending && (
        <div className="search-status">
          {buscar.data.inserted} {buscar.data.inserted === 1 ? 'nova' : 'novas'},{' '}
          {buscar.data.updated} {buscar.data.updated === 1 ? 'atualizada' : 'atualizadas'}
          {(buscar.data.stats?.outreach_dedupe_skipped ?? 0) > 0 && (
            <> · {buscar.data.stats?.outreach_dedupe_skipped} já com disparo ocultas</>
          )}
          .
        </div>
      )}
    </div>
  )
}
