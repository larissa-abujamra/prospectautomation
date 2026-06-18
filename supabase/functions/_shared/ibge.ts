// Expansão de escopo geográfico (IBGE) para a busca em massa.
// =============================================================================
// Partes PURAS (sem I/O), unit-testadas no Vitest. A Edge Function `scrape-enqueue`
// usa isto para transformar um ESCOPO escolhido pelo usuário ("Estado de SP",
// "Grande Rio", "uma cidade") numa lista de MUNICÍPIOS — um por task da fila.
//
// Estado inteiro: a lista vem da API pública do IBGE (sem chave). Regiões
// metropolitanas: listas curadas (o IBGE não tem "RM" como endpoint simples).
// Cidade única: o próprio termo.
// =============================================================================

export interface UF {
  sigla: string
  nome: string
}

export const UFS: UF[] = [
  { sigla: 'AC', nome: 'Acre' }, { sigla: 'AL', nome: 'Alagoas' },
  { sigla: 'AP', nome: 'Amapá' }, { sigla: 'AM', nome: 'Amazonas' },
  { sigla: 'BA', nome: 'Bahia' }, { sigla: 'CE', nome: 'Ceará' },
  { sigla: 'DF', nome: 'Distrito Federal' }, { sigla: 'ES', nome: 'Espírito Santo' },
  { sigla: 'GO', nome: 'Goiás' }, { sigla: 'MA', nome: 'Maranhão' },
  { sigla: 'MT', nome: 'Mato Grosso' }, { sigla: 'MS', nome: 'Mato Grosso do Sul' },
  { sigla: 'MG', nome: 'Minas Gerais' }, { sigla: 'PA', nome: 'Pará' },
  { sigla: 'PB', nome: 'Paraíba' }, { sigla: 'PR', nome: 'Paraná' },
  { sigla: 'PE', nome: 'Pernambuco' }, { sigla: 'PI', nome: 'Piauí' },
  { sigla: 'RJ', nome: 'Rio de Janeiro' }, { sigla: 'RN', nome: 'Rio Grande do Norte' },
  { sigla: 'RS', nome: 'Rio Grande do Sul' }, { sigla: 'RO', nome: 'Rondônia' },
  { sigla: 'RR', nome: 'Roraima' }, { sigla: 'SC', nome: 'Santa Catarina' },
  { sigla: 'SP', nome: 'São Paulo' }, { sigla: 'SE', nome: 'Sergipe' },
  { sigla: 'TO', nome: 'Tocantins' },
]

const SIGLAS = new Set(UFS.map((u) => u.sigla))
export const ehUF = (s: string): boolean => SIGLAS.has(String(s).toUpperCase().trim())

// Região Metropolitana de São Paulo (39 municípios).
export const GRANDE_SP: string[] = [
  'São Paulo', 'Guarulhos', 'São Bernardo do Campo', 'Santo André', 'Osasco',
  'São Caetano do Sul', 'Diadema', 'Mauá', 'Mogi das Cruzes', 'Carapicuíba',
  'Itaquaquecetuba', 'Suzano', 'Taboão da Serra', 'Barueri', 'Embu das Artes',
  'Itapevi', 'Cotia', 'Itapecerica da Serra', 'Ferraz de Vasconcelos', 'Jandira',
  'Franco da Rocha', 'Ribeirão Pires', 'Poá', 'Caieiras', 'Francisco Morato',
  'Cajamar', 'Embu-Guaçu', 'Várzea Paulista', 'Arujá', 'Santana de Parnaíba',
  'Mairiporã', 'Vargem Grande Paulista', 'Rio Grande da Serra', 'Juquitiba',
  'Guararema', 'Pirapora do Bom Jesus', 'Salesópolis', 'Biritiba Mirim', 'São Lourenço da Serra',
]

// Região Metropolitana do Rio de Janeiro (22 municípios).
export const GRANDE_RIO: string[] = [
  'Rio de Janeiro', 'São Gonçalo', 'Duque de Caxias', 'Nova Iguaçu', 'Niterói',
  'Belford Roxo', 'São João de Meriti', 'Mesquita', 'Nilópolis', 'Queimados',
  'Magé', 'Itaboraí', 'Maricá', 'Itaguaí', 'Japeri', 'Seropédica', 'Guapimirim',
  'Paracambi', 'Tanguá', 'Rio Bonito', 'Cachoeiras de Macacu', 'Mangaratiba',
]

export interface Escopo {
  // 'uf' = estado inteiro (IBGE); 'metro' = região metropolitana curada;
  // 'cidade' = uma cidade/bairro só (texto livre).
  tipo: 'uf' | 'metro' | 'cidade'
  valor: string // 'SP' | 'grande_sp' | 'grande_rio' | "Pinheiros, São Paulo"
}

export interface Municipio {
  /** Nome completo "Município, UF" pronto para geocodificar. */
  local: string
  uf: string | null
}

/** Parseia a resposta da API do IBGE (/estados/{UF}/municipios) → nomes. */
export function parseMunicipiosIBGE(data: unknown, uf: string): Municipio[] {
  if (!Array.isArray(data)) return []
  const out: Municipio[] = []
  const vistos = new Set<string>()
  for (const m of data) {
    const nome = typeof (m as { nome?: unknown })?.nome === 'string' ? (m as { nome: string }).nome : null
    if (!nome || vistos.has(nome)) continue
    vistos.add(nome)
    out.push({ local: `${nome}, ${uf}`, uf })
  }
  return out
}

/** Municípios de uma região metropolitana curada → formato Municipio. */
export function municipiosMetro(valor: string): Municipio[] {
  if (valor === 'grande_sp') return GRANDE_SP.map((n) => ({ local: `${n}, SP`, uf: 'SP' }))
  if (valor === 'grande_rio') return GRANDE_RIO.map((n) => ({ local: `${n}, RJ`, uf: 'RJ' }))
  return []
}

export const IBGE_MUNICIPIOS_URL = (uf: string): string =>
  `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(uf)}/municipios`
