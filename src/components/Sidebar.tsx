import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Search, Database, Map, VenetianMask, Sparkles } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useLeads } from '../lib/leads'
import { isClienteOcultoPendente } from '../lib/clienteOculto'
import { isBaseLead } from './leads/filters'
import type { Lead } from '../lib/types'
import squadLogo from '../assets/squad-logo-preto.png'

// IA aprovada no plano de re-layout (10/06): Buscar é entrada; Base de Dados é a
// mesa de trabalho; Rotas e Cliente Oculto consomem só a base; Olivia automatiza.
// Sem trava entre etapas — todas navegáveis; o que muda é o recorte de leads.

// Contagens vivas por item. Base = exatamente o que a PÁGINA Base de Dados mostra
// (qualificado/enriquecido, via isBaseLead) — o badge tem que bater com a lista
// ao clicar. Rotas = em rota ou visitado. Cliente Oculto = visitas PENDENTES.
function counts(leads: Lead[]) {
  let buscar = 0
  let base = 0
  let rotas = 0
  let oculto = 0
  for (const l of leads) {
    if (l.status === 'descoberto') buscar++
    else if (isBaseLead(l.status)) base++
    if (l.status === 'em_rota' || l.status === 'visitado') rotas++
    if (isClienteOcultoPendente(l)) oculto++
  }
  return { buscar, base, rotas, oculto }
}

export function Sidebar() {
  const navigate = useNavigate()
  const [email, setEmail] = useState<string>('')
  const { data: leads = [] } = useLeads()
  const c = counts(leads)

  const NAV = [
    { to: '/buscar', num: '01', label: 'Buscar', icon: Search, count: c.buscar },
    { to: '/base', num: '02', label: 'Base de Dados', icon: Database, count: c.base },
    { to: '/mapa', num: '03', label: 'Rotas', icon: Map, count: c.rotas },
    { to: '/cliente-oculto', num: '04', label: 'Cliente Oculto', icon: VenetianMask, count: c.oculto },
  ]

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? '')
    })
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <aside className="sidebar">
      <div>
        <img className="brand-logo" src={squadLogo} alt="Squad" />
        <div className="brand-sub eyebrow">Prospecção</div>
      </div>

      <nav className="nav">
        {NAV.map(({ to, num, label, icon: Icon, count }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item funnel${isActive ? ' active' : ''}`}
          >
            <span className="nav-num">{num}</span>
            <Icon size={18} strokeWidth={1.75} />
            {label}
            {count != null && count > 0 && <span className="nav-count">{count}</span>}
          </NavLink>
        ))}

        <div className="nav-sep" />

        <NavLink
          to="/olivia"
          className={({ isActive }) => `nav-item funnel olivia${isActive ? ' active' : ''}`}
        >
          <Sparkles size={18} strokeWidth={1.75} />
          Olivia
          <span className="badge nav-badge">auto</span>
        </NavLink>
      </nav>

      <div className="user-block">
        <div className="avatar" aria-hidden />
        <div className="user-meta">
          <div className="user-name" title={email}>{email || '—'}</div>
        </div>
        <button type="button" className="btn ghost" onClick={handleSignOut}>
          Sair
        </button>
      </div>
    </aside>
  )
}
