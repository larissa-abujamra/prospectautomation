import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Search, ArrowUpRight, Download } from 'lucide-react'
import type { Lead, OliviaEstado } from '../../lib/types'
import { OLIVIA_ESTADO_META } from '../../lib/types'
import { useLeads } from '../../lib/leads'
import { useInboundCounts, MIN_MSGS_CONVERSA_REAL } from '../../lib/disparos'
import { fmtDateTime } from '../../lib/format'
import { safeHttpUrl } from '../../lib/url'
import { toCsv, downloadCsv } from '../../lib/csv'
import { OliviaStatCards } from './OliviaStatCards'
import type { DrawerTab } from './LeadDrawer'

// Cockpit da Olivia: board estilo funil do HubSpot. Uma coluna por etapa, na
// ordem do funil; cada lead vira um card clicável que abre a ficha. Tudo derivado
// de useLeads + contagem de mensagens recebidas. Leads sem olivia_estado não aparecem.

// Colunas do funil. "Conversando" foi dividida em duas (pedido do time): quem só
// respondeu UMA vez (provável auto-resposta de boas-vindas) fica em "Primeira
// resposta"; só quem mandou MIN_MSGS_CONVERSA_REAL+ mensagens conta como conversa
// real. 'agendando' dobra em conversa; "Agendando reunião" não tem coluna própria.
type ColunaId =
  | 'aguardando' | 'primeira_resposta' | 'conversando' | 'handoff' | 'agendado' | 'optout'

const COLUNAS: { id: ColunaId; label: string; dot: 'empty' | 'pending' | 'ok' | 'missing' }[] = [
  { id: 'aguardando', label: 'Aguardando resposta', dot: 'empty' },
  { id: 'primeira_resposta', label: 'Primeira resposta', dot: 'ok' },
  { id: 'conversando', label: 'Conversando', dot: 'pending' },
  { id: 'handoff', label: 'Precisa de você', dot: 'missing' },
  { id: 'agendado', label: 'Reunião agendada', dot: 'ok' },
  { id: 'optout', label: 'Opt-out — não contatar', dot: 'missing' },
]

// A qual coluna um lead pertence. 'conversando'/'agendando' se dividem por nº de
// mensagens recebidas: 1 → "Primeira resposta", MIN+ → "Conversando". Enquanto a
// contagem não carregou (counts undefined), não rebaixa ninguém (fica em Conversando).
function colunaDoLead(lead: Lead, counts: Map<string, number> | undefined): ColunaId | null {
  const e = lead.olivia_estado
  if (!e) return null
  if (e === 'aguardando' || e === 'handoff' || e === 'agendado' || e === 'optout') return e
  if (e === 'conversando' || e === 'agendando') {
    if (!counts) return 'conversando'
    return (counts.get(lead.id) ?? 0) >= MIN_MSGS_CONVERSA_REAL ? 'conversando' : 'primeira_resposta'
  }
  return null // 'pausada' ou desconhecido → fora do board
}

export function OliviaCockpit({ onOpenLead }: { onOpenLead: (id: string, tab?: DrawerTab) => void }) {
  const { data: leads = [], isLoading, isError, error } = useLeads()
  const inbound = useInboundCounts()
  // Busca por nome — filtra só os cards do board; os stats seguem como totais.
  const [q, setQ] = useState('')

  const porColuna = useMemo(() => {
    const counts = inbound.data
    const map = new Map<ColunaId, Lead[]>()
    for (const c of COLUNAS) map.set(c.id, [])
    for (const l of leads) {
      const col = colunaDoLead(l, counts)
      if (col && map.has(col)) map.get(col)!.push(l)
    }
    // Aguardando: disparo mais novo primeiro. Reuniões: ordem cronológica.
    // Demais: alfabética por nome.
    for (const c of COLUNAS) {
      const arr = map.get(c.id)!
      if (c.id === 'aguardando') {
        arr.sort(
          (a, b) =>
            (Date.parse(b.whatsapp_sent_at ?? '') || 0) -
            (Date.parse(a.whatsapp_sent_at ?? '') || 0),
        )
      } else if (c.id === 'agendado') {
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
  }, [leads, inbound.data])

  const total = useMemo(
    () => COLUNAS.reduce((n, c) => n + (porColuna.get(c.id)?.length ?? 0), 0),
    [porColuna],
  )

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

  // Exporta o funil inteiro (todos com olivia_estado) como CSV pro Excel.
  function exportar() {
    const funil = leads.filter((l) => l.olivia_estado)
    const headers = ['Nome', 'Estágio', 'Bairro', 'WhatsApp', 'Disparado em', 'Reunião em', 'Link da reunião', 'Motivo handoff']
    const rows = funil.map((l) => [
      l.nome,
      (l.olivia_estado && OLIVIA_ESTADO_META[l.olivia_estado as OliviaEstado]?.label) || l.olivia_estado || '',
      l.bairro ?? '',
      l.whatsapp_dono?.trim() || l.whatsapp_phone || '',
      l.whatsapp_sent_at ? fmtDateTime(l.whatsapp_sent_at) : '',
      l.reuniao_at ? fmtDateTime(l.reuniao_at) : '',
      l.reuniao_link ?? '',
      l.olivia_handoff_motivo ?? '',
    ])
    downloadCsv(`olivia-acompanhamento-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows))
  }

  return (
    <>
      <div className="oli-stats-head">
        <button className="btn ghost sm" onClick={exportar}>
          <Download size={13} /> Exportar
        </button>
        <Link to="/estatisticas" className="eyebrow oli-mais-stats">
          mais stats <ArrowUpRight size={12} />
        </Link>
      </div>

      <OliviaStatCards leads={leads} />

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
        {COLUNAS.map((coluna) => {
        const termo = q.trim().toLowerCase()
        const itens = (porColuna.get(coluna.id) ?? []).filter(
          (l) => !termo || l.nome.toLowerCase().includes(termo),
        )
        return (
          <div key={coluna.id} className="oli-col" data-estado={coluna.id}>
            <div className="oli-col-head">
              <span className="status-dot" data-status={coluna.dot} />
              <span className="eyebrow">{coluna.label}</span>
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
function CardLead({ lead, onOpen }: { lead: Lead; onOpen: (id: string, tab?: DrawerTab) => void }) {
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
  } else if (lead.olivia_estado === 'aguardando' && lead.whatsapp_sent_at) {
    sub = `Disparado em ${fmtDateTime(lead.whatsapp_sent_at)}`
  } else if (lead.bairro) {
    sub = lead.bairro
  }

  return (
    <button
      type="button"
      className="oli-card"
      onClick={() => onOpen(lead.id, lead.olivia_estado === 'agendado' ? 'briefing' : undefined)}
    >
      <span className="oli-card-nome">{lead.nome}</span>
      {sub && <span className="oli-card-sub">{sub}</span>}
    </button>
  )
}
