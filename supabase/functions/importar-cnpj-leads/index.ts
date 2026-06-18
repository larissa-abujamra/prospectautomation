// Edge Function: importar-cnpj-leads
// =============================================================================
// BREADTH GRÁTIS: puxa empresas do índice local da Receita (cnpj_index, carregado
// por scripts/load-rf-cnpj.mjs) para a tabela `leads`, filtrando por UF + setor
// (prefixos de CNAE) [+ município] [+ situação ATIVA]. Sem custo de Places: a
// lista de empresas já está no banco. Os leads entram CRUS (origem 'rf_cnpj',
// status 'descoberto', whatsapp 'pending') e seguem para descoberta/enriquecimento.
//
// Dedup por CNPJ (não re-insere quem já está na base). Índice vazio (antes do
// ETL) → inserted 0, sem erro. Auth: usuário logado. Deploy --no-verify-jwt.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireAuthenticatedUser } from '../_shared/auth.ts'
import { norm } from '../_shared/busca_setor.ts'
import { sanitizarCnaePrefixos, setorParaCnae } from '../_shared/cnae_setor.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const PAGINA = 1000

interface CnpjRow {
  cnpj: string
  razao_social: string | null
  nome_fantasia: string | null
  municipio: string | null
  uf: string | null
  bairro: string | null
  telefone: string | null
  cnae: string | null
  socios: { nome: string | null; qualificacao: string | null }[] | null
}

// Dono = administrador no QSA; senão, sócio único; senão, null. (LGPD: já é só
// nome+qualificação no índice.)
function donoDe(socios: CnpjRow['socios']): string | null {
  const s = (socios ?? []).filter((x) => x?.nome)
  const admin = s.find((x) => /administrador/i.test(x.qualificacao ?? ''))
  if (admin?.nome) return admin.nome
  if (s.length === 1 && s[0].nome) return s[0].nome
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  if (!(await requireAuthenticatedUser(req))) return json({ error: 'Autenticação obrigatória.' }, 401)

  let uf: string, municipio: string | null, setor: string
  let cnaePrefixos: string[], max: number, somenteAtivas: boolean
  try {
    const b = await req.json()
    uf = String(b.uf ?? '').toUpperCase().trim()
    municipio = String(b.municipio ?? '').trim() || null
    setor = String(b.setor ?? '').trim()
    cnaePrefixos = sanitizarCnaePrefixos(b.cnaePrefixos)
    if (cnaePrefixos.length === 0) cnaePrefixos = setorParaCnae(setor)
    max = Math.min(Math.max(Number(b.max) || 1000, 1), 10000)
    somenteAtivas = b.somenteAtivas !== false // default true
    if (!uf) return json({ error: 'Informe a UF.' }, 400)
    if (cnaePrefixos.length === 0) {
      return json({ error: 'Setor sem CNAE conhecido — informe cnaePrefixos.' }, 400)
    }
  } catch {
    return json({ error: 'Corpo inválido (esperado JSON).' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const orCnae = cnaePrefixos.map((p) => `cnae.like.${p}*`).join(',')
  const setorLabel = setor || null

  try {
    let scanned = 0
    let inserted = 0
    let skippedExisting = 0
    let offset = 0

    while (scanned < max) {
      const lote = Math.min(PAGINA, max - scanned)
      let q = supabase
        .from('cnpj_index')
        .select('cnpj, razao_social, nome_fantasia, municipio, uf, bairro, telefone, cnae, socios')
        .eq('uf', uf)
        .or(orCnae)
        .range(offset, offset + lote - 1)
      if (municipio) q = q.eq('municipio', norm(municipio))
      if (somenteAtivas) q = q.eq('situacao', 'ATIVA')

      const { data, error } = await q
      if (error) throw error
      const rows = (data ?? []) as CnpjRow[]
      if (rows.length === 0) break
      scanned += rows.length
      offset += rows.length

      // Dedup por CNPJ contra a base.
      const cnpjs = rows.map((r) => r.cnpj).filter(Boolean)
      const existentes = new Set<string>()
      for (let i = 0; i < cnpjs.length; i += 200) {
        const { data: ex } = await supabase
          .from('leads').select('cnpj').in('cnpj', cnpjs.slice(i, i + 200))
        for (const e of ex ?? []) if (e.cnpj) existentes.add(e.cnpj as string)
      }

      const novos = rows
        .filter((r) => r.cnpj && !existentes.has(r.cnpj))
        .map((r) => ({
          nome: r.nome_fantasia || r.razao_social || `CNPJ ${r.cnpj}`,
          razao_social: r.razao_social,
          cnpj: r.cnpj,
          dono_nome: donoDe(r.socios),
          socios: r.socios ?? null,
          cidade: r.municipio,
          bairro: r.bairro,
          telefone: r.telefone,
          setor: setorLabel,
          origem: 'rf_cnpj',
          whatsapp_status: 'pending',
          status: 'descoberto',
        }))
      skippedExisting += rows.length - novos.length

      if (novos.length > 0) {
        const { error: insErr } = await supabase.from('leads').insert(novos)
        if (insErr) throw insErr
        inserted += novos.length
      }
      if (rows.length < lote) break // acabou o índice
    }

    return json({ uf, municipio, cnae: cnaePrefixos, scanned, inserted, skipped_existing: skippedExisting })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, 502)
  }
})
