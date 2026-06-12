import { useState } from 'react'
import { MessageCircle, Loader2, Check, Send, X } from 'lucide-react'
import type { Lead, WhatsappStatus } from '../../lib/types'
import { useEncontrarWhatsapp, useSyncHubspot, useUpdateLead } from '../../lib/leads'
import { toE164Br } from '../../lib/phoneBr'

// Mapeia o status do WhatsApp para os data-status já estilizados (.status-dot):
// 'ok' | 'missing' | 'pending' | 'empty'. Não cria sistema de cor novo.
function dotStatus(s: WhatsappStatus | null, running: boolean): string {
  if (running) return 'pending'
  if (s === 'found') return 'ok'
  if (s === 'missing' || s === 'invalid') return 'missing'
  return 'empty'
}

const SOURCE_LABEL: Record<string, string> = {
  google: 'Google',
  instagram: 'Instagram',
  website: 'Site',
  manual: 'Manual',
  perplexity: 'Busca web',
}

// E.164 "+5511999998888" → dígitos para o link wa.me.
const waDigits = (e164: string): string => e164.replace(/\D/g, '')

export function WhatsappPanel({ lead }: { lead: Lead }) {
  const find = useEncontrarWhatsapp()
  const sync = useSyncHubspot()
  const update = useUpdateLead()
  const running = find.isPending
  const [manual, setManual] = useState('')
  const [manualErr, setManualErr] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)

  const phone = lead.whatsapp_phone
  const status = lead.whatsapp_status ?? null
  const syncedAt = lead.hubspot_synced_at ?? null
  // DISPARADO != SINCRONIZADO. hubspot_synced_at marca só que o contato existe no
  // HubSpot (pode ter sido um sync de CRM). whatsapp_sent_at só é gravado quando o
  // contato foi enfileirado para o workflow (sync trigger=true). "Reenviar" depende
  // desse gatilho, não da mera sincronização.
  const disparado = lead.whatsapp_sent_at ?? null
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

      <div className="enrich-row">
        <span className="er-label">
          <span className="status-dot" data-status={dotStatus(status, running)} />
          Número
        </span>
        <span className={`er-val${phone ? '' : ' dash'}`}>
          {phone ? (
            <a href={`https://wa.me/${waDigits(phone)}`} target="_blank" rel="noreferrer">
              {phone}
            </a>
          ) : (
            '—'
          )}
          {phone && lead.whatsapp_source && (
            <span className="badge">{SOURCE_LABEL[lead.whatsapp_source] ?? lead.whatsapp_source}</span>
          )}
        </span>
      </div>

      <button
        className="btn"
        style={{ marginTop: 16 }}
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
      >
        {running ? (
          <>
            <Loader2 size={15} className="spin" /> Procurando…
          </>
        ) : (
          <>
            <MessageCircle size={15} /> {phone ? 'Procurar de novo' : 'Encontrar número'}
          </>
        )}
      </button>

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
      {phone && status === 'found' && (
        <div style={{ marginTop: 14 }}>
          {!confirmSend && (
            <button
              className="btn"
              onClick={() => setConfirmSend(true)}
              disabled={sync.isPending}
              title="Sincroniza o contato no HubSpot e aciona o workflow do template."
            >
              <MessageCircle size={15} /> {disparado ? 'Reenviar WhatsApp (HubSpot)' : 'Enviar WhatsApp (HubSpot)'}
            </button>
          )}

          {confirmSend && (
            <div className="conferir-actions">
              <span className="er-val" style={{ marginRight: 8 }}>
                Enviar template <b>{templateVariant}</b> para {phone}? O HubSpot vai disparar pelo workflow.
              </span>
              <button
                className="btn sm"
                onClick={() => sync.mutate(
                  { leadId: lead.id, trigger: true },
                  { onSettled: () => setConfirmSend(false) },
                )}
                disabled={sync.isPending}
              >
                {sync.isPending ? <><Loader2 size={14} className="spin" /> Acionando…</> : <><Send size={14} /> Confirmar envio</>}
              </button>
              <button className="btn ghost sm" onClick={() => setConfirmSend(false)} disabled={sync.isPending}>
                <X size={14} /> Cancelar
              </button>
            </div>
          )}

          {syncedAt && !sync.isPending && (
            <div className="enrich-row" style={{ marginTop: 10 }}>
              <span className="er-label">
                <span className="status-dot" data-status={disparado ? 'ok' : 'pending'} />
                HubSpot
              </span>
              <span className="er-val">
                {/* Só promete o disparo se ele foi de fato iniciado (anti-invenção). */}
                {disparado ? (
                  <span className="badge"><Check size={11} /> pronto p/ WhatsApp · workflow acionado</span>
                ) : (
                  <span className="badge">contato no HubSpot (CRM) · WhatsApp não disparado</span>
                )}
                {lead.hubspot_contact_id && (<a href={`https://app.hubspot.com/contacts/50173893/record/0-1/${lead.hubspot_contact_id}`} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>Abrir no HubSpot ↗</a>)}
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

      {!running && status === 'missing' && !phone && (
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
