// Busca inteligente por setor (módulo de sourcing).
// =============================================================================
// Partes PURAS (sem I/O), unit-testadas no Vitest e usadas pela Edge Function
// `buscar-negocios`.
//
// PROBLEMA QUE RESOLVE: buscar só o termo literal ("confeitaria") deixa de fora
// negócios do mesmo segmento com outro nome ("doceria", "bolos artesanais").
// Aqui o setor vira (1) uma lista de termos sinônimos pesquisados em sequência
// (dedup por place_id no caller) e (2) um tipo do Google Places (New API,
// `includedType` com strictTypeFiltering=false: viés de categoria, não filtro
// duro, então não esconde resultado válido).
//
// CIDADE: a busca não é mais presa a São Paulo. `montarQuery` recebe a cidade
// (default São Paulo só por compatibilidade com chamadas antigas).
// =============================================================================

export const norm = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

// Sinônimos por família de setor: cada entrada casa por substring normalizada.
// Máx. 3 termos por setor (cada termo = 1 chamada paga ao Places).
interface FamiliaSetor {
  /** Palavras que identificam a família no texto digitado. */
  match: string[]
  /** Termos de busca usados no Places (o 1º é o principal). */
  termos: string[]
  /** Tipo do Places API (New, Table A) usado como viés de categoria. */
  googleType: string | null
}

const FAMILIAS: FamiliaSetor[] = [
  {
    match: ['confeitaria', 'doceria', 'doces', 'bolo'],
    termos: ['confeitaria', 'doceria', 'bolos e doces artesanais'],
    googleType: 'confectionery',
  },
  {
    match: ['cafeteria', 'cafe', 'coffee'],
    termos: ['cafeteria', 'cafe especial', 'coffee shop'],
    googleType: 'cafe',
  },
  {
    match: ['pizza'],
    termos: ['pizzaria', 'pizza artesanal'],
    googleType: 'pizza_restaurant',
  },
  {
    match: ['burger', 'burguer', 'hamburg', 'smash'],
    termos: ['hamburgueria', 'hamburguer artesanal'],
    googleType: 'hamburger_restaurant',
  },
  {
    match: ['restaurante'],
    termos: ['restaurante'],
    googleType: 'restaurant',
  },
  {
    // 'pet' sozinho casaria "petiscaria" — só formas inequívocas do segmento.
    match: ['pet shop', 'petshop', 'pet store', 'petstore'],
    termos: ['pet shop', 'loja de produtos para animais'],
    googleType: 'pet_store',
  },
  {
    match: ['academia', 'fitness', 'crossfit'],
    termos: ['academia', 'estudio fitness'],
    googleType: 'gym',
  },
  {
    match: ['salao', 'beleza', 'cabeleireiro', 'barbearia'],
    termos: ['salao de beleza', 'cabeleireiro'],
    googleType: 'beauty_salon',
  },
  {
    match: ['floricultura', 'flores', 'florista'],
    termos: ['floricultura', 'loja de flores'],
    googleType: 'florist',
  },
]

function familiaDe(setor: string): FamiliaSetor | null {
  const s = norm(setor)
  if (!s) return null
  return FAMILIAS.find((f) => f.match.some((m) => s.includes(m))) ?? null
}

/**
 * Expande o setor digitado em termos de busca (sinônimos do segmento). O termo
 * do usuário vai SEMPRE primeiro (respeita a intenção); os sinônimos da família
 * ampliam o alcance. Setor desconhecido → só o próprio termo (nunca inventa
 * segmento). O caller roda um searchText por termo e dedupa por place_id.
 */
export function expandirTermosBusca(setor: string): string[] {
  const digitado = setor.trim()
  if (!digitado) return []
  const fam = familiaDe(digitado)
  if (!fam) return [digitado]
  // Termos de família saem normalizados (Google é case-insensitive) e dedupados.
  const out: string[] = []
  const vistos = new Set<string>()
  for (const t of [norm(digitado), ...fam.termos]) {
    const n = norm(t)
    if (vistos.has(n)) continue
    vistos.add(n)
    out.push(n)
  }
  return out.slice(0, 3)
}

/** Tipo do Google Places usado como viés de categoria (null = sem viés). */
export function googleTypeDe(setor: string): string | null {
  return familiaDe(setor)?.googleType ?? null
}

/**
 * Resolve a localização da busca. `local` (descrição completa escolhida no
 * autocomplete, ex.: "Alta Floresta, MT, Brasil") tem precedência: já vem
 * desambiguada. Fallback: bairro + cidade dos campos antigos (cidade default
 * São Paulo só por compatibilidade com chamadas antigas).
 */
export function resolverLocal(opts: {
  local?: string | null
  bairro?: string | null
  cidade?: string | null
}): string {
  const l = opts.local?.trim()
  if (l) return l
  const c = opts.cidade?.trim() || 'São Paulo'
  const b = opts.bairro?.trim()
  return b ? `${b}, ${c}` : c
}

/** textQuery do Places: "<termo> em <localização>". */
export function montarQuery(termo: string, localizacao: string): string {
  return `${termo} em ${localizacao}`
}

// --- Classificação de resultado (movida do buscar-negocios p/ ser testável) ---

const PIZZA_WORDS = ['pizza', 'pizzaria']
const BURGER_WORDS = ['burger', 'burguer', 'hamburg', 'hamburgueria', 'smash']

/** Termo buscado é da "família restaurante"? (aí classificamos cada resultado) */
export function ehFamiliaRestaurante(setor: string): boolean {
  const s = norm(setor)
  return (
    s.includes('restaurante') ||
    PIZZA_WORDS.some((w) => s.includes(w)) ||
    BURGER_WORDS.some((w) => s.includes(w))
  )
}

/** Classifica um resultado: tipo do Places (v1) → palavra no nome → catch-all. */
export function classificarSetor(nome: string, primaryType?: string): string {
  if (primaryType === 'pizza_restaurant') return 'Pizzaria'
  if (primaryType === 'hamburger_restaurant') return 'Hamburgueria'
  const n = norm(nome)
  if (PIZZA_WORDS.some((w) => n.includes(w))) return 'Pizzaria'
  if (BURGER_WORDS.some((w) => n.includes(w))) return 'Hamburgueria'
  return 'Restaurante'
}
