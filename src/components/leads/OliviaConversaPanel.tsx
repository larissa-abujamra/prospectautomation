import { Loader2, Video, AlertTriangle } from 'lucide-react'
import type { Lead, OliviaEstado } from '../../lib/types'
import { useOliviaConversa } from '../../lib/leads'
import { fmtDateTime } from '../../lib/format'

// Janela do TIME pra ver o que a Olivia está fazendo numa conversa: estado atual,
// se precisa de humano (handoff), se já marcou reunião (link do Meet) e o
// transcript completo (entrada do lead × saída da Olivia). Read-only.

// Rótulo + tom (status-dot) de cada estado da conversa. Espelha o enum do backend.
const ESTADO_META: Record<OliviaEstado, { label: string; dot: 'empty' | 'pending' | 'ok' | 'missing' }> = {
  aguardando: { label: 'Aguardando resposta', dot: 'empty' },
  conversando: { label: 'Conversando', dot: 'pending' },
  agendando: { label: 'Agendando reunião', dot: 'pending' },
  agendado: { label: 'Reunião agendada', dot: 'ok' },
  handoff: { label: 'Precisa de você', dot: 'missing' },
  optout: { label: 'Opt-out — não contatar', dot: 'missing' },
}

export function OliviaConversaPanel({ lead }: { lead: Lead }) {
  const { data: mensagens = [], isLoading, isError, error } = useOliviaConversa(lead.id)
  const estado = lead.olivia_estado
  const meta = estado ? ESTADO_META[estado] : null

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
            {lead.reuniao_link && (
              <>
                {' · '}
                <a href={lead.reuniao_link} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                  entrar no Meet ↗
                </a>
              </>
            )}
          </span>
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
          mensagens.map((m) => (
            <div key={m.id} className={`chat-msg ${m.direcao === 'out' ? 'out' : 'in'}`}>
              <div className="chat-bubble">
                {m.corpo ?? <span className="muted-line">[{m.tipo ?? 'mídia'}]</span>}
              </div>
              <span className="chat-time">{m.direcao === 'out' ? 'Olivia' : lead.nome} · {fmtDateTime(m.enviada_em)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
