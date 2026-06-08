import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Search, Sparkles, Map } from 'lucide-react'
import { supabase } from '../lib/supabase'
import squadLogo from '../assets/squad-logo-preto.png'

// Funil numerado. Sem trava entre etapas — todas navegáveis; o que muda é
// quais leads aparecem em cada uma (pelo status).
const NAV = [
  { to: '/buscar', num: '01', label: 'Buscar', icon: Search },
  { to: '/enriquecer', num: '02', label: 'Enriquecer', icon: Sparkles },
  { to: '/mapa', num: '03', label: 'Rotas', icon: Map },
]

export function Sidebar() {
  const navigate = useNavigate()
  const [email, setEmail] = useState<string>('')

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
        {NAV.map(({ to, num, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item funnel${isActive ? ' active' : ''}`}
          >
            <span className="nav-num">{num}</span>
            <Icon size={18} strokeWidth={1.75} />
            {label}
          </NavLink>
        ))}
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
