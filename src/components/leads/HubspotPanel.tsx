import { Check, ExternalLink, Upload } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { fmtDate } from '../../lib/format'
import { useExportarHubspot, podeExportar } from '../../lib/leads'

// Portal público da Inner AI (aparece em toda URL do HubSpot — não é segredo).
const HUBSPOT_PORTAL_ID = '50173893'

export function HubspotPanel({ lead }: { lead: Lead }) {
  const exp = useExportarHubspot()
  const ready = podeExportar(lead)
  const contactId = lead.hubspot_contact_id
  const dealId = lead.hubspot_deal_id

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
        onClick={() => exp.mutate([lead.id])}
      >
        <Upload size={15} />
        {lead.hubspot_exported_at ? 'Reexportar pra HubSpot' : 'Importar pra HubSpot'}
      </button>

      {exp.isError && (
        <div className="search-status err" style={{ marginTop: 10 }}>
          {(exp.error as Error).message}
        </div>
      )}
    </section>
  )
}
