import { describe, it, expect, vi } from 'vitest'
import { consumeRateLimit } from '../../../supabase/functions/_shared/rate_limit'

// Mock mínimo do client: só o .rpc() interessa.
const clientWith = (impl: (fn: string, args: Record<string, unknown>) => unknown) => ({
  rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => impl(fn, args) as never),
})

describe('consumeRateLimit', () => {
  it('chama a RPC rate_limit_consume com os argumentos corretos', async () => {
    const client = clientWith(() => ({ data: true, error: null }))
    await consumeRateLimit(client, 'wa:send:daily', 20, 86400)
    expect(client.rpc).toHaveBeenCalledWith('rate_limit_consume', {
      p_bucket: 'wa:send:daily',
      p_max: 20,
      p_window_secs: 86400,
    })
  })

  it('retorna true quando há slot (data === true)', async () => {
    const client = clientWith(() => ({ data: true, error: null }))
    expect(await consumeRateLimit(client, 'b', 5, 60)).toBe(true)
  })

  it('retorna false quando o teto estourou (data === false)', async () => {
    const client = clientWith(() => ({ data: false, error: null }))
    expect(await consumeRateLimit(client, 'b', 5, 60)).toBe(false)
  })

  it('FAIL-CLOSED: retorna false quando a RPC erra (não gasta no escuro)', async () => {
    const client = clientWith(() => ({ data: null, error: { message: 'connection reset' } }))
    expect(await consumeRateLimit(client, 'b', 5, 60)).toBe(false)
  })

  it('FAIL-CLOSED: retorno inesperado (não-boolean) também é false', async () => {
    const client = clientWith(() => ({ data: 'sim', error: null }))
    expect(await consumeRateLimit(client, 'b', 5, 60)).toBe(false)
  })
})
