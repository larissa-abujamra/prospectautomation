import { describe, it, expect, vi } from 'vitest'
import { fetchLeads } from '../fetchLeads'
import type { Lead } from '../types'

// Builder fake do supabase-js: encadeia from→select→neq→order→range e resolve
// no range. Cada chamada de range devolve a "página" da vez (FIFO).
function fakeClient(paginas: Partial<Lead>[][]) {
  const calls: { neq?: [string, string]; range?: [number, number] } = {}
  let i = 0
  const builder = {
    select: () => builder,
    neq: (col: string, val: string) => {
      calls.neq = [col, val]
      return builder
    },
    order: () => builder,
    range: (from: number, to: number) => {
      calls.range = [from, to]
      const data = paginas[i] ?? []
      i++
      return Promise.resolve({ data, error: null })
    },
  }
  const client = { from: () => builder }
  return { client, calls, paginasPedidas: () => i }
}

const lote = (n: number): Partial<Lead>[] =>
  Array.from({ length: n }, (_, k) => ({ id: `L${k}`, status: 'qualificado' as const }))

describe('fetchLeads', () => {
  it('uma página só (<1000): para sem pedir a próxima', async () => {
    const { client, paginasPedidas } = fakeClient([lote(42)])
    const r = await fetchLeads(client as never)
    expect(r).toHaveLength(42)
    expect(paginasPedidas()).toBe(1)
  })

  it('pagina além de 1000: junta os blocos até esgotar (fim da truncagem silenciosa)', async () => {
    // 1000 + 1000 + 250 = 2250 → 3 páginas, depois para
    const { client, paginasPedidas } = fakeClient([lote(1000), lote(1000), lote(250)])
    const r = await fetchLeads(client as never)
    expect(r).toHaveLength(2250)
    expect(paginasPedidas()).toBe(3)
  })

  it('exclui descartado server-side (decisão de funil: fica no banco, fora da visão ativa)', async () => {
    const { client, calls } = fakeClient([lote(0)])
    await fetchLeads(client as never)
    expect(calls.neq).toEqual(['status', 'descartado'])
  })

  it('propaga erro do supabase', async () => {
    const builder = {
      select: () => builder,
      neq: () => builder,
      order: () => builder,
      range: () => Promise.resolve({ data: null, error: new Error('PostgREST 500') }),
    }
    const client = { from: () => builder }
    await expect(fetchLeads(client as never)).rejects.toThrow('PostgREST 500')
  })
})
