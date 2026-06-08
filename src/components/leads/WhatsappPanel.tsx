import { useState } from 'react'
import { MessageCircle, Loader2 } from 'lucide-react'
import type { Lead, WhatsappStatus } from '../../lib/types'
import { useEncontrarWhatsapp, useUpdateLead } from '../../lib/leads'

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
}

// E.164 "+5511999998888" → dígitos para o link wa.me.
const waDigits = (e164: string): string => e164.replace(/\D/g, '')

export function WhatsappPanel({ lead }: { lead: Lead }) {
  const find = useEncontrarWhatsapp()
  const update = useUpdateLead()
  const running = find.isPending
  const [manual, setManual] = useState('')

  const phone = lead.whatsapp_phone
  const status = lead.whatsapp_status ?? null

  function salvarManual() {
    const v = manual.trim()
    if (!v) return
    update.mutate({
      id: lead.id,
      patch: { whatsapp_phone: v, whatsapp_source: 'manual', whatsapp_status: 'found' },
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
        onClick={() => find.mutate({ leadId: lead.id, force: !!phone })}
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

      {!running && status === 'missing' && !phone && (
        <div className="field" style={{ marginTop: 12 }}>
          <label className="eyebrow" htmlFor="wa-manual">Informar manualmente</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="wa-manual"
              placeholder="+55 11 99999-8888"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') salvarManual()
              }}
            />
            <button className="btn ghost sm" onClick={salvarManual} disabled={update.isPending}>
              Salvar
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
