import { useState } from 'react'
import { AlertCircle, Check, ExternalLink, Loader2, MessageCircle, Search, Send, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  enriquecerLead,
  encontrarWhatsapp,
  exportarHubspot,
  LEADS_KEY,
  syncHubspot,
  useBuscarNegocios,
} from '../../lib/leads'
import { fetchLeads } from '../../lib/fetchLeads'
import { supabase } from '../../lib/supabase'
import type { Lead } from '../../lib/types'
import {
  buildDirectCompanySearchParams,
  directOutreachWarnings,
  hasValidBrWhatsappForDirectOutreach,
  parseDirectCompanyInput,
  selectBestDirectLead,
  type DirectLeadSelection,
} from '../../lib/directOutreach'
import {
  hubspotContactUrl,
  hubspotDealUrl,
  preferredWhatsappNumber,
  whatsappUrl,
} from '../../lib/communicationStatus'

type DirectStep = 'idle' | 'searching' | 'enriching' | 'finding_whatsapp' | 'ready' | 'sending'

interface DirectResult {
  selection: DirectLeadSelection
  warnings: string[]
}

function valueOrDash(value: string | null | undefined): string {
  const text = value?.trim()
  return text ? text : '—'
}

function instagramLabel(handle: string | null): string {
  const text = handle?.trim().replace(/^@/, '')
  return text ? `@${text}` : '—'
}

function stepLabel(step: DirectStep): string | null {
  switch (step) {
    case 'searching':
      return 'Buscando empresa no Google Places...'
    case 'enriching':
      return 'Enriquecendo CNPJ, dono e sinais...'
    case 'finding_whatsapp':
      return 'Procurando WhatsApp confiável...'
    case 'sending':
      return 'Criando HubSpot e acionando workflow...'
    default:
      return null
  }
}

function Row({ label, value, href }: { label: string; value: string; href?: string | null }) {
  const empty = value === '—'
  return (
    <div className="kv">
      <span className="k">{label}</span>
      <span className={`v${empty ? ' dash' : ''}`}>
        {href && !empty ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value} <ExternalLink size={12} />
          </a>
        ) : (
          value
        )}
      </span>
    </div>
  )
}

export function DirectOutreachPanel() {
  const qc = useQueryClient()
  const buscar = useBuscarNegocios()
  const [input, setInput] = useState('')
  const [step, setStep] = useState<DirectStep>('idle')
  const [result, setResult] = useState<DirectResult | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sendSuccess, setSendSuccess] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const busy = step === 'searching' || step === 'enriching' || step === 'finding_whatsapp' || step === 'sending'
  const lead = result?.selection.lead ?? null
  const phone = lead ? preferredWhatsappNumber(lead) : null
  const canSend = lead ? hasValidBrWhatsappForDirectOutreach(lead) : false
  const statusText = stepLabel(step)
  const contactUrl = hubspotContactUrl(lead?.hubspot_contact_id)
  const dealUrl = hubspotDealUrl(lead?.hubspot_deal_id)

  async function refreshLeads(): Promise<Lead[]> {
    return qc.fetchQuery({
      queryKey: LEADS_KEY,
      queryFn: () => fetchLeads(supabase),
    })
  }

  function updateResult(selection: DirectLeadSelection) {
    setResult({
      selection,
      warnings: directOutreachWarnings(selection.lead, selection.confidence),
    })
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const parsed = parseDirectCompanyInput(input)
    if (!parsed || busy) return

    setError(null)
    setSendSuccess(null)
    setResult(null)
    setNotices([])

    try {
      setStep('searching')
      const search = await buscar.mutateAsync(buildDirectCompanySearchParams(parsed))
      if (search.place_ids.length === 0) {
        setError('Nenhum resultado encontrado no Google Places para essa empresa.')
        setStep('idle')
        return
      }

      const freshAfterSearch = await refreshLeads()
      const selection = selectBestDirectLead(freshAfterSearch, search.place_ids, parsed.company)
      if (!selection) {
        setError('A busca retornou lugares, mas não foi possível carregar o lead salvo.')
        setStep('idle')
        return
      }
      updateResult(selection)

      let current = selection.lead
      const nextNotices: string[] = []

      setStep('enriching')
      try {
        const enriched = await enriquecerLead(current.id, false)
        current = enriched.lead
        nextNotices.push('Enriquecimento concluído.')
      } catch (err) {
        nextNotices.push(`Enriquecimento não concluiu: ${err instanceof Error ? err.message : 'erro desconhecido'}`)
      }

      setStep('finding_whatsapp')
      try {
        const whatsapp = await encontrarWhatsapp(current.id, false)
        current = whatsapp.lead
        nextNotices.push(
          whatsapp.whatsapp_status === 'found'
            ? 'WhatsApp encontrado.'
            : 'Busca de WhatsApp terminou sem número pronto.',
        )
      } catch (err) {
        nextNotices.push(`Busca de WhatsApp falhou: ${err instanceof Error ? err.message : 'erro desconhecido'}`)
      }

      const freshAfterEnrichment = await refreshLeads()
      const updatedLead = freshAfterEnrichment.find((candidate) => candidate.id === current.id) ?? current
      updateResult({ ...selection, lead: updatedLead })
      setNotices(nextNotices)
      setStep('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido no disparo direto.')
      setStep('idle')
    }
  }

  async function confirmSend() {
    const currentResult = result
    if (!currentResult || !lead || !canSend || step === 'sending') return

    setError(null)
    setSendSuccess(null)
    setStep('sending')
    try {
      const exported = await exportarHubspot([lead.id])
      const exportedLead = exported.exported.find((item) => item.id === lead.id)
      const skippedLead = exported.skipped.find((item) => item.id === lead.id)
      if (!exportedLead) {
        throw new Error(skippedLead?.motivo ?? 'HubSpot não confirmou contato + negócio para este lead.')
      }

      const synced = await syncHubspot(lead.id, true)
      if (synced.skipped) {
        throw new Error(synced.skip_reason === 'already_contacted'
          ? 'Lead já tinha disparo registrado; o workflow não foi acionado novamente.'
          : synced.skip_reason ?? 'HubSpot pulou o acionamento do workflow.')
      }
      if (!(synced.workflow_triggered ?? synced.triggered)) {
        throw new Error('HubSpot sincronizou o contato, mas não confirmou whatsapp_outreach=ready.')
      }

      const fresh = await refreshLeads()
      const updatedLead = fresh.find((candidate) => candidate.id === lead.id) ?? lead
      updateResult({ ...currentResult.selection, lead: updatedLead })
      setSendSuccess('Workflow WhatsApp acionado no HubSpot. Olivia acompanhará as respostas pelo inbox.')
      setConfirmOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao acionar WhatsApp via HubSpot.')
    } finally {
      setStep('ready')
    }
  }

  return (
    <div className="card search-card direct-outreach-card">
      <div className="direct-outreach-head">
        <div>
          <div className="eyebrow">Disparo direto</div>
          <h3>Buscar uma empresa e enviar WhatsApp</h3>
          <p>
            Digite o nome da empresa. Use vírgula para contexto, por exemplo:
            {' '}<b>Pietra Pâtisserie, Pinheiros SP</b>. A busca nunca envia automaticamente.
          </p>
        </div>
      </div>

      <form className="search-row" onSubmit={handleSearch}>
        <div className="field direct-company-field">
          <label className="eyebrow" htmlFor="direct-company">Empresa</label>
          <input
            id="direct-company"
            placeholder="Ex.: Doceria da Ana, Santo André"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <button className="btn" type="submit" disabled={busy || !parseDirectCompanyInput(input)}>
          {busy && step !== 'sending' ? (
            <>
              <Loader2 size={15} className="spin" /> Processando...
            </>
          ) : (
            <>
              <Search size={15} /> Buscar e enriquecer
            </>
          )}
        </button>
      </form>

      {statusText && (
        <div className="search-status" role="status">
          <Loader2 size={14} className="spin" /> {statusText}
        </div>
      )}

      {error && (
        <div className="search-status err" role="alert">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {sendSuccess && (
        <div className="search-status" role="status">
          <Check size={14} /> {sendSuccess}
        </div>
      )}

      {result && lead && (
        <div className="direct-result-card">
          <div className="direct-result-title">
            <div>
              <span className="eyebrow">Preview antes do envio</span>
              <h4>{lead.nome}</h4>
            </div>
            <span className="badge">Confiança {result.selection.confidence}</span>
          </div>

          <div className="direct-result-grid">
            <Row label="Endereço" value={valueOrDash(lead.endereco)} />
            <Row label="Cidade" value={valueOrDash(lead.cidade)} />
            <Row label="Telefone Google" value={valueOrDash(lead.telefone)} />
            <Row label="WhatsApp usado" value={valueOrDash(phone)} href={whatsappUrl(phone)} />
            <Row label="Website" value={valueOrDash(lead.website)} href={lead.website} />
            <Row label="Instagram" value={instagramLabel(lead.instagram_handle)} />
            <Row label="Fonte" value={`Google Places · ${result.selection.reason}`} />
            <Row label="HubSpot contato" value={contactUrl ? 'Abrir contato' : '—'} href={contactUrl} />
            <Row label="HubSpot negócio" value={dealUrl ? 'Abrir negócio' : '—'} href={dealUrl} />
          </div>

          {(notices.length > 0 || result.warnings.length > 0) && (
            <div className="direct-warning-list">
              {notices.map((notice) => (
                <div key={notice} className="direct-note">
                  <span className="status-dot" data-status="pending" /> {notice}
                </div>
              ))}
              {result.warnings.map((warning) => (
                <div key={warning} className="direct-note warn">
                  <AlertCircle size={13} /> {warning}
                </div>
              ))}
            </div>
          )}

          <div className="direct-actions">
            <button
              type="button"
              className="btn"
              disabled={!canSend || step === 'sending'}
              title={canSend ? 'Abre a confirmação antes de acionar o workflow.' : 'Disponível só com WhatsApp BR válido e sem disparo anterior.'}
              onClick={() => setConfirmOpen(true)}
            >
              <MessageCircle size={15} /> Enviar WhatsApp via HubSpot
            </button>
            {!canSend && (
              <span className="muted-line">
                Bloqueado até existir WhatsApp BR válido e sem disparo anterior.
              </span>
            )}
          </div>
        </div>
      )}

      {confirmOpen && lead && (
        <div className="modal-overlay" onClick={() => step !== 'sending' && setConfirmOpen(false)}>
          <div
            className="modal-card hubspot-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="direct-send-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="direct-send-title" className="modal-title">
              Confirmar disparo via HubSpot
            </h3>
            <p className="modal-msg">
              Esta ação cria/atualiza contato e negócio pelo exportador existente e depois marca
              {' '}<b>whatsapp_outreach=ready</b>. O envio real acontece nos workflows ativos do HubSpot.
            </p>

            <div className="hubspot-preview-list">
              <Row label="Empresa" value={lead.nome} />
              <Row label="WhatsApp" value={valueOrDash(phone)} />
              <Row label="Cidade" value={valueOrDash(lead.cidade)} />
              <Row label="Workflow" value="Squad Prospeccao WhatsApp via HubSpot" />
            </div>

            <div className="callout" style={{ marginTop: 14 }}>
              Se HubSpot ou Meta recusarem o envio por número inválido, template ou cap, a falha será mostrada aqui e o workflow não será prometido como entregue.
            </div>

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirmOpen(false)} disabled={step === 'sending'}>
                <X size={14} /> Cancelar
              </button>
              <button className="btn" onClick={confirmSend} disabled={step === 'sending'}>
                {step === 'sending' ? (
                  <>
                    <Loader2 size={15} className="spin" /> Acionando...
                  </>
                ) : (
                  <>
                    <Send size={15} /> Confirmar e acionar HubSpot
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
