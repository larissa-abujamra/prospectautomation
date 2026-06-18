// Mapa setor → CNAE (prefixos) para a busca em massa via índice da Receita.
// =============================================================================
// Parte PURA (sem I/O), unit-testada. Usada por `importar-cnpj-leads` para
// traduzir o setor digitado (ex.: "doceria") nos prefixos de CNAE que o
// `cnpj_index` (carregado da Receita) usa para filtrar empresas daquele segmento.
//
// Prefixos (não código completo): casam por `cnae like 'PREFIXO%'`. Ver os CNAEs
// usados pelo ETL (scripts/load-rf-cnpj.mjs). Imperfeito por natureza (CNAE ≠
// exatamente a taxonomia do app), mas pega o grosso do segmento.
// =============================================================================

import { norm } from './busca_setor.ts'

interface MapaCnae {
  match: string[]
  cnae: string[]
}

// Ordem importa: o 1º match casa. Prefixos RF (7 díg) sem máscara.
const SETOR_CNAE: MapaCnae[] = [
  // padaria/confeitaria/doces (varejo 4721) + panificação/confeitaria (indústria 1091)
  { match: ['confeitaria', 'doceria', 'doces', 'bolo', 'padaria', 'panificad', 'cake'], cnae: ['4721', '1091'] },
  // cafeterias/casas de chá/sucos (lanchonete 5611)
  { match: ['cafeteria', 'cafe', 'coffee'], cnae: ['5611'] },
  // restaurantes/lanchonetes/bares + buffet/cantina/catering
  { match: ['pizza', 'hamburg', 'burger', 'burguer', 'smash', 'restaurante', 'lanchonete', 'bar ', 'comida', 'buffet', 'marmita'], cnae: ['5611', '5620'] },
  // pet shop / artigos e animais
  { match: ['pet shop', 'petshop', 'pet store', 'petstore', 'animal'], cnae: ['4789'] },
  // academia / fitness
  { match: ['academia', 'fitness', 'crossfit', 'pilates'], cnae: ['9313'] },
  // barbearia / salão / beleza
  { match: ['barbearia', 'barbeiro', 'barber', 'salao', 'beleza', 'cabelei', 'estetica'], cnae: ['9602'] },
  // floricultura / flores
  { match: ['floricultura', 'flores', 'florista'], cnae: ['4789'] },
]

/**
 * Prefixos de CNAE para um setor digitado. Setor desconhecido → [] (o caller
 * exige CNAE explícito; nunca varre o índice inteiro por engano).
 */
export function setorParaCnae(setor: string | null | undefined): string[] {
  const s = norm(setor ?? '')
  if (!s) return []
  const fam = SETOR_CNAE.find((f) => f.match.some((m) => s.includes(m)))
  return fam ? [...fam.cnae] : []
}

/** Saneia prefixos de CNAE vindos do cliente (só dígitos, 2–7 chars). */
export function sanitizarCnaePrefixos(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? String(raw).split(',') : []
  const out: string[] = []
  for (const p of arr) {
    const d = String(p).replace(/\D/g, '')
    if (d.length >= 2 && d.length <= 7) out.push(d)
  }
  return [...new Set(out)]
}
