import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSession } from '../auth/useSession'

// Login interno. NÃO existe signup público: esta é uma ferramenta interna do time
// de vendas. As contas são criadas manualmente no painel do Supabase
// (Authentication → Users). Por isso aqui só há entrada por email + senha.
export default function Login() {
  const navigate = useNavigate()
  const { session, loading: sessionLoading } = useSession()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Já logado? não faz sentido ver o login.
  if (!sessionLoading && session) {
    return <Navigate to="/" replace />
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    setSubmitting(false)

    if (signInError) {
      setError('Não foi possível entrar. Confira email e senha.')
      return
    }

    navigate('/', { replace: true })
  }

  return (
    <div className="auth-wrap">
      <div className="signup-card">
        <div className="brand">Squad</div>
        <div className="brand-sub eyebrow">Prospecção · Docerias SP</div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="eyebrow" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label className="eyebrow" htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="btn-glow block" disabled={submitting}>
            <span className="btn-glow-bg" />
            <span className="btn-glow-content">
              {submitting ? 'Entrando…' : 'Entrar'}
            </span>
          </button>
        </form>
      </div>
    </div>
  )
}
