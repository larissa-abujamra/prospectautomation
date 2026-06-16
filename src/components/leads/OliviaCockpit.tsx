import { useMemo, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import type { Lead, OliviaEstado } from '../../lib/types'
import { OLIVIA_ESTADO_META } from '../../lib/types'
import { useLeads } from '../../lib/leads'
import { fmtDateTime } from '../../lib/format'
import { safeHttpUrl } from '../../lib/url'

// Cockpit da Olivia: board estilo funil do HubSpot. Uma coluna por estado da
// Olivia (olivia_estado), na ordem do funil; cada lead vira um card clicável
// que abre a ficha. Tudo derivado de useLeads — sem query nova. Leads sem
// olivia_estado (fora do fluxo da Olivia) não aparecem.

// Colunas do funil. "Agendando reunião" foi removida: o fluxo pula direto de
// Conversando para Reunião agendada. Leads em 'agendando' caem em Conversando
// (ainda é conversa ativa) — assim ninguém some do board.
const COLUNAS: OliviaEstado[] = [
  'aguardando',
  'conversando',
  'agendado',
  'handoff',
  'optout',
]

export function OliviaCockpit({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const { data: leads = [], isLoading, isError, error } = useLeads()
  // Busca por nome — filtra só os cards do board; os stats seguem como totais.
  const [q, setQ] = useState('')

  const porEstado = useMemo(() => {
    const map = new Map<OliviaEstado, Lead[]>()
    for (const e of COLUNAS) map.set(e, [])
    for (const l of leads) {
      // 'agendando' não tem coluna própria — dobra em 'conversando'.
      const e = l.olivia_estado === 'agendando' ? 'conversando' : l.olivia_estado
      if (e && map.has(e)) map.get(e)!.push(l)
    }
    // Reuniões em ordem cronológica; as demais colunas, alfabética por nome.
    for (const e of COLUNAS) {
      const arr = map.get(e)!
      if (e === 'agendado') {
        arr.sort(
          (a, b) =>
            (Date.parse(a.reuniao_at ?? '') || Infinity) -
            (Date.parse(b.reuniao_at ?? '') || Infinity),
        )
      } else {
        arr.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      }
    }
    return map
  }, [leads])

  const total = useMemo(
    () => COLUNAS.reduce((n, e) => n + (porEstado.get(e)?.length ?? 0), 0),
    [porEstado],
  )

  // Stats do topo (KPIs). "Ativos" = tudo no funil menos opt-out (lead morto).
  // Taxa de resposta = responderam / disparados, sobre TODOS os leads disparados.
  const stats = useMemo(() => {
    const ativos = total - (porEstado.get('optout')?.length ?? 0)
    const conversando = porEstado.get('conversando')?.length ?? 0
    const reunioes = porEstado.get('agendado')?.length ?? 0
    const disparados = leads.filter(
      (l) => l.whatsapp_sent_at != null || l.whatsapp_send_status != null,
    ).length
    const responderam = leads.filter((l) => l.whatsapp_send_status === 'replied').length
    const taxa = disparados > 0 ? (responderam / disparados) * 100 : 0
    return { ativos, conversando, reunioes, disparados, responderam, taxa }
  }, [porEstado, total, leads])

  if (isLoading) return <div className="search-status"><Loader2 size={15} className="spin" /> Carregando…</div>
  if (isError) return <div className="search-status err">Falha ao carregar: {(error as Error).message}</div>

  if (total === 0) {
    return (
      <div className="empty-state">
        <h3>Nenhuma conversa da Olivia ainda</h3>
        <p>
          Quando a Olivia começar a conversar com os leads disparados, eles aparecem
          aqui no funil — de "aguardando resposta" até "reunião agendada".
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="oli-stats">
        <div className="oli-stat glass-card">
          <span className="eyebrow">No pipeline</span>
          <span className="oli-stat-num">{stats.ativos}</span>
          <span className="oli-stat-sub">negócios ativos</span>
        </div>
        <div className="oli-stat glass-card">
          <span className="eyebrow">Conversando</span>
          <span className="oli-stat-num fin">{stats.conversando}</span>
          <span className="oli-stat-sub">em conversa ativa</span>
        </div>
        <div className="oli-stat glass-card">
          <span className="eyebrow">Reuniões</span>
          <span className="oli-stat-num waz">{stats.reunioes}</span>
          <span className="oli-stat-sub">agendadas</span>
        </div>
        <div className="oli-stat glass-card">
          <span className="eyebrow">Taxa de resposta</span>
          <span className="oli-stat-num maky">
            {stats.taxa.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
          </span>
          <span className="oli-stat-sub">
            {stats.responderam} de {stats.disparados} disparos
          </span>
        </div>
      </div>

      <div className="oli-board-search search-field">
        <Search size={15} />
        <input
          type="search"
          placeholder="Buscar negócio por nome…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Buscar negócio por nome"
        />
      </div>

      <div className="oli-board">
        {COLUNAS.map((estado) => {
        const meta = OLIVIA_ESTADO_META[estado]
        const termo = q.trim().toLowerCase()
        const itens = (porEstado.get(estado) ?? []).filter(
          (l) => !termo || l.nome.toLowerCase().includes(termo),
        )
        return (
          <div key={estado} className="oli-col">
            <div className="oli-col-head">
              <span className="status-dot" data-status={meta.dot} />
              <span className="eyebrow">{meta.label}</span>
              <span className="oli-col-count">{itens.length}</span>
            </div>
            <div className="oli-col-body">
              {itens.length === 0 ? (
                <p className="oli-col-empty">Vazio</p>
              ) : (
                itens.map((l) => <CardLead key={l.id} lead={l} onOpen={onOpenLead} />)
              )}
            </div>
          </div>
          )
        })}
      </div>
    </>
  )
}

// Card de um lead na coluna. Sub-linha contextual ao estado:
// reunião → data + Meet; handoff → motivo; demais → bairro (se houver).
function CardLead({ lead, onOpen }: { lead: Lead; onOpen: (id: string) => void }) {
  let sub: React.ReactNode = null
  if (lead.olivia_estado === 'agendado' && lead.reuniao_at) {
    const meet = safeHttpUrl(lead.reuniao_link)
    sub = (
      <>
        {fmtDateTime(lead.reuniao_at)}
        {meet && (
          <>
            {' · '}
            <a
              href={meet}
              target="_blank"
              rel="noreferrer"
              className="oli-card-link"
              onClick={(e) => e.stopPropagation()}
            >
              Meet ↗
            </a>
          </>
        )}
      </>
    )
  } else if (lead.olivia_estado === 'handoff') {
    sub = lead.olivia_handoff_motivo ?? 'Escalou pra um humano — abra e responda.'
  } else if (lead.bairro) {
    sub = lead.bairro
  }

  return (
    <button type="button" className="oli-card" onClick={() => onOpen(lead.id)}>
      <span className="oli-card-nome">{lead.nome}</span>
      {sub && <span className="oli-card-sub">{sub}</span>}
    </button>
  )
}
