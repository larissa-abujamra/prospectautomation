import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const buscarSource = readFileSync(resolve(__dirname, '../Buscar.tsx'), 'utf8')

describe('Buscar Squad Leads placement', () => {
  it('exposes the Squad Leads learning sync entry point on the practical lead workflow', () => {
    expect(buscarSource).toContain("import { InboundSquadLeadsPanel }")
    expect(buscarSource).toContain('<InboundSquadLeadsPanel leads={leads} />')
  })
})
