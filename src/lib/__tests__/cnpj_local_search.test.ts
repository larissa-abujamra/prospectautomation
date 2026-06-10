import { describe, it, expect } from 'vitest'
import { buscarCnpjLocal } from '../../../supabase/functions/_shared/cnpj_local_search.ts'

// Cliente RPC falso (sem rede) — testa o contrato do módulo.
const fakeClient = (impl: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) => ({
  rpc: (fn: string, args: Record<string, unknown>) => Promise.resolve(impl(fn, args)),
})

describe('buscarCnpjLocal', () => {
  it('chama a RPC certa com nome+município e devolve as linhas', async () => {
    let seen: Record<string, unknown> = {}
    const client = fakeClient((fn, args) => {
      seen = { fn, ...args }
      return { data: [{ cnpj: '12345678000195', nome_fantasia: 'X', sim: 0.7 }], error: null }
    })
    const out = await buscarCnpjLocal(client, 'Padoca do Gael', 'São Paulo')
    expect(seen.fn).toBe('buscar_cnpj_local')
    expect(seen.p_nome).toBe('Padoca do Gael')
    expect(seen.p_municipio).toBe('São Paulo')
    expect(out).toHaveLength(1)
    expect(out[0].cnpj).toBe('12345678000195')
  })

  it('nome curto (<3) → [] sem chamar a RPC (trigrama não discrimina)', async () => {
    let called = false
    const client = fakeClient(() => { called = true; return { data: [], error: null } })
    expect(await buscarCnpjLocal(client, 'ze', 'São Paulo')).toEqual([])
    expect(called).toBe(false)
  })

  it('erro da RPC → [] (degrada pro SERP)', async () => {
    const client = fakeClient(() => ({ data: null, error: { message: 'boom' } }))
    expect(await buscarCnpjLocal(client, 'Qualquer Nome', null)).toEqual([])
  })

  it('data não-array → []', async () => {
    const client = fakeClient(() => ({ data: { nope: true }, error: null }))
    expect(await buscarCnpjLocal(client, 'Qualquer Nome', null)).toEqual([])
  })
})
