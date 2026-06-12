import { useState } from 'react'
import { AlertCircle, ExternalLink, MessageCircle, Loader2, Check, Send, X } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { fmtDateTime } from '../../lib/format'
import { useEncontrarWhatsapp, useSyncHubspot, useUpdateLead } from '../../lib/leads'
import { toE164Br } from '../../lib/phoneBr'
import {
  canTriggerWhatsappWorkflow,
  hubspotContactUrl,
  messageWorkflowSummary,
  preferredWhatsappNumber,
  whatsappDiscoverySummary,
  whatsappUrl,
} from '../../lib/communicationStatus'

export function WhatsappPanel({ lead }: { lead: Lead }) {
  const find = useEncontrarWhatsapp()
  const sync = useSyncHubspot()
  const update = useUpdateLead()
  const running = find.isPending
  const [manual, setManual] = useState('')
  const [manualErr, setManualErr] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)

  const phone = preferredWhatsappNumber(lead)
  const waLink = whatsappUrl(phone)
  const status = lead.whatsapp_status ?? null
  const syncedAt = lead.hubspot_synced_at ?? null
  // DISPARADO != SINCRONIZADO. hubspot_synced_at marca só que o contato existe no
  // HubSpot (pode ter sido um sync de CRM). whatsapp_sent_at só é gravado quando o
  // contato foi enfileirado para o workflow (sync trigger=true). "Reenviar" depende
  // desse gatilho, não da mera sincronização.
  const disparado = lead.whatsapp_sent_at ?? null
  const discovery = whatsappDiscoverySummary(lead, running)
  const workflow = messageWorkflowSummary(lead, sync.isPending)
  const contactUrl = hubspotContactUrl(lead.hubspot_contact_id)
  const canTriggerWorkflow = canTriggerWhatsappWorkflow(lead)
  // 'm' → masculino; qualquer outro → feminino (default). Espelha o backend.
  const templateVariant = lead.nome_genero === 'm' ? 'masculino (o)' : 'feminino (a)'

  function salvarManual() {
    const v = manual.trim()
    if (!v) return
    // Valida + normaliza para E.164 antes de gravar. Sem isto, qualquer string
    // virava whatsapp_phone com status 'found', um número "válido" inventado
    // (anti-invenção) que só falharia na hora do envio.
    const e164 = toE164Br(v)
    if (!e164) {
      setManualErr('Número inválido. Use DDD + número (ex.: 11 99999-8888).')
      return
    }
    setManualErr('')
    update.mutate({
      id: lead.id,
      patch: { whatsapp_phone: e164, whatsapp_source: 'manual', whatsapp_status: 'found' },
    })
    setManual('')
  }

  return (
    <section>
      <span className="eyebrow">WhatsApp</span>

      <div className="status-card">
        <div className="status-card-head">
          <span className="status-title">
            <span className="status-dot" data-status={discovery.dot} />
            Descoberta do número
          </span>
          <span className="badge">{discovery.label}</span>
        </div>
        <p className="status-detail">{discovery.detail}</p>
        <div className="status-next">
          <AlertCircle size={13} /> Próximo: {discovery.nextAction}
        </div>
      </div>

      <div className="enrich-row">
        <span className="er-label">
          <span className="status-dot" data-status={discovery.dot} />
          Número usado
        </span>
        <span className={`er-val${phone ? '' : ' dash'}`}>
          {phone ? (
            <a href={waLink ?? undefined} target="_blank" rel="noreferrer">
              {phone}
            </a>
          ) : (
            '—'
          )}
          {phone && discovery.sourceLabel && (
            <span className="badge">{discovery.sourceLabel}</span>
          )}
        </span>
      </div>

      {lead.whatsapp_dono?.trim() && lead.whatsapp_phone && lead.whatsapp_dono.trim() !== lead.whatsapp_phone && (
        <p className="muted-line" style={{ marginTop: 8 }}>
          O disparo usa o WhatsApp manual da dona(o). Número descoberto da loja: {lead.whatsapp_phone}.
        </p>
      )}

      <div className="panel-actions">
        <button
          className="btn"
          // force quando já há resultado (número OU verificação 'missing'/'invalid'):
          // o clique manual é o pedido deliberado de re-verificar — sem force, a
          // function pula quem já foi verificado (trava de custo dos lotes).
          onClick={() =>
            find.mutate({
              leadId: lead.id,
              force: !!phone || status === 'missing' || status === 'invalid',
            })
          }
          disabled={running}
          title={discovery.nextAction}
        >
          {running ? (
            <>
              <Loader2 size={15} className="spin" /> Procurando…
            </>
          ) : (
            <>
              <MessageCircle size={15} /> {phone ? 'Procurar outro número' : 'Encontrar número'}
            </>
          )}
        </button>

        {waLink && (
          <a className="btn ghost" href={waLink} target="_blank" rel="noreferrer">
            Abrir wa.me <ExternalLink size={13} />
          </a>
        )}
      </div>

      {find.isError && (
        <div className="search-status err" style={{ marginTop: 10 }}>
          {(find.error as Error).message}
        </div>
      )}

      {/* Envio 100% via HubSpot: o sync (trigger=true) marca whatsapp_outreach=
          'ready' no contato; os workflows "Squad Prospeccao WhatsApp F/M" inscrevem
          (ready + gênero) e disparam squad_prospeccao_intro_f/_m. Ao enviar, marcam
          'sent' e outro workflow move o negócio pra Tentativa de Contato. Ação de
          saída real -> confirma antes. */}
      <div className="status-card">
        <div className="status-card-head">
          <span className="status-title">
            <span className="status-dot" data-status={workflow.dot} />
            Mensagem
          </span>
          <span className="badge">{workflow.label}</span>
        </div>
        <p className="status-detail">{workflow.detail}</p>
        {disparado && (
          <p className="status-detail">Workflow acionado em {fmtDateTime(disparado)}.</p>
        )}
        {lead.whatsapp_msg_id && (
          <p className="status-detail">ID da mensagem: {lead.whatsapp_msg_id}</p>
        )}
        <div className="status-next">
          <AlertCircle size={13} /> Próximo: {workflow.nextAction}
        </div>
      </div>

      {canTriggerWorkflow && (
        <div style={{ marginTop: 14 }}>
          {!confirmSend && (
            <button
              className="btn"
              onClick={() => setConfirmSend(true)}
              disabled={sync.isPending}
              title="Cria/atualiza o contato no HubSpot e aciona o workflow do template."
            >
              <MessageCircle size={15} /> {disparado ? 'Reacionar workflow WhatsApp' : 'Acionar workflow WhatsApp'}
            </button>
          )}

          {confirmSend && (
            <div className="conferir-actions">
              <span className="er-val" style={{ marginRight: 8 }}>
                Acionar template <b>{templateVariant}</b> para {phone}? O HubSpot fará o envio pelo workflow.
              </span>
              <button
                className="btn sm"
                onClick={() => sync.mutate(
                  { leadId: lead.id, trigger: true },
                  { onSettled: () => setConfirmSend(false) },
                )}
                disabled={sync.isPending}
              >
                {sync.isPending ? <><Loader2 size={14} className="spin" /> Acionando…</> : <><Send size={14} /> Confirmar acionamento</>}
              </button>
              <button className="btn ghost sm" onClick={() => setConfirmSend(false)} disabled={sync.isPending}>
                <X size={14} /> Cancelar
              </button>
            </div>
          )}

          {(syncedAt || contactUrl) && !sync.isPending && (
            <div className="enrich-row" style={{ marginTop: 10 }}>
              <span className="er-label">
                <span className="status-dot" data-status={disparado ? 'ok' : 'pending'} />
                HubSpot
              </span>
              <span className="er-val">
                {/* Só promete o disparo se ele foi de fato iniciado (anti-invenção). */}
                {disparado ? (
                  <span className="badge"><Check size={11} /> workflow acionado</span>
                ) : (
                  <span className="badge">contato no HubSpot · WhatsApp não acionado</span>
                )}
                {contactUrl && (
                  <a href={contactUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                    Abrir contato <ExternalLink size={12} />
                  </a>
                )}
              </span>
            </div>
          )}

          {sync.isError && (
            <div className="search-status err" style={{ marginTop: 10 }}>
              {(sync.error as Error).message}
            </div>
          )}
        </div>
      )}

      {!running && !phone && (status === 'missing' || status === 'invalid' || status === 'found') && (
        <div className="field" style={{ marginTop: 12 }}>
          <label className="eyebrow" htmlFor="wa-manual">Informar manualmente</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="wa-manual"
              placeholder="+55 11 99999-8888"
              value={manual}
              onChange={(e) => { setManual(e.target.value); if (manualErr) setManualErr('') }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') salvarManual()
              }}
            />
            <button className="btn ghost sm" onClick={salvarManual} disabled={update.isPending}>
              Salvar
            </button>
          </div>
          {manualErr && (
            <div className="search-status err" style={{ marginTop: 8 }}>{manualErr}</div>
          )}
        </div>
      )}
    </section>
  )
}
