// Guard de autenticação para Edge Functions (interno, workspace compartilhado).
// =============================================================================
// As funções usam a service role para escrever ignorando a RLS — então é AQUI
// que garantimos que só um MEMBRO LOGADO do time (não a anon key pública, que
// vive no bundle do frontend) dispara ações sensíveis: envio de WhatsApp (custo +
// quality rating da Meta), sync no HubSpot, gasto de créditos de scraping, etc.
//
// Não há dono por lead (RLS = "qualquer autenticado, todos os leads"), então a
// regra é só autenticação — não ownership.
// =============================================================================

// NOTA: o createClient é importado DINAMICAMENTE dentro de requireAuthenticatedUser
// (não no topo) para este módulo permanecer puro o suficiente para o Vitest
// importar `bearerToken` sem resolver a URL esm.sh (convenção dos _shared).

// Extrai o token Bearer do header Authorization. Puro → unit-testável.
export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  const t = (m ? m[1] : '').trim()
  return t || null
}

// True só se o request traz o JWT de um USUÁRIO autenticado de verdade. A anon
// key é um JWT válido (role 'anon', sem usuário) → getUser não devolve user →
// rejeitada. Token de sessão de um usuário logado → user.id presente → passa.
export async function requireAuthenticatedUser(req: Request): Promise<boolean> {
  const token = bearerToken(req.headers.get('Authorization'))
  if (!token) return false
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
    )
    const { data, error } = await supabase.auth.getUser(token)
    return !error && !!data?.user?.id
  } catch {
    return false
  }
}
