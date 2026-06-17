// Registro de erros operacionais num lugar que o time vê (tabela olivia_erros),
// não só no console da função. Best-effort: NUNCA lança — se gravar o erro
// falhar, cai pro console e segue (não pode derrubar o fluxo que já estava
// tratando uma falha). Inserção usa a service role (bypassa RLS).
//
// Uso:
//   await registrarErro(supabase, {
//     fonte: 'olivia-agendar',
//     leadId,
//     mensagem: 'Falha ao criar evento no Calendar',
//     contexto: { status, repEmail, slot },
//   })

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export interface ErroEntrada {
  fonte: string
  mensagem: string
  nivel?: 'error' | 'warn'
  leadId?: string | null
  contexto?: Record<string, unknown> | null
}

export async function registrarErro(
  supabase: SupabaseClient,
  entrada: ErroEntrada,
): Promise<void> {
  const { fonte, mensagem, nivel = 'error', leadId = null, contexto = null } = entrada
  // Sempre deixa rastro no console também (Supabase logs) — a tabela é o que o
  // time lê; o console é o fallback se a própria gravação falhar.
  console.error(`[${fonte}] ${mensagem}`, contexto ? JSON.stringify(contexto).slice(0, 500) : '')
  try {
    const { error } = await supabase.from('olivia_erros').insert({
      fonte,
      nivel,
      lead_id: leadId,
      mensagem: mensagem.slice(0, 2000),
      contexto,
    })
    if (error) console.error('registrarErro: falha ao gravar olivia_erros', error.message)
  } catch (e) {
    console.error('registrarErro: exceção ao gravar olivia_erros', e instanceof Error ? e.message : e)
  }
}
