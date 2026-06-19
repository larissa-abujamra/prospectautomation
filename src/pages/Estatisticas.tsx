import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useLeads } from '../lib/leads'
import { useInboundCounts, MIN_MSGS_CONVERSA_REAL } from '../lib/disparos'
import { isBaseLead } from '../components/leads/filters'
import { OliviaStatCards } from '../components/leads/OliviaStatCards'
import { InboundSquadLeadsPanel } from '../components/leads/InboundSquadLeadsPanel'
import type { Lead } from '../lib/types'

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

          <section className="stat-section">
            <h3 className="stat-section-title">Engajamento das conversas</h3>
            {!engajamento ? (
              <p className="muted-line">Carregando conversas…</p>
            ) : engajamento.responderam === 0 ? (
              <p className="muted-line">Ninguém respondeu ainda.</p>
            ) : (
              <div className="eng">
                <svg
                  className="eng-ring"
                  width="118"
                  height="118"
                  viewBox="0 0 120 120"
                  role="img"
                  aria-label={`${engajamento.ratio.toFixed(1)}% seguiram além das boas-vindas`}
                >
                  <circle cx="60" cy="60" r="50" fill="none" stroke="var(--bg-3)" strokeWidth="13" />
                  <circle
                    cx="60"
                    cy="60"
                    r="50"
                    fill="none"
                    stroke="var(--waz)"
                    strokeWidth="13"
                    strokeLinecap="round"
                    strokeDasharray={`${ringFilled} ${ringC - ringFilled}`}
                    transform="rotate(-90 60 60)"
                  />
                  <text x="60" y="58" textAnchor="middle" fontSize="22" fontWeight="500" fill="var(--ink)">
                    {engajamento.ratio.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
                  </text>
                  <text x="60" y="75" textAnchor="middle" fontSize="10" fill="var(--ink)" opacity="0.6">
                    conversaram +
                  </text>
                </svg>
                <div className="eng-leg">
                  <div className="eng-leg-row">
                    <span className="eng-dot" style={{ background: 'var(--waz)' }} />
                    Conversando (2+ msgs do negócio)
                    <span className="eng-leg-n">{engajamento.conversasReais}</span>
                  </div>
                  <div className="eng-leg-row">
                    <span className="eng-dot" style={{ background: 'var(--bg-3)' }} />
                    Só primeira resposta (boas-vindas)
                    <span className="eng-leg-n">{engajamento.primeiraSo}</span>
                  </div>
                  <p className="muted-line" style={{ marginTop: 4 }}>
                    <b>{engajamento.conversasReais}</b> de <b>{engajamento.responderam}</b> que responderam
                    {' '}({engajamento.ratio.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%) seguiram
                    além da primeira mensagem — o resto provavelmente é só auto-resposta de boas-vindas.
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="stat-section">
            <h3 className="stat-section-title">Setores mais frequentes</h3>
            {setores.length === 0 ? (
              <p className="muted-line">Sem setores registrados ainda.</p>
            ) : (
              <RankBars items={setores} />
            )}
          </section>

          <section className="stat-section">
            <h3 className="stat-section-title">Bairros mais frequentes</h3>
            {bairros.length === 0 ? (
              <p className="muted-line">Sem bairros registrados ainda.</p>
            ) : (
              <Tiles items={bairros} />
            )}
          </section>

          <InboundSquadLeadsPanel leads={leads} />
        </>
      )}
    </>
  )
}
