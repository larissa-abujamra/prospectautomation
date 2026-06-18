#!/usr/bin/env node
// =============================================================================
// load-rf-cnpj.mjs — carrega o ÍNDICE LOCAL de CNPJ (tabela cnpj_index) a partir
// da base ABERTA da Receita Federal (Dados Abertos CNPJ), filtrada a São Paulo.
// =============================================================================
// Por quê: a geração de candidatos por NOME via Google/SERP falha em nomes
// curtos/genéricos (maior causa de CNPJ em branco). Com a base da Receita local,
// o match vira uma busca por trigrama no banco — determinística, grátis, instantânea.
//
// O que faz:
//   1) Baixa os ZIPs da Receita (Estabelecimentos 0-9, Empresas 0-9, Socios 0-9,
//      Simples, Municipios) de https://arquivos.receitafederal.gov.br/dados/cnpj/...
//   2) Faz streaming dos CSVs (latin1, ';'-delimitado, sem header).
//   3) FILTRA estabelecimentos por UF=SP (e, por padrão, município=SÃO PAULO).
//   4) Junta razão/porte (Empresas), QSA (Socios, só nome+qualificação — LGPD),
//      MEI (Simples) pela raiz do CNPJ (8 primeiros dígitos), e resolve o código
//      do município → nome (Municipios).
//   5) Bulk-upsert em public.cnpj_index (lotes de 1000) com nome_busca normalizado.
//
// Uso (numa máquina com banda/disco — NÃO roda em serverless):
//   npm i adm-zip csv-parse @supabase/supabase-js
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/load-rf-cnpj.mjs --uf SP --municipio "SAO PAULO" [--ref AAAA-MM] [--cnae 4721,1091,5611,5620]
//   # ESTADO INTEIRO, só setores de alimentação/doces (recomendado p/ prospecção):
//   node scripts/load-rf-cnpj.mjs --uf SP --municipio "" --cnae 4721,1091,5611,5620
//   # outro setor: passe os prefixos de CNAE (ex.: pet shop --cnae 4789)
//   # TODOS os CNAEs (volume enorme): --cnae ""
//
// Requisitos: Node 20+, ~10GB de disco temporário, unzip via `yauzl`/`adm-zip`
// (instale: npm i adm-zip csv-parse @supabase/supabase-js). Roda em ~horas.
// Idempotente: re-rodar atualiza (upsert por cnpj).
// =============================================================================

import { createReadStream, createWriteStream, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import os from 'node:os'
import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse'
import AdmZip from 'adm-zip'

const RF_BASE = 'https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj'
const TMP = path.join(os.tmpdir(), 'rf-cnpj')
const BATCH = 1000

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const UF = (arg('uf', 'SP')).toUpperCase()
const MUNICIPIO = arg('municipio', 'SAO PAULO') // nome normalizado; '' = toda a UF
const REF = arg('ref', '') // AAAA-MM; vazio = descobre o mais recente no índice

// FILTRO POR CNAE (setor): sem isto, um estado inteiro traz MILHÕES de empresas
// (todo CNAE) e estoura memória/banco. Com prefixos de CNAE, carregamos só os
// setores-alvo da prospecção — dezenas de milhares por estado, relevantes.
// Passe --cnae "" para carregar TODOS os CNAEs (cuidado com volume).
// Default: alimentação/doces (docerias, confeitarias, padarias, cafés,
// restaurantes, lanchonetes, bares, buffets). CNAEs RF (7 díg, sem máscara):
//   4721 = padaria/confeitaria/doces (varejo)   1091 = panificação/confeitaria (indústria)
//   5611 = restaurantes/lanchonetes/bares/cafés  5620 = buffet/cantina/catering
// Para outros setores (pet/beleza/academia…), passe os prefixos certos via --cnae.
const CNAE_DEFAULT = '4721,1091,5611,5620'
const CNAE_PREFIXOS = arg('cnae', CNAE_DEFAULT)
  .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean)

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltam env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const norm = (s) =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const onlyDigits = (s) => (s ?? '').replace(/\D/g, '')

// --- download + unzip de um arquivo da Receita -------------------------------
async function baixar(nomeZip, refDir) {
  mkdirSync(TMP, { recursive: true })
  const zipPath = path.join(TMP, nomeZip)
  if (!existsSync(zipPath)) {
    const url = `${RF_BASE}/${refDir}/${nomeZip}`
    console.log('baixando', url)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`download ${nomeZip}: HTTP ${resp.status}`)
    await pipeline(resp.body, createWriteStream(zipPath))
  }
  const zip = new AdmZip(zipPath)
  const entry = zip.getEntries()[0]
  const csvPath = path.join(TMP, nomeZip.replace(/\.zip$/i, '.csv'))
  if (!existsSync(csvPath)) zip.extractEntryTo(entry, TMP, false, true, false, path.basename(csvPath))
  return csvPath
}

// stream genérico de um CSV da Receita (latin1, ';'-delim, aspas), por linha.
async function* linhasCsv(csvPath) {
  const parser = createReadStream(csvPath, { encoding: 'latin1' })
    .pipe(parse({ delimiter: ';', quote: '"', relax_column_count: true }))
  for await (const row of parser) yield row
}

async function carregar() {
  const refDir = REF || await descobrirRefMaisRecente()
  console.log(`Receita ref=${refDir} | filtro UF=${UF} municipio="${MUNICIPIO}"`)

  // 1) Municipios: código → nome
  const munCsv = await baixar('Municipios.zip', refDir)
  const munNome = new Map()
  for await (const [cod, nome] of linhasCsv(munCsv)) munNome.set(cod, nome)
  console.log(`municípios: ${munNome.size}`)

  // 2) Empresas (raiz 8 díg → razão/porte) — só carregamos o que aparecer nos
  //    estabelecimentos filtrados, então primeiro varremos estabelecimentos e
  //    guardamos as raízes; depois lemos Empresas/Socios/Simples filtrando.
  //    (Implementação de referência: 2 passadas. Veja README do script.)
  const wantRaiz = new Set()
  const estabs = []
  for (let i = 0; i < 10; i++) {
    const csv = await baixar(`Estabelecimentos${i}.zip`, refDir)
    for await (const r of linhasCsv(csv)) {
      // layout RF: 0 cnpj_basico,1 ordem,2 dv,3 matriz/filial,4 fantasia,5 situacao,
      // ...,11 municipio(cod),12 cnae?,... (ver layout oficial). Campos por índice:
      const uf = r[19]
      if (uf !== UF) continue
      const munCod = r[20]
      const munNm = munNome.get(munCod) ?? ''
      if (MUNICIPIO && norm(munNm) !== norm(MUNICIPIO)) continue
      // Filtro de setor por CNAE principal (r[11]). Vazio = sem filtro (tudo).
      const cnaePrinc = (r[11] ?? '').replace(/\D/g, '')
      if (CNAE_PREFIXOS.length && !CNAE_PREFIXOS.some((p) => cnaePrinc.startsWith(p))) continue
      const raiz = r[0]
      wantRaiz.add(raiz)
      const cnpj = r[0] + r[1] + r[2]
      const cep = onlyDigits(r[18])
      const ddd = r[21], tel = r[22]
      estabs.push({
        cnpj,
        raiz,
        nome_fantasia: r[4] || null,
        situacao: situacaoTxt(r[5]),
        cnae: r[11] || null, // cnae principal (código; resolvido por tabela CNAE se desejado)
        cep,
        municipio: munNm || null,
        uf,
        bairro: r[17] || null,
        logradouro: [r[13], r[14], r[15]].filter(Boolean).join(' ') || null,
        telefone: ddd && tel ? `${ddd}${tel}` : null,
      })
    }
    console.log(`Estabelecimentos${i}: acumulado ${estabs.length} no filtro`)
  }

  // 3) Empresas → razão/porte (só as raízes que queremos)
  const empresa = new Map()
  for (let i = 0; i < 10; i++) {
    const csv = await baixar(`Empresas${i}.zip`, refDir)
    for await (const r of linhasCsv(csv)) {
      if (!wantRaiz.has(r[0])) continue
      empresa.set(r[0], { razao_social: r[1] || null, porte: porteTxt(r[5]) })
    }
  }

  // 4) Socios → QSA (nome + qualificação; SEM CPF — LGPD)
  const socios = new Map()
  for (let i = 0; i < 10; i++) {
    const csv = await baixar(`Socios${i}.zip`, refDir)
    for await (const r of linhasCsv(csv)) {
      if (!wantRaiz.has(r[0])) continue
      const arr = socios.get(r[0]) ?? []
      arr.push({ nome: r[2] || null, qualificacao: r[3] || null })
      socios.set(r[0], arr)
    }
  }

  // 5) Simples → MEI
  const mei = new Map()
  {
    const csv = await baixar('Simples.zip', refDir)
    for await (const r of linhasCsv(csv)) {
      if (!wantRaiz.has(r[0])) continue
      mei.set(r[0], r[4] === 'S') // opção pelo MEI
    }
  }

  // 6) monta linhas + upsert em lotes
  let buf = []
  let total = 0
  for (const e of estabs) {
    const emp = empresa.get(e.raiz) ?? {}
    const fant = e.nome_fantasia ?? ''
    const raz = emp.razao_social ?? ''
    buf.push({
      cnpj: e.cnpj,
      razao_social: emp.razao_social ?? null,
      nome_fantasia: e.nome_fantasia,
      nome_busca: norm(`${fant} ${raz}`).replace(/\s+/g, ' ').trim(),
      cep: e.cep || null,
      municipio: e.municipio ? norm(e.municipio) : null,
      uf: e.uf,
      bairro: e.bairro,
      logradouro: e.logradouro,
      situacao: e.situacao,
      cnae: e.cnae,
      telefone: e.telefone,
      porte: emp.porte ?? null,
      mei: mei.get(e.raiz) ?? null,
      socios: socios.get(e.raiz) ?? [],
    })
    if (buf.length >= BATCH) { await flush(buf); total += buf.length; buf = []; if (total % 20000 === 0) console.log(`upsert ${total}`) }
  }
  if (buf.length) { await flush(buf); total += buf.length }
  console.log(`PRONTO: ${total} estabelecimentos no índice (UF=${UF}, municipio="${MUNICIPIO}").`)
}

async function flush(rows) {
  const { error } = await supabase.from('cnpj_index').upsert(rows, { onConflict: 'cnpj' })
  if (error) { console.error('upsert falhou:', error.message); process.exit(1) }
}

function situacaoTxt(cod) {
  return ({ '01': 'NULA', '02': 'ATIVA', '03': 'SUSPENSA', '04': 'INAPTA', '08': 'BAIXADA' })[cod] ?? cod ?? null
}
function porteTxt(cod) {
  return ({ '00': 'NÃO INFORMADO', '01': 'MICRO EMPRESA', '03': 'EPP', '05': 'DEMAIS' })[cod] ?? cod ?? null
}
async function descobrirRefMaisRecente() {
  // o índice lista pastas AAAA-MM; pega a última. Fallback: mês corrente.
  try {
    const html = await (await fetch(`${RF_BASE}/`)).text()
    const meses = [...html.matchAll(/(\d{4}-\d{2})\//g)].map((m) => m[1]).sort()
    if (meses.length) return meses[meses.length - 1]
  } catch { /* ignore */ }
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

carregar().catch((e) => { console.error(e); process.exit(1) })
