import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'

// Olivia (Fase 1 — shell): apresenta o fluxo automatizado e seus 4 passos.
// O wizard funcional (buscar → selecionar → processar → resumo) é a Fase 3 do
// re-layout (ver .claude/plans/2026-06-10-relayout.md) — todos os endpoints já
// existem (buscar-negocios, enriquecer-lead, encontrar-whatsapp, hubspot-sync).
const PASSOS = [
  { n: '1', t: 'Buscar', d: 'A mesma busca do Google Places de hoje.' },
  { n: '2', t: 'Selecionar', d: 'Você escolhe quais leads entram no lote.' },
  { n: '3', t: 'Processar', d: 'Enriquece (CNPJ + dona), acha o WhatsApp e salva na base.' },
  { n: '4', t: 'Disparar', d: 'Envia pro HubSpot com o template f/m — a Olivia manda em ~5 min.' },
]

export default function Olivia() {
  return (
    <>
      <header className="page-head">
        <div className="eyebrow">
          <Sparkles size={11} style={{ verticalAlign: -1 }} /> Olivia · automático
        </div>
        <h1>Prospecção automática</h1>
        <p className="page-sub">
          Busca → você escolhe → ela enriquece, salva na base e dispara o WhatsApp
          via HubSpot. Num fluxo só.
        </p>
      </header>

      <ol className="olivia-steps">
        {PASSOS.map((p) => (
          <li key={p.n} className="olivia-step">
            <span className="olivia-step-n">{p.n}</span>
            <div>
              <div className="olivia-step-t">{p.t}</div>
              <div className="olivia-step-d">{p.d}</div>
            </div>
          </li>
        ))}
      </ol>

      <div className="callout waz">
        O wizard chega na Fase 3 do re-layout. Enquanto isso, o fluxo manual
        continua: <Link to="/buscar">Buscar</Link> → <Link to="/base">Base de Dados</Link>
        {' '}→ enviar WhatsApp pela ficha do lead.
      </div>
    </>
  )
}
