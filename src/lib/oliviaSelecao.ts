import type { Lead } from './types'

// Seleção do wizard da Olivia (passo 2). Garante que o que aparece e o que é
// processado é EXATAMENTE a busca atual — nem todos os 'descoberto' do banco,
// nem leads já processados que voltaram numa re-busca.

// Leads desta busca que estão prontos pra processar: status 'descoberto' E entre
// os place_ids retornados pela busca. Um lead reencontrado mas já qualificado/
// processado NÃO aparece (não se re-processa quem já entrou no funil).
export function leadsDaBusca(leads: Lead[], placeIdsBusca: Iterable<string>): Lead[] {
  const ids = placeIdsBusca instanceof Set ? placeIdsBusca : new Set(placeIdsBusca)
  return leads.filter(
    (l) => l.status === 'descoberto' && !!l.google_place_id && ids.has(l.google_place_id),
  )
}

// Selecionados que REALMENTE estão na lista visível. A seleção é um Set que pode
// reter ids de buscas anteriores; o botão "Processar N" tem que contar e processar
// só estes — o número mostrado = o número processado (nem mais, nem menos).
export function selecionadosVisiveis(visiveis: Lead[], selecionados: ReadonlySet<string>): Lead[] {
  return visiveis.filter((l) => selecionados.has(l.id))
}
