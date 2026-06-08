import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from './useSession'

// Gate de autenticação: envolve as rotas internas.
// Sem sessão Supabase → redireciona para /login.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()

  if (loading) {
    return <div className="center-screen">Carregando…</div>
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
