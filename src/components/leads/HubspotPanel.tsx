import { useEffect, useState } from 'react'
import { Check, ExternalLink, Loader2, Upload } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { fmtDate } from '../../lib/format'
import { useExportarHubspot, podeExportar } from '../../lib/leads'
import { buildHubspotPreview, websiteInstagramMismatchWarning } from '../../lib/hubspotPreview'

// Portal público da Inner AI (aparece em toda URL do HubSpot — não é segredo).
const HUBSPOT_PORTAL_ID = '50173893'

export function HubspotPanel({ lead }: { lead: Lead }) {
  const exp = useExportarHubspot()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const ready = podeExportar(lead)
  const contactId = lead.hubspot_contact_id
  const dealId = lead.hubspot_deal_id
  const preview = buildHubspotPreview(lead)
  const mismatchWarning = websiteInstagramMismatchWarning(lead)

  useEffect(() => {
    if (!confirmOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !exp.isPending) setConfirmOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmOpen, exp.isPending])

  function confirmarExportacao() {
    exp.mutate([lead.id], {
      onSettled: () => setConfirmOpen(false),
    })
  }

  return (
    <section>
      <span className="eyebrow">HubSpot</span>

      {/* "Importar pra HubSpot" (exportar-hubspot) cria Negócio + Contato, associados.
          O "Preparar no WhatsApp" (hubspot-sync) também upserta o contato. Quando os
          ids existem, mostramos os deep links. */}
      {dealId || contactId ? (
        <>
          {dealId && (
            <div className="enrich-row" style={{ marginBottom: 8 }}>
              <span className="er-label">
                <span className="status-dot" data-status="ok" />
                Negócio
              </span>
              <span className="er-val">
                <a
                  href={`https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir no HubSpot <ExternalLink size={12} />
                </a>
              </span>
            </div>
          )}
          {contactId && (
            <div className="enrich-row" style={{ marginBottom: 12 }}>
              <span className="er-label">
                <span className="status-dot" data-status="ok" />
                Contato
              </span>
              <span className="er-val">
                <a
                  href={`https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir no HubSpot <ExternalLink size={12} />
                </a>
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="callout" style={{ marginBottom: 12 }}>
          <b>“Importar pra HubSpot”</b> cria o negócio no pipeline <b>Squad Prospects</b>
          {' '}(etapa Prospects) + o contato. Ao enviar o WhatsApp, o negócio vai pra
          {' '}<b>Tentativa de Contato</b>.
        </div>
      )}

      <div className="kv">
        <span className="k">Status</span>
        <span className={`v${lead.hubspot_exported_at ? '' : ' dash'}`}>
          {lead.hubspot_exported_at ? (
            <span className="hs-exported">
              <span className="badge"><Check size={11} /> no HubSpot</span> {fmtDate(lead.hubspot_exported_at)}
            </span>
          ) : (
            '—'
          )}
        </span>
      </div>

      <button
        className="btn"
        style={{ marginTop: 12 }}
        disabled={!ready || exp.isPending}
        title={ready ? undefined : 'Precisa de nome e google_place_id (lead vindo do Google).'}
        onClick={() => setConfirmOpen(true)}
      >
        {exp.isPending ? (
          <>
            <Loader2 size={15} className="spin" /> Criando no HubSpot…
          </>
        ) : (
          <>
            <Upload size={15} />
            {lead.hubspot_exported_at ? 'Reexportar pra HubSpot' : 'Importar pra HubSpot'}
          </>
        )}
      </button>

      {exp.isSuccess && (
        <div className="search-status" role="status" style={{ marginTop: 10 }}>
          <Check size={14} /> HubSpot atualizado: {exp.data.exported.length} criado(s), {exp.data.skipped.length} pulado(s).
        </div>
      )}

      {exp.isError && (
        <div className="search-status err" style={{ marginTop: 10 }}>
          Falha ao criar no HubSpot: {(exp.error as Error).message}
        </div>
      )}

      {confirmOpen && (
        <div className="modal-overlay" onClick={() => !exp.isPending && setConfirmOpen(false)}>
          <div
            className="modal-card hubspot-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hubspot-preview-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="hubspot-preview-title" className="modal-title">
              Conferir antes de criar no HubSpot
            </h3>
            <p className="modal-msg">
              Esta ação cria um negócio no pipeline Squad Prospects e um contato associado.
            </p>

            <div className="hubspot-preview-list">
              {preview.map((row) => (
                <div key={row.label} className="kv">
                  <span className="k">{row.label}</span>
                  <span className={`v${row.value === '—' ? ' dash' : ''}`}>{row.value}</span>
                </div>
              ))}
            </div>

            {mismatchWarning && (
              <div className="callout" style={{ marginTop: 14 }}>
                {mismatchWarning}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmOpen(false)} disabled={exp.isPending}>
                Cancelar
              </button>
              <button className="btn" onClick={confirmarExportacao} disabled={exp.isPending}>
                {exp.isPending ? (
                  <>
                    <Loader2 size={15} className="spin" /> Criando…
                  </>
                ) : (
                  'Criar negócio + contato no HubSpot'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
