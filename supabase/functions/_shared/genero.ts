// Gênero gramatical do nome do negócio (módulo WhatsApp, Parte C).
// =============================================================================
// Decide o artigo (o/a) e, com isso, qual template usar (squad_prospeccao_intro_m
// vs _f). A classificação em si é feita por LLM (ver classificarGenero na função
// hubspot-sync); aqui ficam as partes PURAS, unit-testadas: o parser da resposta
// do LLM e o construtor do prompt.
//
// REGRA: incerto/vazio/erro → 'f' (a lista é majoritariamente doceria/padaria/
// confeitaria, femininas). Assim a classificação degrada com segurança.
// =============================================================================

export type Genero = 'f' | 'm'

// Normaliza a saída do LLM para 'f'|'m'. Só vira 'm' quando a resposta indica
// masculino de forma inequívoca; qualquer outra coisa (incl. vazio/ruído) → 'f'.
export function parseGenero(raw: string | null | undefined): Genero {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return 'f'
  if (/femin|\bfem\b|\bf\b/.test(s)) return 'f'
  if (/mascul|\bmasc\b|\bm\b/.test(s)) return 'm'
  return 'f'
}

// Prompt de classificação (determinístico, só uma letra de resposta). Pede o
// gênero do ARTIGO que acompanha o nome do negócio numa frase como "Vi a/o <nome>".
export function generoPrompt(nome: string): { system: string; user: string } {
  const system = [
    'Você classifica o gênero gramatical do nome de um negócio em português do Brasil.',
    'Pense no artigo que soa natural antes do nome numa frase como "Vi ___ <nome>".',
    'Ex.: "a Doceria Maria" → f; "o Empório dos Bichos" → m; "a Pietra Pâtisserie" → f; "o Café Central" → m.',
    'Responda APENAS com uma única letra: "f" ou "m". Sem pontuação, sem explicação.',
    'Na dúvida, responda "f".',
  ].join(' ')
  const user = `Nome do negócio: ${nome}`
  return { system, user }
}
