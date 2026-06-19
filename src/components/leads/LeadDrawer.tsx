import { useEffect, useRef, useState } from 'react'
import { ArrowRight, CalendarPlus, Loader2, X } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { LEAD_STATUSES, STATUS_META } from '../../lib/types'
import { fmtDate, fmtDateTime, fmtInt, fmtText } from '../../lib/format'
import { useUpdateLead, useMarcarReuniao } from '../../lib/leads'
import { toE164Br } from '../../lib/phoneBr'
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
export type DrawerTab = 'briefing' | 'whatsapp' | 'conversa' | 'hubspot' | 'oculto'

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'briefing', label: 'Briefing' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'conversa', label: 'Conversa' },
  { id: 'hubspot', label: 'HubSpot' },
  { id: 'oculto', label: 'C. Oculto' },
]

// Resumo curto do negócio pro briefing — só o que se sabe (anti-invenção).
function resumoBriefing(lead: Lead): string {
  const local = [lead.bairro?.trim(), lead.cidade?.trim()].filter(Boolean).join(', ')
  let frase = lead.nome
  if (lead.setor?.trim()) frase += ` — ${lead.setor.trim()}`
  if (local) frase += ` em ${local}`
  frase += '.'
  const partes = [frase]
  if (lead.dono_nome?.trim()) partes.push(`Contato: ${lead.dono_nome.trim()}.`)
  if (lead.instagram_followers != null)
    partes.push(`${fmtInt(lead.instagram_followers)} seguidores no Instagram.`)
  return partes.join(' ')
}

// ISO (UTC) → valor de <input datetime-local> no fuso do navegador (YYYY-MM-DDTHH:mm).
function isoParaInputLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// Marcar reunião manualmente: grava no lead (vai pra coluna "Reunião agendada")
// e reflete no HubSpot. Pra quando o time agendou por fora (criou o Meet à mão).
function MarcarReuniaoForm({ lead }: { lead: Lead }) {
  const marcar = useMarcarReuniao()
  const [aberto, setAberto] = useState(false)
  const [quando, setQuando] = useState(() => isoParaInputLocal(lead.reuniao_at))
  const [link, setLink] = useState(lead.reuniao_link ?? '')
  const [prospectEmail, setProspectEmail] = useState(lead.prospect_email ?? '')
  const [repEmail, setRepEmail] = useState(lead.olivia_assigned_rep_email ?? '')
  const [repNome, setRepNome] = useState(lead.olivia_assigned_rep_nome ?? '')

  if (!aberto) {
    return (
      <div style={{ marginTop: 18 }}>
        <button className="btn ghost sm" onClick={() => setAberto(true)}>
          <CalendarPlus size={14} /> {lead.reuniao_at ? 'Atualizar reunião' : 'Marcar reunião'}
        </button>
      </div>
    )
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!quando || marcar.isPending) return
    marcar.mutate(
      {
        leadId: lead.id,
        reuniaoAt: new Date(quando).toISOString(),
        reuniaoLink: link.trim() || undefined,
        prospectEmail: prospectEmail.trim() || undefined,
        repEmail: repEmail.trim() || undefined,
        repNome: repNome.trim() || undefined,
      },
      { onSuccess: () => setAberto(false) },
    )
  }

  return (
    <form onSubmit={submit} className="marcar-reuniao-form" style={{ marginTop: 18 }}>
      <span className="eyebrow">Marcar reunião</span>
      <div className="field">
        <label className="eyebrow" htmlFor="mr-quando">Data e hora</label>
        <input id="mr-quando" type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
      </div>
      <div className="field">
        <label className="eyebrow" htmlFor="mr-link">Link do Meet</label>
        <input id="mr-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://meet.google.com/…" />
      </div>
      <div className="field">
        <label className="eyebrow" htmlFor="mr-prospect">Email do cliente</label>
        <input id="mr-prospect" type="email" value={prospectEmail} onChange={(e) => setProspectEmail(e.target.value)} placeholder="cliente@empresa.com" />
      </div>
      <div className="field">
        <label className="eyebrow" htmlFor="mr-rep-email">Email do responsável (Inner)</label>
        <input id="mr-rep-email" type="email" value={repEmail} onChange={(e) => setRepEmail(e.target.value)} placeholder="vendedor@innerai.com" />
      </div>
      <div className="field">
        <label className="eyebrow" htmlFor="mr-rep-nome">Nome do responsável</label>
        <input id="mr-rep-nome" value={repNome} onChange={(e) => setRepNome(e.target.value)} placeholder="Opcional" />
      </div>
      {marcar.isError && <div className="search-status err">{(marcar.error as Error).message}</div>}
      <div className="modal-actions" style={{ marginTop: 2 }}>
        <button type="button" className="btn ghost sm" onClick={() => setAberto(false)} disabled={marcar.isPending}>
          Cancelar
        </button>
        <button type="submit" className="btn sm" disabled={!quando || marcar.isPending}>
          {marcar.isPending ? (<><Loader2 size={14} className="spin" /> Salvando…</>) : 'Marcar reunião'}
        </button>
      </div>
    </form>
  )
}

// O componente é montado com key={lead.id} pelo pai — então o estado local
// (notas, aba, campos manuais) já nasce correto a cada lead, sem efeito de reset.
export function LeadDrawer({
  lead,
  onClose,
  initialTab = 'briefing',
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

  // "Descartar" depende do contexto: lead NO funil da Olivia (olivia_estado
  // setado) → move pra Opt-out (não some, fica recuperável na coluna). Fora do
  // funil → status 'descartado' (comportamento da Base). Nunca deleta de fato.
  const naOlivia = lead.olivia_estado != null
  const jaDescartado = naOlivia ? lead.olivia_estado === 'optout' : lead.status === 'descartado'
  const descartarPatch: Partial<Lead> = naOlivia ? { olivia_estado: 'optout' } : { status: 'descartado' }

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
        {tab === 'briefing' && (
          <section className="briefing-panel">
            <span className="eyebrow">Briefing</span>
            <p className="briefing-resumo">{resumoBriefing(lead)}</p>

            <div className="field" style={{ marginBottom: 14 }}>
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

            <Row k="Pessoa na call" v={lead.dono_nome?.trim() || null} />
            <Row k="Setor" v={lead.setor?.trim() || null} />
            <Row k="Local" v={[lead.bairro?.trim(), lead.cidade?.trim()].filter(Boolean).join(' · ') || null} />
            <div className="kv">
              <span className="k">Instagram</span>
              <span className={`v${lead.instagram_handle ? '' : ' dash'}`}>
                {lead.instagram_handle ? (
                  <a
                    className="ig-link"
                    href={`https://instagram.com/${lead.instagram_handle.replace(/^@/, '')}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    @{lead.instagram_handle.replace(/^@/, '')}
                  </a>
                ) : (
                  '—'
                )}
              </span>
            </div>
            <Row k="Seguidores" v={lead.instagram_followers == null ? null : fmtInt(lead.instagram_followers)} />
            <Row k="WhatsApp" v={lead.whatsapp_dono?.trim() || lead.whatsapp_phone || null} />
            <div className="kv">
              <span className="k">Website</span>
              <span className={`v${lead.website ? '' : ' dash'}`}>
                {lead.website ? (
                  <a
                    className="ig-link"
                    href={lead.website.startsWith('http') ? lead.website : `https://${lead.website}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {lead.website.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  '—'
                )}
              </span>
            </div>
            {lead.reuniao_at && <Row k="Reunião" v={fmtDateTime(lead.reuniao_at)} />}
            {lead.reuniao_link && (
              <div className="kv">
                <span className="k">Meet</span>
                <span className="v">
                  <a className="ig-link" href={lead.reuniao_link} target="_blank" rel="noreferrer">
                    Abrir ↗
                  </a>
                </span>
              </div>
            )}

            <MarcarReuniaoForm lead={lead} />

            <div style={{ marginTop: 18 }}>
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
            </div>
          </section>
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
          disabled={update.isPending || jaDescartado}
          title={
            jaDescartado
              ? naOlivia ? 'Já está em opt-out.' : 'Já está descartado.'
              : naOlivia ? 'Move pra Opt-out — sai da conversa, mas não some (recuperável).' : undefined
          }
          onClick={() => update.mutate({ id: lead.id, patch: descartarPatch }, { onSuccess: onClose })}
        >
          Descartar
        </button>
      </div>
    </aside>
  )
}
