import { Sparkles, Loader2 } from 'lucide-react'
import type { EnrichFieldStatus, Lead } from '../../lib/types'
import { fmtCnpj, fmtInt } from '../../lib/format'
import { useEnriquecerLead, useUpdateLead } from '../../lib/leads'

// Confiança 0.6–0.75 → match aceito mas marcado pra conferência humana.
const CONFERIR_MAX = 0.75

function dot(status: EnrichFieldStatus | undefined): EnrichFieldStatus | 'empty' {
  return status ?? 'empty'
}

function Waterfall({
  label,
  status,
  value,
  extra,
}: {
  label: string
  status: EnrichFieldStatus | 'empty'
  value: string | null
  extra?: React.ReactNode
}) {
  const empty = value == null || value === '—'
  return (
    <div className="enrich-row">
      <span className="er-label">
        <span className="status-dot" data-status={status} />
        {label}
      </span>
      <span className={`er-val${empty ? ' dash' : ''}`}>
        {empty ? '—' : value}
        {extra}
      </span>
    </div>
  )
}

export function EnrichPanel({ lead }: { lead: Lead }) {
  const enrich = useEnriquecerLead()
  const update = useUpdateLead()
  const running = enrich.isPending

  const es = lead.enrich_status ?? undefined
  // Enquanto roda, os três dots ficam 'pending'; senão refletem o enrich_status.
  const st = (field: 'cnpj' | 'dono' | 'instagram'): EnrichFieldStatus | 'empty' =>
    running ? 'pending' : dot(es?.[field])

  const confidence = es?.cnpj_confidence
  const conferir =
    !running && !!lead.cnpj && confidence != null && confidence < CONFERIR_MAX

  function confirmarCnpj() {
    update.mutate({
      id: lead.id,
      patch: { enrich_status: { ...es, cnpj: 'ok', cnpj_confidence: 1 } },
    })
  }

  function limparCnpj() {
    update.mutate({
      id: lead.id,
      patch: {
        cnpj: null,
        razao_social: null,
        socios: null,
        dono_nome: null,
        enrich_status: { ...es, cnpj: 'missing', cnpj_confidence: undefined },
      },
    })
  }

  return (
    <section>
      <span className="eyebrow">Enriquecimento</span>

      <Waterfall
        label="CNPJ"
        status={st('cnpj')}
        value={fmtCnpj(lead.cnpj)}
        extra={conferir ? <span className="badge">conferir</span> : undefined}
      />
      <Waterfall label="Dono" status={st('dono')} value={lead.dono_nome} />
      <Waterfall
        label="Instagram"
        status={st('instagram')}
        value={lead.instagram_followers == null ? null : fmtInt(lead.instagram_followers)}
      />

      {conferir && (
        <div className="conferir-actions">
          <button className="btn sm" onClick={confirmarCnpj} disabled={update.isPending}>
            Confirmar CNPJ
          </button>
          <button className="btn ghost sm" onClick={limparCnpj} disabled={update.isPending}>
            Limpar
          </button>
        </div>
      )}

      {lead.razao_social && (
        <div className="kv" style={{ marginTop: 14 }}>
          <span className="k">Razão social</span>
          <span className="v">{lead.razao_social}</span>
        </div>
      )}

      {lead.socios && lead.socios.length > 0 && (
        <div className="socios-list">
          <span className="eyebrow">Sócios (QSA)</span>
          {lead.socios.map((s, i) => (
            <div key={i} className="socio">
              <span className="nome">{s.nome ?? '—'}</span>
              <span className="qual">{s.qualificacao ?? '—'}</span>
            </div>
          ))}
        </div>
      )}

      <button
        className="btn"
        style={{ marginTop: 16 }}
        onClick={() => enrich.mutate({ leadId: lead.id, force: !!lead.cnpj })}
        disabled={running}
      >
        {running ? (
          <>
            <Loader2 size={15} className="spin" /> Enriquecendo…
          </>
        ) : (
          <>
            <Sparkles size={15} /> {lead.cnpj ? 'Re-enriquecer' : 'Enriquecer'}
          </>
        )}
      </button>

      {enrich.isError && (
        <div className="search-status err" style={{ marginTop: 10 }}>
          {(enrich.error as Error).message}
        </div>
      )}
    </section>
  )
}
