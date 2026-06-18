import { useState } from 'react'
import { Loader2, Video, AlertTriangle, PauseCircle, PlayCircle, RotateCcw, CalendarClock, UserX } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { OLIVIA_ESTADO_META } from '../../lib/types'
import { useOliviaConversa, useUpdateLead, useRemarcar } from '../../lib/leads'
import { fmtDateTime } from '../../lib/format'
import { safeHttpUrl } from '../../lib/url'
import { meetingSummary } from '../../lib/communicationStatus'
import { getOliviaTypingState } from '../../lib/oliviaTyping'

// Janela do TIME pra ver o que a Olivia está fazendo numa conversa: estado atual,
// se precisa de humano (handoff), se já marcou reunião (link do Meet) e o
// transcript completo (entrada do lead × saída da Olivia). Read-only.

export function OliviaConversaPanel({ lead }: { lead: Lead }) {
  const { data: mensagens = [], isLoading, isError, error } = useOliviaConversa(lead.id)
  const estado = lead.olivia_estado
  const meta = estado ? OLIVIA_ESTADO_META[estado] : null
  const meeting = meetingSummary(lead)
  const meetLink = safeHttpUrl(meeting.meetLink)
  const calendarLink = safeHttpUrl(meeting.calendarLink)
  const typingState = getOliviaTypingState(lead, mensagens)

  // Kill switch: o time pode desligar a Olivia desta conversa quando ela erra /
  // alucina, e reativá-la depois. Opt-out (LGPD) não oferece reativar — não se
  // re-engaja quem pediu pra parar.
  const updateLead = useUpdateLead()
  const pausada = estado === 'pausada'
  const podeControlar = estado !== 'optout'
  const pausar = () => updateLead.mutate({ id: lead.id, patch: { olivia_estado: 'pausada' } })
  const reativar = () => updateLead.mutate({ id: lead.id, patch: { olivia_estado: 'conversando' } })

  // Reschedule / no-show: cancela ou move o evento e a Olivia avisa o cliente.
  const remarcar = useRemarcar()
  const [novoHorario, setNovoHorario] = useState('')
  const definirHorario = () => {
    if (!novoHorario) return
    const iso = new Date(novoHorario).toISOString() // datetime-local (BRT) → ISO UTC
    remarcar.mutate({ leadId: lead.id, motivo: 'definir', novoSlotIso: iso }, { onSuccess: () => setNovoHorario('') })
  }

  return (
    <section>
      <span className="eyebrow">Conversa da Olivia</span>

      {/* Estado atual da máquina de conversa. */}
      <div className="enrich-row" style={{ marginTop: 4 }}>
        <span className="er-label">
          <span className="status-dot" data-status={meta?.dot ?? 'empty'} />
          Estado
        </span>
        <span className={`er-val${meta ? '' : ' dash'}`}>{meta?.label ?? 'Sem conversa ainda'}</span>
      </div>

      {/* Controle manual da Olivia (pausar/reativar) — fica fora do opt-out. */}
      {podeControlar && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          {pausada ? (
            <button className="btn sm" onClick={reativar} disabled={updateLead.isPending}>
              {updateLead.isPending ? <Loader2 size={13} className="spin" /> : <PlayCircle size={13} />}
              Reativar Olivia
            </button>
          ) : (
            <button className="btn ghost sm" onClick={pausar} disabled={updateLead.isPending}>
              {updateLead.isPending ? <Loader2 size={13} className="spin" /> : <PauseCircle size={13} />}
              Pausar Olivia
            </button>
          )}
          <span className="muted-line" style={{ fontSize: 12 }}>
            {pausada
              ? 'Olivia não responde automaticamente nesta conversa.'
              : 'Para a Olivia de responder sozinha (ex.: se estiver errando).'}
          </span>
        </div>
      )}

      {updateLead.isError && (
        <div className="search-status err" style={{ marginTop: 8 }}>
          Falha ao mudar o estado da Olivia: {(updateLead.error as Error).message}
        </div>
      )}

      {/* Olivia pausada manualmente: destaque reversível. */}
      {pausada && (
        <div className="callout" style={{ marginTop: 12 }}>
          <PauseCircle size={16} style={{ flex: 'none' }} />
          <span>
            <b>Olivia pausada.</b> O time desligou as respostas automáticas aqui. Clique em
            “Reativar Olivia” quando quiser que ela volte a responder.
          </span>
        </div>
      )}

      {/* Handoff: a Olivia escalou — o time precisa assumir. Destaque (não some). */}
      {estado === 'handoff' && (
        <div className="callout" style={{ marginTop: 12, borderLeftColor: 'var(--maky)' }}>
          <AlertTriangle size={16} style={{ color: 'var(--maky)', flex: 'none' }} />
          <span>
            <b>Olivia passou pra você.</b>{' '}
            {lead.olivia_handoff_motivo ?? 'Motivo não registrado — abra a conversa e responda.'}
          </span>
        </div>
      )}

      {/* Reunião marcada: horário + link do Google Meet. */}
      {lead.reuniao_at && (
        <div className="callout waz" style={{ marginTop: 12 }}>
          <Video size={16} style={{ color: 'var(--waz)', flex: 'none' }} />
          <span>
            <b>Reunião {fmtDateTime(lead.reuniao_at)}</b>
            {meeting.assignedEmployee && <> · {meeting.assignedEmployee}</>}
            {meeting.calendarTitle && <> · {meeting.calendarTitle}</>}
            {calendarLink && (
              <>
                {' · '}
                <a href={calendarLink} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                  ver no Calendar ↗
                </a>
              </>
            )}
            {meetLink && (
              <>
                {' · '}
                <a href={meetLink} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                  entrar no Meet ↗
                </a>
              </>
            )}
          </span>
        </div>
      )}

      {/* Remarcar / no-show: só quando há reunião marcada. Cancela ou move o
          evento no Calendar e a Olivia avisa o cliente. */}
      {lead.reuniao_at && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="btn ghost sm"
              onClick={() => remarcar.mutate({ leadId: lead.id, motivo: 'pedir' })}
              disabled={remarcar.isPending}
              title="Cancela o evento e a Olivia pede um novo horário ao cliente"
            >
              <RotateCcw size={13} /> Remarcar (pedir horário)
            </button>
            <button
              className="btn ghost sm"
              onClick={() => remarcar.mutate({ leadId: lead.id, motivo: 'noshow' })}
              disabled={remarcar.isPending}
              title="Cliente não compareceu — Olivia oferece remarcar"
            >
              <UserX size={13} /> Não compareceu
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="datetime-local"
              value={novoHorario}
              onChange={(e) => setNovoHorario(e.target.value)}
              aria-label="Novo horário da reunião"
              style={{ fontSize: 13 }}
            />
            <button className="btn sm" onClick={definirHorario} disabled={remarcar.isPending || !novoHorario}>
              {remarcar.isPending ? <Loader2 size={13} className="spin" /> : <CalendarClock size={13} />}
              Definir novo horário
            </button>
          </div>
          {remarcar.isError && (
            <div className="search-status err" style={{ marginTop: 8 }}>
              Falha ao remarcar: {(remarcar.error as Error).message}
            </div>
          )}
          {remarcar.isSuccess && remarcar.data && !remarcar.data.mensagem_enviada && (
            <div className="muted-line" style={{ fontSize: 12, marginTop: 6 }}>
              Agenda atualizada, mas a mensagem ao cliente não saiu
              {remarcar.data.erro_mensagem ? ` (${remarcar.data.erro_mensagem})` : ''} — provável janela de 24h
              do WhatsApp fechada (precisa de template).
            </div>
          )}
        </div>
      )}

      {/* Transcript. */}
      <div className="chat-thread" style={{ marginTop: 16 }}>
        {isLoading ? (
          <p className="muted-line"><Loader2 size={13} className="spin" /> Carregando conversa…</p>
        ) : isError ? (
          <div className="search-status err">Falha ao carregar a conversa: {(error as Error).message}</div>
        ) : mensagens.length === 0 ? (
          <p className="muted-line">Nenhuma mensagem ainda. Quando o lead responder ao disparo, a conversa aparece aqui.</p>
        ) : (
          <>
            {mensagens.map((m) => (
              <div key={m.id} className={`chat-msg ${m.direcao === 'out' ? 'out' : 'in'}`}>
                <div className="chat-bubble">
                  {m.corpo ?? <span className="muted-line">[{m.tipo ?? 'mídia'}]</span>}
                </div>
                <span className="chat-time">{m.direcao === 'out' ? 'Olivia' : lead.nome} · {fmtDateTime(m.enviada_em)}</span>
              </div>
            ))}
            {typingState && (
              <div className="chat-msg out typing" aria-live="polite">
                <div className="chat-bubble typing-bubble" aria-label={typingState.label}>
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
                <span className="chat-time">{typingState.label}</span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
