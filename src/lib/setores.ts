// Setores de prospecção — lista curada, fonte única (usada no Buscar manual e no
// wizard da Olivia). Antes era duplicada nos dois componentes como datalist.

export const SETORES = [
  'Confeitaria',
  'Pizzaria',
  'Hamburgueria',
  'Restaurante',
  'Restaurantes (todos)',
  'Cafeteria',
  'Pet shop',
  'Academia',
  'Salão de beleza',
  'Floricultura',
] as const

// "Restaurantes (todos)" busca o termo amplo "restaurante"; o backend classifica
// cada resultado em Pizzaria / Hamburgueria / Restaurante.
export function termoBusca(setor: string): string {
  return /^restaurantes?\s*\(todos\)$/i.test(setor.trim()) ? 'restaurante' : setor
}
