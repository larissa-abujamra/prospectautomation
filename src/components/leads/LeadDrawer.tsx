import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { LEAD_STATUSES, STATUS_META } from '../../lib/types'
import { fmtInt, fmtRating, fmtText } from '../../lib/format'
import { useUpdateLead } from '../../lib/leads'
import { EnrichPanel } from './EnrichPanel'
import { HubspotPanel } from './HubspotPanel'

function Row({ k, v }: { k: string; v: string | null }) {
  const empty = v == null || v === '' || v === '—'
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v${empty ? ' dash' : ''}`}>{empty ? '—' : v}</span>
    </div>
  )
}

// O componente é montado com key={lead.id} pelo pai — então o estado local
// (notas) já nasce correto a cada lead, sem precisar de efeito de reset.
export function LeadDrawer({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const update = useUpdateLead()
  const [notas, setNotas] = useState(lead.notas ?? '')
  const [hint, setHint] = useState('')
  const dirty = useRef(false)

  // Autosave das notas com debounce (~1s).
  useEffect(() => {
    if (!dirty.current) return
    setHint('Salvando…')
    const t = setTimeout(() => {
      update.mutate(
        { id: lead.id, patch: { notas: notas.trim() === '' ? null : notas } },
        { onSuccess: () => setHint('Salvo') },
      )
    }, 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notas])

  // Fecha com Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>{lead.nome}</h2>
            <div className="drawer-sub">{fmtText(lead.endereco)}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Fechar">
            <X size={18} />
          </button>
        </div>

        <section>
          <span className="eyebrow">Pipeline</span>
          <div className="field">
            <label className="eyebrow" htmlFor="status">Status</label>
            <select
              id="status"
              value={lead.status}
              onChange={(e) =>
                update.mutate({ id: lead.id, patch: { status: e.target.value as Lead['status'] } })
              }
            >
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </div>
        </section>

        <section>
          <span className="eyebrow">Contato &amp; Google</span>
          <Row k="Bairro" v={lead.bairro} />
          <Row k="Cidade" v={lead.cidade} />
          <Row k="Telefone" v={lead.telefone} />
          <Row k="Website" v={lead.website} />
          <Row k="Nota" v={lead.rating == null ? null : fmtRating(lead.rating)} />
          <Row k="Avaliações" v={lead.reviews_count == null ? null : fmtInt(lead.reviews_count)} />
        </section>

        <section>
          <span className="eyebrow">Instagram</span>
          <Row k="Handle" v={lead.instagram_handle ? `@${lead.instagram_handle}` : null} />
          <Row
            k="Seguidores"
            v={lead.instagram_followers == null ? null : fmtInt(lead.instagram_followers)}
          />
        </section>

        <EnrichPanel lead={lead} />

        <HubspotPanel lead={lead} />

        <section>
          <span className="eyebrow">Notas</span>
          <textarea
            value={notas}
            placeholder="Anotações sobre este lead…"
            onChange={(e) => {
              dirty.current = true
              setNotas(e.target.value)
            }}
          />
          <div className="autosave-hint">{hint}</div>
        </section>
      </div>
    </div>
  )
}
