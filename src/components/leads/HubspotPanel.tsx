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

  return (
    <section>
      <span className="eyebrow">HubSpot</span>

      {/* O contato REAL é criado pelo "Preparar no WhatsApp" (hubspot-sync). Quando
          ele existe, mostramos o link direto; a exportação de CRM (empresa + negócio)
          abaixo ainda é stub. */}
      {contactId ? (
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
      ) : (
        <div className="callout" style={{ marginBottom: 12 }}>
          O contato é criado no HubSpot ao clicar em <b>“Preparar no WhatsApp”</b> acima.
          A exportação completa de CRM (empresa + negócio) ainda não está ligada.
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
        title={ready ? undefined : 'Enriqueça antes de exportar (precisa de CNPJ e dono).'}
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
