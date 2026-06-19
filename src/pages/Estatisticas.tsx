import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useLeads } from '../lib/leads'
import { useInboundCounts, MIN_MSGS_CONVERSA_REAL } from '../lib/disparos'
import { isBaseLead } from '../components/leads/filters'
import { OliviaStatCards } from '../components/leads/OliviaStatCards'
import { InboundSquadLeadsPanel } from '../components/leads/InboundSquadLeadsPanel'
import type { Lead } from '../lib/types'
import eclipse1 from '../assets/eclipse1.png'
import eclipse2 from '../assets/eclipse2.png'
import eclipse3 from '../assets/eclipse3.png'
import eclipse4 from '../assets/eclipse4.png'

// Página de Estatísticas da Olivia — aprofundamento dos stat cards do
// Acompanhamento. Mostra os mesmos 4 KPIs no topo + distribuições úteis
// (setores e bairros mais frequentes). Tudo derivado de useLeads — sem query.

// Conta ocorrências de um campo (setor/bairro) e devolve o top N, desc.
function topPor(leads: Lead[], campo: 'setor' | 'bairro', n = 6) {
  const contagem = new Map<string, number>()
  for (const l of leads) {
    const v = l[campo]?.trim()
    if (v) contagem.set(v, (contagem.get(v) ?? 0) + 1)
  }
  return Array.from(contagem.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, valor]) => ({ label, valor }))
}

// Paleta categórica (cicla nos 4 tons) — usada por setores e bairros.
const CORES = ['var(--waz)', 'var(--fin)', 'var(--maky)', 'var(--gold)']

// --- Funil de conversão -------------------------------------------------------
// Predicados MONOTÔNICOS ("chegou pelo menos até aqui") por presença de campo —
// nunca por igualdade de status atual, senão um lead disparado sairia da conta
// de qualificado.
const respondeu = (l: Lead) =>
  l.whatsapp_send_status === 'replied' ||
  ['conversando', 'agendando', 'agendado', 'handoff'].includes(l.olivia_estado ?? '')
const agendou = (l: Lead) => l.olivia_estado === 'agendado' || l.reuniao_at != null

const conv = (prev: number, cur: number) => (prev > 0 ? (cur / prev) * 100 : 0)
const sev = (pct: number) => (pct >= 70 ? 'sev-ok' : pct >= 40 ? 'sev-warn' : 'sev-bad')
const fmt = (n: number) => n.toLocaleString('pt-BR')

// Anéis do funil (PNGs do Figma), do mais escuro (eclipse1 = Disparado) ao mais
// claro (eclipse4 = Agendado).
const ANEIS_FUNIL = [eclipse1, eclipse2, eclipse3, eclipse4]

// Setores: barras ranqueadas e coloridas.
function RankBars({ items }: { items: { label: string; valor: number }[] }) {
  const max = items.reduce((m, it) => Math.max(m, it.valor), 0) || 1
  return (
    <div className="rank-list">
      {items.map((it, i) => (
        <div className="rank-row" key={it.label}>
          <span className="rank-n">{i + 1}</span>
          <span className="rank-lab">{it.label}</span>
          <span className="rank-track">
            <span className="rank-fill" style={{ width: `${(it.valor / max) * 100}%` }} />
          </span>
          <span className="rank-val">{it.valor}</span>
        </div>
      ))}
    </div>
  )
}

// Bairros: tiles proporcionais (flex-grow = contagem).
function Tiles({ items }: { items: { label: string; valor: number }[] }) {
  return (
    <div className="tiles">
      {items.map((it, i) => (
        <div
          className="tile"
          key={it.label}
          style={{ ['--c' as string]: CORES[i % 4], flexGrow: it.valor } as React.CSSProperties}
        >
          <div className="tile-l">{it.label}</div>
          <div className="tile-n">{it.valor}</div>
        </div>
      ))}
    </div>
  )
}

export default function Estatisticas() {
  const { data: leads = [], isLoading, isError, error } = useLeads()

  // Distribuições contadas sobre o MESMO pool da Base de Dados (qualificado/
  // enriquecido), não a tabela inteira — senão entram os 'descoberto'/'descartado'
  // e a soma estoura os leads que o time realmente tem.
  const baseLeads = useMemo(() => leads.filter((l) => isBaseLead(l.status)), [leads])
  const setores = useMemo(() => topPor(baseLeads, 'setor'), [baseLeads])
  const bairros = useMemo(() => topPor(baseLeads, 'bairro'), [baseLeads])

  // Engajamento: quem respondeu (1+ msg) vs quem está conversando de verdade
  // (2+ msgs do negócio, além das boas-vindas automáticas).
  const inbound = useInboundCounts()
  const engajamento = useMemo(() => {
    const counts = inbound.data
    if (!counts) return null
    const responderam = counts.size
    let conversasReais = 0
    for (const n of counts.values()) if (n >= MIN_MSGS_CONVERSA_REAL) conversasReais++
    const primeiraSo = responderam - conversasReais
    const ratio = responderam > 0 ? (conversasReais / responderam) * 100 : 0
    return { responderam, conversasReais, primeiraSo, ratio }
  }, [inbound.data])

  // Anel de engajamento: circunferência (r=50) e trecho preenchido pela ratio.
  const ringC = 2 * Math.PI * 50
  const ringFilled = engajamento ? (engajamento.ratio / 100) * ringC : 0

  return (
    <>
      <header className="page-head">
        <Link to="/olivia" className="btn ghost sm" style={{ marginBottom: 12 }}>
          <ArrowLeft size={13} /> Voltar para Olivia
        </Link>
        <div className="eyebrow">Olivia</div>
        <h1>Estatísticas</h1>
        
      </header>

      {isLoading ? (
        <div className="search-status"><Loader2 size={15} className="spin" /> Carregando…</div>
      ) : isError ? (
        <div className="search-status err">Falha ao carregar: {(error as Error).message}</div>
      ) : (
        <>
          <OliviaStatCards leads={leads} />

          <div className="stat-split">
            <section className="stat-section">
              <h3 className="stat-section-title">Funil de conversão</h3>
              <div className="funil-vert">
                <div className="fv-rings">
                  {vitrine.map((e) => (
                    <div className="fv-stage" key={e.nome}>
                      <div className="fv-ring" style={{ width: e.size, height: e.size }}>
                        <img src={e.img} alt="" />
                        <div className="fv-center">
                          <span className="fv-name">{e.nome}</span>
                          <span className="fv-num">{fmt(e.n)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="fv-convs">
                  {vitrine.slice(1).map((e, i) => {
                    const pct = conv(vitrine[i].n, e.n)
                    return (
                      <div className="fv-conv" key={e.nome}>
                        {i > 0 && <span className="fv-down">↓</span>}
                        <span className={`pc ${sev(pct)}`}>{pct.toFixed(0)}%</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>

            <section className="stat-section">
              <h3 className="stat-section-title">Setores mais frequentes</h3>
              {setores.length === 0 ? (
                <p className="muted-line">Sem setores registrados ainda.</p>
              ) : (
                <RankBars items={setores} />
              )}
            </section>
          </div>

          <section className="stat-section">
            <h3 className="stat-section-title">Bairros mais frequentes</h3>
            {bairros.length === 0 ? (
              <p className="muted-line">Sem bairros registrados ainda.</p>
            ) : (
              <Tiles items={bairros} />
            )}
          </section>

          <section className="stat-section">
            <h3 className="stat-section-title">Desfechos das conversas (últimos 30 dias)</h3>
            {!outcomes || outcomes.total === 0 ? (
              <p className="muted-line">
                Nenhuma conversa finalizada ainda. Cada conversa que termina (agendada, escalada,
                opt-out ou assumida por humano) é registrada aqui automaticamente.
              </p>
            ) : (
              <>
                <RankBars items={outcomeItems} />
                <p className="muted-line" style={{ marginTop: 8 }}>
                  <b>{outcomes.total}</b> conversas finalizadas · média de{' '}
                  <b>{outcomes.media_mensagens.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</b>{' '}
                  mensagens por conversa
                  {outcomes.media_qualidade != null && (
                    <> · qualidade média <b>{outcomes.media_qualidade.toLocaleString('pt-BR')}</b>/5</>
                  )}
                  .
                </p>
                {outcomes.temas_top.length > 0 && (
                  <p className="muted-line" style={{ marginTop: 4 }}>
                    Temas recorrentes: {outcomes.temas_top.map((t) => `${t.tema} (${t.n})`).join(', ')}.
                  </p>
                )}
              </>
            )}
          </section>

          <InboundSquadLeadsPanel leads={leads} />
        </>
      )}
    </>
  )
}
