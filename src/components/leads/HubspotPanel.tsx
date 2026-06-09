import { Check, Upload } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { fmtDate } from '../../lib/format'
import { useExportarHubspot, podeExportar } from '../../lib/leads'

export function HubspotPanel({ lead }: { lead: Lead }) {
  const exp = useExportarHubspot()
  const ready = podeExportar(lead)

  return (
    <section>
      <span className="eyebrow">HubSpot</span>

      <div className="callout" style={{ marginBottom: 12 }}>
        A conexão com o HubSpot ainda não está ativa. Por enquanto isto marca o lead
        como pronto/exportado; o envio real cria o card e dispara o fluxo de WhatsApp
        no HubSpot quando a API for conectada.
      </div>

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

      {lead.hubspot_contact_id && (
        <div style={{ marginTop: 10 }}>
          <a href={`https://app.hubspot.com/contacts/50173893/record/0-1/${lead.hubspot_contact_id}`} target="_blank" rel="noreferrer">
            Abrir contato no HubSpot ↗
          </a>
        </div>
      )}

      {exp.isError && (
        <div className="search-status err" style={{ marginTop: 10 }}>
          {(exp.error as Error).message}
        </div>
      )}
    </section>
  )
}
