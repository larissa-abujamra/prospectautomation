import { useMemo, useState } from 'react'
import { AlertCircle, Check, Loader2, Send } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  criarLeadManualOlivia,
  exportarHubspot,
  LEADS_KEY,
  syncHubspot,
} from '../../lib/leads'
import {
  normalizeManualOliviaInput,
} from '../../lib/manualOlivia'
import { statusDisparo } from '../../lib/disparos'

type ManualStep = 'idle' | 'creating' | 'exporting' | 'triggering'

function stepLabel(step: ManualStep): string | null {
  switch (step) {
    case 'creating':
      return 'Criando contato manual...'
    case 'exporting':
      return 'Criando contato e negócio no HubSpot...'
    case 'triggering':
      return 'Acionando workflow WhatsApp...'
    default:
      return null
  }
}

export function ManualOliviaContactForm() {
  const qc = useQueryClient()
  const [nome, setNome] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [cidade, setCidade] = useState('')
  const [notas, setNotas] = useState('')
  const [step, setStep] = useState<ManualStep>('idle')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const validation = useMemo(
    () => normalizeManualOliviaInput({ nome, whatsapp, cidade, notas }),
    [nome, whatsapp, cidade, notas],
  )
  const busy = step !== 'idle'
  const statusText = stepLabel(step)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validation.ok || busy) return

    setError(null)
    setSuccess(null)
    let leadId: string | null = null

    try {
      setStep('creating')
      const manual = await criarLeadManualOlivia(validation.value)
      leadId = manual.lead.id

      setStep('exporting')
      const exported = await exportarHubspot([manual.lead.id])
      const exportedLead = exported.exported.find((item) => item.id === manual.lead.id)
      const skippedLead = exported.skipped.find((item) => item.id === manual.lead.id)
      if (!exportedLead) {
        throw new Error(skippedLead?.motivo ?? 'HubSpot não confirmou contato + negócio para este lead.')
      }

      setStep('triggering')
      const synced = await syncHubspot(manual.lead.id, true)
      if (synced.skipped) {
        throw new Error(
          synced.skip_reason === 'already_contacted'
            ? 'Lead já tinha disparo registrado; o workflow não foi acionado novamente.'
            : synced.skip_reason ?? 'HubSpot pulou o acionamento do workflow.',
        )
      }
      if (!(synced.workflow_triggered ?? synced.triggered)) {
        throw new Error('HubSpot sincronizou o contato, mas não confirmou whatsapp_outreach=ready.')
      }

      await qc.invalidateQueries({ queryKey: LEADS_KEY })
      const status = statusDisparo({ whatsapp_sent_at: new Date().toISOString(), whatsapp_send_status: null })
      setSuccess(`${validation.value.nome}: ${status.label}. Acompanhe entrega e resposta na lista abaixo.`)
      setNome('')
      setWhatsapp('')
      setCidade('')
      setNotas('')
    } catch (err) {
      if (leadId) await qc.invalidateQueries({ queryKey: LEADS_KEY })
      setError(err instanceof Error ? err.message : 'Falha ao acionar WhatsApp via HubSpot.')
    } finally {
      setStep('idle')
    }
  }

  return (
    <div className="card search-card direct-outreach-card">
      <div className="direct-outreach-head">
        <div>
          <div className="eyebrow">Disparo manual</div>
          <h3>Adicionar número específico e acionar Olivia</h3>
          <p>
            Use para contatos pontuais. Informe nome, WhatsApp e cidade; o app cria/reusa
            um lead real e aciona o mesmo workflow do HubSpot usado nos disparos da Olivia.
          </p>
        </div>
      </div>

      <form className="search-row" onSubmit={handleSubmit}>
        <div className="field direct-company-field">
          <label className="eyebrow" htmlFor="manual-olivia-nome">Contato/negócio</label>
          <input
            id="manual-olivia-nome"
            placeholder="Ex.: Bia Doces"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="eyebrow" htmlFor="manual-olivia-whatsapp">WhatsApp</label>
          <input
            id="manual-olivia-whatsapp"
            inputMode="tel"
            placeholder="Ex.: 11 99999-8888"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="eyebrow" htmlFor="manual-olivia-cidade">Cidade</label>
          <input
            id="manual-olivia-cidade"
            placeholder="Ex.: São Paulo"
            value={cidade}
            onChange={(e) => setCidade(e.target.value)}
          />
        </div>

        <div className="field direct-company-field">
          <label className="eyebrow" htmlFor="manual-olivia-notas">Notas</label>
          <input
            id="manual-olivia-notas"
            placeholder="Opcional: origem/contexto"
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
          />
        </div>

        <button className="btn" type="submit" disabled={busy || !validation.ok}>
          {busy ? (
            <>
              <Loader2 size={15} className="spin" /> Enviando...
            </>
          ) : (
            <>
              <Send size={15} /> Criar e enviar
            </>
          )}
        </button>
      </form>

      {!validation.ok && (nome.trim() || whatsapp.trim()) && (
        <div className="search-status err" role="alert">
          <AlertCircle size={14} /> {validation.error}
        </div>
      )}

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

      {success && (
        <div className="search-status" role="status">
          <Check size={14} /> {success}
        </div>
      )}
    </div>
  )
}
