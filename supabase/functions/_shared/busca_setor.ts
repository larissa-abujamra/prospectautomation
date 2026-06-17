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

// Taxonomia por família de setor: cada entrada casa por substring normalizada.
// `expandirTermosBusca` mantém o legado de máx. 3 termos; o backend usa
// `expandirPlanosBusca` para fanout maior, ainda com teto explícito de custo.
type ForcaGoogleType = 'strong' | 'weak' | 'none'

interface FamiliaSetor {
  id: string
  /** Palavras que identificam a família no texto digitado. */
  match: string[]
  /** Termos principais usados no Places (o 1º é o principal da família). */
  termos: string[]
  /** Sinônimos/labels usados só pelo backend de sourcing, quando vale ampliar recall. */
  variantes?: string[]
  /** Tipo do Places API (New, Table A) usado como viés de categoria. */
  googleType: string | null
  /** Evita depender cegamente de includedType quando a taxonomia é fraca/ampla. */
  googleTypeForca: ForcaGoogleType
}

const FAMILIAS: FamiliaSetor[] = [
  {
    id: 'doces',
    match: ['confeitaria', 'doceria', 'doces', 'bolo'],
    termos: ['confeitaria', 'doceria', 'bolos e doces artesanais'],
    variantes: ['loja de doces', 'bolos artesanais', 'cake shop'],
    googleType: 'confectionery',
    googleTypeForca: 'weak',
  },
  {
    id: 'cafeteria',
    match: ['cafeteria', 'cafe', 'coffee'],
    termos: ['cafeteria', 'cafe especial'],
    variantes: ['coffee shop', 'cafeteria com doces'],
    googleType: 'cafe',
    googleTypeForca: 'strong',
  },
  {
    id: 'pizzaria',
    match: ['pizza'],
    termos: ['pizzaria', 'pizza artesanal'],
    variantes: ['delivery de pizza'],
    googleType: 'pizza_restaurant',
    googleTypeForca: 'strong',
  },
  {
    id: 'hamburgueria',
    match: ['burger', 'burguer', 'hamburg', 'smash'],
    termos: ['hamburgueria', 'hamburguer artesanal'],
    variantes: ['smash burger'],
    googleType: 'hamburger_restaurant',
    googleTypeForca: 'strong',
  },
  {
    id: 'restaurante',
    match: ['restaurante'],
    termos: ['restaurante'],
    variantes: ['comida caseira', 'restaurante brasileiro'],
    googleType: 'restaurant',
    googleTypeForca: 'weak',
  },
  {
    // 'pet' sozinho casaria "petiscaria" — só formas inequívocas do segmento.
    id: 'pet_shop',
    match: ['pet shop', 'petshop', 'pet store', 'petstore'],
    termos: ['pet shop', 'loja de produtos para animais'],
    variantes: ['pet store'],
    googleType: 'pet_store',
    googleTypeForca: 'strong',
  },
  {
    id: 'academia',
    match: ['academia', 'fitness', 'crossfit'],
    termos: ['academia', 'estudio fitness'],
    variantes: ['centro de treinamento', 'crossfit'],
    googleType: 'gym',
    googleTypeForca: 'strong',
  },
  {
    id: 'barbearia',
    match: ['barbearia', 'barbeiro', 'barber'],
    termos: ['barbearia', 'barbeiro'],
    variantes: ['barber shop'],
    googleType: 'barber_shop',
    googleTypeForca: 'strong',
  },
  {
    id: 'beleza',
    match: ['salao', 'beleza', 'cabeleireiro'],
    termos: ['salao de beleza', 'cabeleireiro'],
    variantes: ['hair salon'],
    googleType: 'beauty_salon',
    googleTypeForca: 'strong',
  },
  {
    id: 'floricultura',
    match: ['floricultura', 'flores', 'florista'],
    termos: ['floricultura', 'loja de flores'],
    googleType: 'florist',
    googleTypeForca: 'strong',
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

export interface PlanoBuscaSetor {
  termo: string
  includedType: string | null
  localizacao?: string
  modoLocalizacao?: ModoLocalizacaoBusca
  textQuery?: string
}

export const MAX_PLANOS_BUSCA = 8
const MAX_TERMOS_BACKEND = 5

export type ModoLocalizacaoBusca = 'em' | 'perto_de'

function termosFamilia(digitado: string, fam: FamiliaSetor): string[] {
  const out: string[] = []
  const vistos = new Set<string>()
  for (const t of [norm(digitado), ...fam.termos, ...(fam.variantes ?? [])]) {
    const n = norm(t)
    if (vistos.has(n)) continue
    vistos.add(n)
    out.push(n)
  }
  return out
}

function termosBackend(digitado: string, fam: FamiliaSetor | null): string[] {
  if (!fam) return [digitado]
  return termosFamilia(digitado, fam).slice(0, MAX_TERMOS_BACKEND)
}

function normalizarLocalizacao(localizacao: string): string {
  return localizacao.replace(/\s+/g, ' ').trim()
}

function variantesLocalizacao(localizacao?: string): { localizacao: string; modo: ModoLocalizacaoBusca }[] {
  const loc = normalizarLocalizacao(localizacao ?? '')
  if (!loc) return []

  const out: { localizacao: string; modo: ModoLocalizacaoBusca }[] = [{ localizacao: loc, modo: 'em' }]
  const partes = loc.split(',').map((p) => p.trim()).filter(Boolean)
  if (partes.length >= 2) {
    out.push({ localizacao: `${partes[0]}, ${partes[1]}`, modo: 'em' })
  }
  out.push({ localizacao: loc, modo: 'perto_de' })

  const vistos = new Set<string>()
  return out.filter((v) => {
    const key = `${norm(v.localizacao)}|${v.modo}`
    if (vistos.has(key)) return false
    vistos.add(key)
    return true
  })
}

/**
 * Planos efetivos para o backend de sourcing. O fanout é genérico: termo
 * digitado, sinônimos/labels da família, variações de "em/perto de" e versões
 * bairro+cidade quando o local veio segmentado. `includedType` entra só para
 * famílias marcadas como strong; em setores fracos/amplos, texto amplo rende
 * mais recall.
 */
export function expandirPlanosBusca(setor: string, localizacao?: string): PlanoBuscaSetor[] {
  const digitado = setor.trim()
  if (!digitado) return []
  const fam = familiaDe(digitado)
  const termos = termosBackend(digitado, fam)
  const locais = variantesLocalizacao(localizacao)
  const localPrimario = locais[0]
  const includedType = fam?.googleTypeForca === 'strong' ? fam.googleType : null
  const candidatos: PlanoBuscaSetor[] = []

  for (const [i, termo] of termos.entries()) {
    if (includedType && i < 3) {
      candidatos.push({
        termo,
        includedType,
        localizacao: localPrimario?.localizacao,
        modoLocalizacao: localPrimario?.modo,
      })
    }
    candidatos.push({
      termo,
      includedType: null,
      localizacao: localPrimario?.localizacao,
      modoLocalizacao: localPrimario?.modo,
    })
  }

  // Variações de local são sempre textuais e sem includedType para aumentar
  // recall sem multiplicar o viés de taxonomia do Google.
  for (const local of locais.slice(1)) {
    for (const termo of termos.slice(0, 2)) {
      candidatos.push({
        termo,
        includedType: null,
        localizacao: local.localizacao,
        modoLocalizacao: local.modo,
      })
    }
  }

  const vistos = new Set<string>()
  return candidatos.filter((p) => {
    const query = p.localizacao ? montarQuery(p.termo, p.localizacao, p.modoLocalizacao) : undefined
    const key = `${p.termo}|${p.includedType ?? ''}|${query ?? ''}`
    if (vistos.has(key)) return false
    vistos.add(key)
    if (query) p.textQuery = query
    return true
  }).slice(0, MAX_PLANOS_BUSCA)
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

/** textQuery do Places: "<termo> em <localização>" ou "<termo> perto de <localização>". */
export function montarQuery(
  termo: string,
  localizacao: string,
  modo: ModoLocalizacaoBusca = 'em',
): string {
  return `${termo} ${modo === 'perto_de' ? 'perto de' : 'em'} ${localizacao}`
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
