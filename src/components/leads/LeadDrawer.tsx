import { useEffect, useRef, useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { LEAD_STATUSES, STATUS_META } from '../../lib/types'
import { faixaFaturamento, fmtDate, fmtInt, fmtRating, fmtText } from '../../lib/format'
import { useUpdateLead } from '../../lib/leads'
import { toE164Br } from '../../lib/phoneBr'
import { EnrichPanel } from './EnrichPanel'
import { WhatsappPanel } from './WhatsappPanel'
import { OliviaConversaPanel } from './OliviaConversaPanel'
import { HubspotPanel } from './HubspotPanel'

function Row({ k, v }: { k: string; v: string | null }) {
  const empty = v == null || v === '' || v === '—'
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v${empty ? ' dash' : ''}`}>{empty ? '—' : v}</span>
    </div>
  )
}

// Abas da ficha (re-layout Fase 2).
type DrawerTab = 'dados' | 'whatsapp' | 'conversa' | 'hubspot' | 'oculto'

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'dados', label: 'Dados' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'conversa', label: 'Conversa' },
  { id: 'hubspot', label: 'HubSpot' },
  { id: 'oculto', label: 'C. Oculto' },
]

// O componente é montado com key={lead.id} pelo pai — então o estado local
// (notas, aba, campos manuais) já nasce correto a cada lead, sem efeito de reset.
export function LeadDrawer({
  lead,
  onClose,
  initialTab = 'dados',
}: {
  lead: Lead
  onClose: () => void
  initialTab?: DrawerTab
}) {
  const update = useUpdateLead()
  const [tab, setTab] = useState<DrawerTab>(initialTab)
  const [notas, setNotas] = useState(lead.notas ?? '')
  const [hint, setHint] = useState('')
  const dirty = useRef(false)
  // WhatsApp da dona(o) — entrada manual (LGPD: sem data broker).
  const [waDono, setWaDono] = useState('')
  const [waDonoErr, setWaDonoErr] = useState('')
  // Cliente oculto — notas digitadas antes de marcar a visita. Vivem aqui no
  // pai para sobreviver à troca de abas sem perder o texto.
  const [ocultoNotas, setOcultoNotas] = useState(lead.cliente_oculto_notas ?? '')

  // Autosave das notas com debounce (~1s).
  useEffect(() => {
    if (!dirty.current) return
    setHint('Salvando…')
    const t = setTimeout(() => {
      update.mutate(
        { id: lead.id, patch: { notas: notas.trim() === '' ? null : notas } },
        { onSuccess: () => setHint('Salvo') },
      )
    }, 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notas])

  // Fecha com Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[aria-modal="true"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Salva o WhatsApp da dona(o). Valida + normaliza para E.164 antes de gravar
  // (anti-invenção: string que não é telefone BR não vira "número válido").
  function salvarWaDono() {
    const v = waDono.trim()
    if (!v) return
    const e164 = toE164Br(v)
    if (!e164) {
      setWaDonoErr('Número inválido. Use DDD + número (ex.: 11 99999-8888).')
      return
    }
    setWaDonoErr('')
    update.mutate(
      { id: lead.id, patch: { whatsapp_dono: e164 } },
      { onSuccess: () => setWaDono('') },
    )
  }

  // Marca a visita de cliente oculto. O timestamp é gerado AQUI, no momento
  // real do clique — nada de data placeholder.
  function marcarVisita() {
    update.mutate({
      id: lead.id,
      patch: {
        cliente_oculto_at: new Date().toISOString(),
        cliente_oculto_notas: ocultoNotas.trim() === '' ? null : ocultoNotas.trim(),
      },
    })
  }

  return (
    // Painel fixo à direita, SEM overlay (re-layout Fase 2): a tabela e a
    // Bandeja continuam interativas ao lado. Fecha só pelo X ou Esc.
    <aside className="drawer" aria-label={`Ficha de ${lead.nome}`}>
      <div className="drawer-head">
        <div>
          <h2>{lead.nome}</h2>
          <div className="drawer-sub">{fmtText(lead.endereco)}</div>
        </div>
        <button className="icon-btn" onClick={onClose} title="Fechar">
          <X size={18} />
        </button>
      </div>

      <div className="drawer-tabs" role="tablist" aria-label="Seções da ficha">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`dtab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {/* Olivia escalou: pinta um ponto na aba Conversa pro time não passar batido. */}
            {t.id === 'conversa' && lead.olivia_estado === 'handoff' && (
              <span className="status-dot" data-status="missing" style={{ marginLeft: 6, background: 'var(--maky)' }} title="Olivia precisa de você" />
            )}
          </button>
        ))}
      </div>

      <div className="drawer-body">
        {tab === 'dados' && (
          <>
            <section>
              <span className="eyebrow">Pipeline</span>
              <div className="field">
                <label className="eyebrow" htmlFor="status">Status</label>
                <select
                  id="status"
                  value={lead.status}
                  onChange={(e) =>
                    update.mutate({ id: lead.id, patch: { status: e.target.value as Lead['status'] } })
                  }
                >
                  {LEAD_STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS_META[s].label}</option>
                  ))}
                </select>
              </div>
            </section>

            <section>
              <span className="eyebrow">Contato &amp; Google</span>
              <Row k="Bairro" v={lead.bairro} />
              <Row k="Cidade" v={lead.cidade} />
              <Row k="Telefone" v={lead.telefone} />
              <Row k="Website" v={lead.website} />
              <Row k="Nota" v={lead.rating == null ? null : fmtRating(lead.rating)} />
              <Row k="Avaliações" v={lead.reviews_count == null ? null : fmtInt(lead.reviews_count)} />

              {(lead.porte || lead.mei != null ||
                (lead.horario_funcionamento && lead.horario_funcionamento.length > 0)) && (
                <details className="more-details">
                  <summary className="eyebrow">Mais detalhes</summary>
                  <div className="more-body">
                    <span className="eyebrow" style={{ display: 'block', marginBottom: 8 }}>
                      Faixa de faturamento (estimada por porte)
                    </span>
                    <span className="badge">{faixaFaturamento(lead.porte, lead.mei)}</span>

                    {lead.horario_funcionamento && lead.horario_funcionamento.length > 0 && (
                      <>
                        <span className="eyebrow" style={{ display: 'block', margin: '16px 0 8px' }}>
                          Horário de atendimento
                        </span>
                        <ul className="horario-list">
                          {lead.horario_funcionamento.map((dia, i) => (
                            <li key={i}>{dia}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </details>
              )}
            </section>

            <section>
              <span className="eyebrow">Instagram</span>
              <Row k="Handle" v={lead.instagram_handle ? `@${lead.instagram_handle}` : null} />
              <Row
                k="Seguidores"
                v={lead.instagram_followers == null ? null : fmtInt(lead.instagram_followers)}
              />
            </section>

            <EnrichPanel lead={lead} />

            <section>
              <span className="eyebrow">Notas</span>
              <textarea
                value={notas}
                placeholder="Anotações sobre este lead…"
                onChange={(e) => {
                  dirty.current = true
                  setNotas(e.target.value)
                }}
              />
              <div className="autosave-hint">{hint}</div>
            </section>
          </>
        )}

        {tab === 'whatsapp' && (
          <>
            <WhatsappPanel lead={lead} />

            <section>
              <span className="eyebrow">WhatsApp da dona(o)</span>
              <Row k="Número salvo" v={lead.whatsapp_dono} />
              <div className="field" style={{ marginTop: 12 }}>
                <label className="eyebrow" htmlFor="wa-dono">Informar número</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="wa-dono"
                    placeholder="+55 11 99999-8888"
                    value={waDono}
                    onChange={(e) => {
                      setWaDono(e.target.value)
                      if (waDonoErr) setWaDonoErr('')
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') salvarWaDono()
                    }}
                  />
                  <button className="btn ghost sm" onClick={salvarWaDono} disabled={update.isPending}>
                    Salvar
                  </button>
                </div>
                {waDonoErr && (
                  <div className="search-status err" style={{ marginTop: 8 }}>{waDonoErr}</div>
                )}
              </div>
              <p className="muted-line" style={{ marginTop: 10 }}>
                Preenchido manualmente pelo time (resposta, visita, cliente oculto).
                Quando presente, o disparo prefere este número ao da loja.
              </p>
            </section>
          </>
        )}

        {tab === 'conversa' && <OliviaConversaPanel lead={lead} />}

        {tab === 'hubspot' && <HubspotPanel lead={lead} />}

        {tab === 'oculto' && (
          <section>
            <span className="eyebrow">Cliente oculto</span>
            {lead.cliente_oculto_at ? (
              <>
                <Row k="Visita feita em" v={fmtDate(lead.cliente_oculto_at)} />
                <span className="eyebrow" style={{ display: 'block', margin: '16px 0 8px' }}>
                  Notas da visita
                </span>
                <p
                  className="muted-line"
                  style={{ whiteSpace: 'pre-wrap', color: lead.cliente_oculto_notas ? undefined : 'var(--ink-3)' }}
                >
                  {lead.cliente_oculto_notas ?? '—'}
                </p>
              </>
            ) : (
              <>
                <p className="muted-line" style={{ marginBottom: 12 }}>
                  Nenhuma visita registrada ainda.
                </p>
                <textarea
                  value={ocultoNotas}
                  placeholder="Notas da visita (atendimento, produto, movimento…)"
                  onChange={(e) => setOcultoNotas(e.target.value)}
                />
                <button
                  className="btn"
                  style={{ marginTop: 12 }}
                  onClick={marcarVisita}
                  disabled={update.isPending}
                >
                  Marcar visita feita
                </button>
              </>
            )}
          </section>
        )}
      </div>

      {/* Rodapé fixo: UMA ação primária + descarte (re-layout Fase 2). */}
      <div className="drawer-foot">
        <button
          className="btn"
          disabled={update.isPending || lead.status === 'em_rota'}
          title={lead.status === 'em_rota' ? 'Já está em rota.' : undefined}
          onClick={() =>
            update.mutate({ id: lead.id, patch: { status: 'em_rota' } }, { onSuccess: onClose })
          }
        >
          Mandar pra rota <ArrowRight size={15} />
        </button>
        <button
          className="btn ghost"
          disabled={update.isPending || lead.status === 'descartado'}
          title={lead.status === 'descartado' ? 'Já está descartado.' : undefined}
          onClick={() =>
            update.mutate({ id: lead.id, patch: { status: 'descartado' } }, { onSuccess: onClose })
          }
        >
          Descartar
        </button>
      </div>
    </aside>
  )
}
