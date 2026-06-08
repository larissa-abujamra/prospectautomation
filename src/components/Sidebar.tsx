import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { List, Map } from 'lucide-react'
import { supabase } from '../lib/supabase'

const NAV = [
  { to: '/', label: 'Leads', icon: List, end: true },
  { to: '/mapa', label: 'Mapa', icon: Map, end: false },
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
        <div className="brand">Squad</div>
        <div className="brand-sub eyebrow">Prospecção · Docerias SP</div>
      </div>

      <nav className="nav">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
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
