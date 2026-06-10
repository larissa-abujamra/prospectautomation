import { useMemo, useState } from 'react'
import { AlertTriangle, Video, MessageSquare, ArrowUpRight, Loader2 } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { useLeads } from '../../lib/leads'
import { fmtDateTime } from '../../lib/format'
import { safeHttpUrl } from '../../lib/url'

// Cockpit da Olivia: a visão do TIME sobre a agente. Três perguntas:
//   1. Quem precisa de mim agora?  (handoff)
//   2. Que reuniões estão marcadas? (reuniao_at)
//   3. Com quem ela está falando?   (conversando/agendando/aguardando)
// Tudo derivado de useLeads (campos do próprio lead) — sem query nova.

const EM_CONVERSA = new Set(['aguardando', 'conversando', 'agendando'])

function Linha({ lead, onOpen, children }: { lead: Lead; onOpen: (id: string) => void; children: React.ReactNode }) {
  return (
    <button type="button" className="cockpit-row" onClick={() => onOpen(lead.id)}>
      <span className="cockpit-row-main">
        <span className="cockpit-row-nome">{lead.nome}</span>
        {children}
      </span>
      <ArrowUpRight size={15} className="cockpit-row-go" />
    </button>
  )
}

export function OliviaCockpit({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const { data: leads = [], isLoading, isError, error } = useLeads()

  // "Agora" lido UMA vez no mount via inicializador lazy do useState (fora do
  // render — Date.now é impuro e não pode no corpo do componente/useMemo). Fixar
  // no mount basta: a ficha é reaberta a cada navegação.
  const [agora] = useState(() => Date.now())

  const { handoffs, reunioes, emConversa } = useMemo(() => {
    const handoffs = leads.filter((l) => l.olivia_estado === 'handoff')
    const reunioes = leads
      .filter((l) => l.reuniao_at && Date.parse(l.reuniao_at) >= agora)
      .sort((a, b) => Date.parse(a.reuniao_at!) - Date.parse(b.reuniao_at!))
    const emConversa = leads.filter((l) => l.olivia_estado && EM_CONVERSA.has(l.olivia_estado))
    return { handoffs, reunioes, emConversa }
  }, [leads, agora])

  if (isLoading) return <div className="search-status"><Loader2 size={15} className="spin" /> Carregando…</div>
  if (isError) return <div className="search-status err">Falha ao carregar: {(error as Error).message}</div>

  return (
    <div className="cockpit">
      {/* Resumo numérico rápido. */}
      <div className="oli-resumo">
        <div className="oli-resumo-card"><span className="eyebrow">Precisa de você</span><b>{handoffs.length}</b></div>
        <div className="oli-resumo-card"><span className="eyebrow">Reuniões</span><b>{reunioes.length}</b></div>
        <div className="oli-resumo-card"><span className="eyebrow">Em conversa</span><b>{emConversa.length}</b></div>
      </div>

      {/* 1. Handoff — o mais urgente. */}
      <section className="cockpit-sec">
        <div className="eyebrow cockpit-sec-h">
          <AlertTriangle size={13} style={{ color: 'var(--maky)' }} /> Precisa de você
        </div>
        {handoffs.length === 0 ? (
          <p className="muted-line">Nada pendente — a Olivia está dando conta. ✓</p>
        ) : (
          <div className="cockpit-list">
            {handoffs.map((l) => (
              <Linha key={l.id} lead={l} onOpen={onOpenLead}>
                <span className="cockpit-row-sub">{l.olivia_handoff_motivo ?? 'Escalou pra um humano — abra e responda.'}</span>
              </Linha>
            ))}
          </div>
        )}
      </section>

      {/* 2. Reuniões marcadas. */}
      <section className="cockpit-sec">
        <div className="eyebrow cockpit-sec-h">
          <Video size={13} style={{ color: 'var(--waz)' }} /> Próximas reuniões
        </div>
        {reunioes.length === 0 ? (
          <p className="muted-line">Nenhuma reunião marcada ainda.</p>
        ) : (
          <div className="cockpit-list">
            {reunioes.map((l) => {
              const meet = safeHttpUrl(l.reuniao_link)
              return (
                <Linha key={l.id} lead={l} onOpen={onOpenLead}>
                  <span className="cockpit-row-sub">
                    {fmtDateTime(l.reuniao_at)}
                    {meet && (
                      <>
                        {' · '}
                        <a href={meet} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'underline' }}>
                          Meet ↗
                        </a>
                      </>
                    )}
                  </span>
                </Linha>
              )
            })}
          </div>
        )}
      </section>

      {/* 3. Conversas em andamento. */}
      <section className="cockpit-sec">
        <div className="eyebrow cockpit-sec-h">
          <MessageSquare size={13} style={{ color: 'var(--fin)' }} /> Em conversa
        </div>
        {emConversa.length === 0 ? (
          <p className="muted-line">Nenhuma conversa ativa no momento.</p>
        ) : (
          <div className="cockpit-list">
            {emConversa.map((l) => (
              <Linha key={l.id} lead={l} onOpen={onOpenLead}>
                <span className="badge">{l.olivia_estado}</span>
              </Linha>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
