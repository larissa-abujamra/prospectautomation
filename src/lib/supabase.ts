import { createClient } from '@supabase/supabase-js'

// Lê as credenciais do ambiente (Vite expõe só variáveis com prefixo VITE_).
// Os valores ficam em .env.local — ver .env.example. NUNCA hardcodar chaves aqui.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Faltam as variáveis VITE_SUPABASE_URL e/ou VITE_SUPABASE_ANON_KEY. ' +
      'Copie .env.example para .env.local e preencha com os valores do painel do Supabase.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
