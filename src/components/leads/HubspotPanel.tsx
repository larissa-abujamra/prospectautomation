import { useEffect, useState } from 'react'
import { AlertCircle, Check, ExternalLink, Loader2, Upload } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { fmtDate } from '../../lib/format'
import { useExportarHubspot, podeExportar } from '../../lib/leads'
import { buildHubspotPreview, websiteInstagramMismatchWarning } from '../../lib/hubspotPreview'
import { hubspotContactUrl, hubspotDealUrl, type StatusDot } from '../../lib/communicationStatus'

function hubspotState({
  contactUrl,
  dealUrl,
  exportedAt,
  ready,
}: {
  contactUrl: string | null
  dealUrl: string | null
  exportedAt: string | null
  ready: boolean
}): { label: string; detail: string; nextAction: string; dot: StatusDot } {
  if (contactUrl && dealUrl) {
    return {
      label: 'Contato + negócio',
      detail: 'Este lead tem contato e negócio salvos no HubSpot.',
      nextAction: 'Abrir o contato ou o negócio pelos links abaixo.',
      dot: 'ok',
    }
  }
  if (contactUrl) {
    return {
      label: 'Contato no HubSpot',
      detail: 'O contato existe no HubSpot. O negócio pode ainda não ter sido criado pelo importador.',
      nextAction: ready ? 'Criar/atualizar o negócio se ele ainda não existir.' : 'Abrir o contato no HubSpot.',
      dot: 'pending',
    }
  }
  if (dealUrl) {
    return {
      label: 'Negócio no HubSpot',
      detail: 'O negócio existe, mas o ID do contato não está salvo neste lead.',
      nextAction: 'Abrir o negócio e conferir a associação do contato.',
      dot: 'pending',
    }
  }
  if (exportedAt) {
    return {
      label: 'Exportado sem IDs',
      detail: 'Há um timestamp de exportação, mas os IDs de contato/negócio não estão salvos aqui.',
      nextAction: 'Reexportar para recuperar os links corretos.',
      dot: 'pending',
    }
  }
  return {
    label: 'Fora do HubSpot',
    detail: ready
      ? 'Este lead tem os dados mínimos para criar contato e negócio no HubSpot.'
      : 'Faltam dados mínimos para criar o registro pelo importador.',
    nextAction: ready ? 'Criar negócio + contato no HubSpot.' : 'Completar nome e Google Place ID antes de importar.',
    dot: ready ? 'empty' : 'missing',
  }
}

export function HubspotPanel({ lead }: { lead: Lead }) {
  const exp = useExportarHubspot()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const ready = podeExportar(lead)
  const contactId = lead.hubspot_contact_id
  const dealId = lead.hubspot_deal_id
  const contactUrl = hubspotContactUrl(contactId)
  const dealUrl = hubspotDealUrl(dealId)
  const state = hubspotState({
    contactUrl,
    dealUrl,
    exportedAt: lead.hubspot_exported_at,
    ready,
  })
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

      <div className="status-card">
        <div className="status-card-head">
          <span className="status-title">
            <span className="status-dot" data-status={state.dot} />
            CRM
          </span>
          <span className="badge">{state.label}</span>
        </div>
        <p className="status-detail">{state.detail}</p>
        <div className="status-next">
          <AlertCircle size={13} /> Próximo: {state.nextAction}
        </div>
      </div>

      {/* "Importar pra HubSpot" (exportar-hubspot) cria Negócio + Contato, associados.
          O "Preparar no WhatsApp" (hubspot-sync) também upserta o contato. Quando os
          ids existem, mostramos os deep links. */}
      {dealUrl || contactUrl ? (
        <>
          {dealUrl && (
            <div className="enrich-row" style={{ marginBottom: 8 }}>
              <span className="er-label">
                <span className="status-dot" data-status="ok" />
                Negócio
              </span>
              <span className="er-val">
                <a
                  href={dealUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir negócio <ExternalLink size={12} />
                </a>
              </span>
            </div>
          )}
          {contactUrl && (
            <div className="enrich-row" style={{ marginBottom: 12 }}>
              <span className="er-label">
                <span className="status-dot" data-status="ok" />
                Contato
              </span>
              <span className="er-val">
                <a
                  href={contactUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir contato <ExternalLink size={12} />
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
            {lead.hubspot_exported_at || contactUrl || dealUrl
              ? 'Atualizar HubSpot'
              : 'Criar negócio + contato'}
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
