// _shared/rate_limit.ts — cliente do primitivo atômico de rate-limit (migration 0013).
// =============================================================================
// Janela deslizante por "bucket", consumida de forma atômica no Postgres
// (pg_advisory_xact_lock na RPC rate_limit_consume). Use para qualquer ação com
// custo/abuso: teto diário de WhatsApp, loop-breaker do responder da Olivia, etc.
//
//   const ok = await consumeRateLimit(supabase, 'wa:send:daily', 20, 86400)
//   if (!ok) return json({ error: 'teto atingido' }, 429)
//
// Buckets sugeridos:
//   'wa:send:daily'            max=20  janela=86400  (warm-up do número Meta)
//   `olivia:reply:${phone}`    max=5   janela=3600   (por contato — anti-loop)
//   'olivia:reply:global'      max=120 janela=3600   (teto global do responder)
// =============================================================================

// Tipagem mínima: só precisamos do .rpc() (evita acoplar à versão do SDK).
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>
}

/**
 * Consome 1 slot do bucket dentro da janela. Retorna true se havia slot (e
 * registra o consumo), false se estourou o teto.
 *
 * FAIL-CLOSED: se a RPC falhar (erro de rede/DB ou retorno inesperado),
 * retorna false. Para uma trava anti-custo, "não sei → não gasta" é o lado
 * seguro: melhor segurar um envio do que furar o teto por um erro transitório.
 */
export async function consumeRateLimit(
  supabase: RpcClient,
  bucket: string,
  max: number,
  windowSecs: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('rate_limit_consume', {
    p_bucket: bucket,
    p_max: max,
    p_window_secs: windowSecs,
  })
  if (error) {
    console.error(`[rate_limit] RPC falhou para bucket="${bucket}": ${error.message}`)
    return false
  }
  return data === true
}
