import { Fragment, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useLeads } from '../lib/leads'
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
// Agrupa de forma insensível a caixa/espaços ("Pinheiros", "pinheiros" e
// "Pinheiros " caem no mesmo balde) — senão a mesma localidade fica fragmentada
// e some do ranking. O rótulo exibido é a grafia mais frequente do grupo.
function topPor(leads: Lead[], campo: 'setor' | 'bairro', n = 6) {
  const grupos = new Map<string, { total: number; grafias: Map<string, number> }>()
  for (const l of leads) {
    const raw = l[campo]?.trim()
    if (!raw) continue
    const chave = raw.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ')
    let g = grupos.get(chave)
    if (!g) {
      g = { total: 0, grafias: new Map() }
      grupos.set(chave, g)
    }
    g.total++
    g.grafias.set(raw, (g.grafias.get(raw) ?? 0) + 1)
  }
  return Array.from(grupos.values())
    .map((g) => {
      let label = ''
      let max = -1
      for (const [grafia, c] of g.grafias) if (c > max) [max, label] = [c, grafia]
      return { label, valor: g.total }
    })
    .sort((a, b) => b.valor - a.valor)
    .slice(0, n)
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

// Fração da soma de dois anéis vizinhos usada como sobreposição (margin-top
// negativa). A elipse deitada deixa ~17% de vão vertical em cada lado do
// quadrado, então ~0.19 cola bem. Usado no marginTop inline E no cálculo das %.
const RING_OVERLAP = 0.19

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

// Bairros: tijolinhos de tamanhos variados — quanto mais leads no bairro, maior
// o tijolo (altura via grid-row span). Como os números costumam ser próximos,
// o tamanho segue o RANKING (já vem ordenado desc), garantindo gradação visível.
const TILE_SPANS = [4, 3, 3, 2, 2, 2]
function Tiles({ items }: { items: { label: string; valor: number }[] }) {
  return (
    <div className="tiles">
      {items.map((it, i) => {
        const span = TILE_SPANS[i] ?? 2
        return (
          <div
            className="tile"
            key={it.label}
            style={{ ['--c']: CORES[i % 4], ['--span']: span, gridRow: `span ${span}` } as React.CSSProperties}
          >
            <div className="tile-l">{it.label}</div>
            <div className="tile-n">{it.valor}</div>
          </div>
        )
      })}
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

  // Vitrine do funil: 4 etapas-chave (Disparado → Qualificado → Respondeu →
  // Agendado). A conversão entre dois anéis é cur/prev das etapas EXIBIDAS —
  // pula descoberto/número de propósito (é resumo de alto nível).
  const vitrine = useMemo(
    () => [
      { nome: 'Disparado', n: leads.filter((l) => l.whatsapp_sent_at != null).length, img: ANEIS_FUNIL[0], size: 230 },
      { nome: 'Qualificado', n: leads.filter((l) => isBaseLead(l.status)).length, img: ANEIS_FUNIL[1], size: 172 },
      { nome: 'Respondeu', n: leads.filter(respondeu).length, img: ANEIS_FUNIL[2], size: 132 },
      { nome: 'Agendado', n: leads.filter(agendou).length, img: ANEIS_FUNIL[3], size: 112 },
    ],
    [leads],
  )

  // Posições das conversões: cada % vive no MEIO do par de anéis que compara.
  // Como os anéis têm tamanhos e sobreposições diferentes, calculamos o centro
  // vertical de cada anel (mesma matemática do marginTop inline) e colocamos o
  // badge no ponto médio entre dois centros vizinhos.
  const convs = useMemo(() => {
    const centros: number[] = []
    let top = 0
    vitrine.forEach((e, i) => {
      if (i > 0) top -= RING_OVERLAP * (vitrine[i - 1].size + e.size)
      centros.push(top + e.size / 2)
      top += e.size
    })
    return vitrine.slice(1).map((e, i) => ({
      nome: e.nome,
      pct: conv(vitrine[i].n, e.n),
      y: (centros[i] + centros[i + 1]) / 2,
    }))
  }, [vitrine])

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
                  {vitrine.map((e, i) => (
                    <div
                      className="fv-stage"
                      key={e.nome}
                      // Cola os anéis: a elipse deitada deixa um vão vertical (~17% do
                      // lado) dentro do quadrado, então a sobreposição cresce com o
                      // tamanho dos dois anéis vizinhos. z-index decrescente: o anel de
                      // cima sempre cobre o de baixo.
                      style={{
                        zIndex: vitrine.length - i,
                        ...(i > 0 ? { marginTop: -RING_OVERLAP * (vitrine[i - 1].size + e.size) } : null),
                      }}
                    >
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
                {/* Conversões posicionadas em valor absoluto no meio de cada par de
                    anéis; cabos esticam entre badges consecutivos. */}
                <div className="fv-convs">
                  {convs.map((c, i) => (
                    <Fragment key={c.nome}>
                      {i > 0 && (
                        <span
                          className="fv-cable"
                          style={{ top: convs[i - 1].y + 20, height: c.y - convs[i - 1].y - 40 }}
                        />
                      )}
                      <span className={`pc ${sev(c.pct)}`} style={{ top: c.y }}>
                        {c.pct.toFixed(0)}%
                      </span>
                    </Fragment>
                  ))}
                </div>
              </div>
            </section>

            <div className="stat-col">
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
            </div>
          </div>

          <InboundSquadLeadsPanel leads={leads} />
        </>
      )}
    </>
  )
}
