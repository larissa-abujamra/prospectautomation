// Geração de candidatos a CNPJ pelo ÍNDICE LOCAL da Receita (tabela cnpj_index,
// carregada em lote — ver scripts/load-rf-cnpj.mjs). Pesquisa por trigrama no
// nome via a RPC buscar_cnpj_local.
// =============================================================================
// É a fonte PRIMÁRIA de candidatos: resolve nomes que o Google/SERP não acha
// (curtos/genéricos — a maior causa de CNPJ em branco) com UMA query no banco,
// sem Scrapingdog. Os dados já são oficiais → quem chama pula a confirmação e
// vai direto ao score. Índice vazio (antes do ETL) → [] (degrada pro SERP).
// =============================================================================

export interface LocalCnpj {
  cnpj: string
  razao_social: string | null
  nome_fantasia: string | null
  cep: string | null
  municipio: string | null
  uf: string | null
  bairro: string | null
  situacao: string | null
  cnae: string | null
  telefone: string | null
  porte: string | null
  mei: boolean | null
  socios: { nome: string | null; qualificacao: string | null }[] | null
  sim: number
}

// Cliente mínimo (evita acoplar ao tipo do supabase-js neste _shared).
interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>
}

export async function buscarCnpjLocal(
  supabase: RpcClient,
  nome: string,
  cidade: string | null,
  limit = 8,
): Promise<LocalCnpj[]> {
  const q = (nome ?? '').trim()
  if (q.length < 3) return [] // nome curto demais → trigrama não discrimina
  try {
    const { data, error } = await supabase.rpc('buscar_cnpj_local', {
      p_nome: q,
      p_municipio: cidade ?? null,
      p_limit: limit,
    })
    if (error || !Array.isArray(data)) return []
    return data as LocalCnpj[]
  } catch {
    return []
  }
}
