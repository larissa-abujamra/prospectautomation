import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// Acompanha a sessão Supabase. `loading` fica true até sabermos se há (ou não)
// sessão — evita um flash da tela de login para um usuário já autenticado.
export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // .catch + .finally: se getSession rejeitar (erro de rede no load), não deixa
    // a UI travada em "Carregando…" para sempre — cai como "sem sessão".
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => setSession(null))
      .finally(() => setLoading(false))

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  return { session, loading }
}
