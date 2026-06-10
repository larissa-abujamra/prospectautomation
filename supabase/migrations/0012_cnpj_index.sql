-- 0012_cnpj_index.sql — índice LOCAL de CNPJ (base aberta da Receita Federal)
-- =============================================================================
-- Geração de candidatos a CNPJ por NOME+cidade SEM depender do Google/Scrapingdog
-- (a maior causa de CNPJ em branco era o SERP não devolver o número p/ nomes
-- curtos/genéricos). É um índice desnormalizado dos ESTABELECIMENTOS da Receita,
-- carregado em lote (ver scripts/load-rf-cnpj.mjs), pesquisável por trigrama no
-- nome. Os dados JÁ SÃO oficiais → dispensa a etapa de confirmação; o lead segue
-- direto pro score determinístico (nome/telefone/cidade) + juiz.
-- =============================================================================

create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- unaccent é STABLE; embrulhamos numa função IMMUTABLE pra poder indexar.
create or replace function public.imm_unaccent(text)
returns text language sql immutable parallel safe as $$
  select lower(public.unaccent('public.unaccent', $1))
$$;

create table if not exists public.cnpj_index (
  cnpj          text primary key,            -- 14 dígitos
  razao_social  text,
  nome_fantasia text,
  nome_busca    text not null,               -- unaccent(lower(fantasia ' ' razao)) p/ trigrama
  cep           text,
  municipio     text,                        -- NOME do município (resolvido do código no ETL)
  uf            text,
  bairro        text,
  logradouro    text,
  situacao      text,                         -- ATIVA / BAIXADA / ...
  cnae          text,                         -- descrição da atividade principal
  telefone      text,                         -- DDD+telefone registrado
  porte         text,
  mei           boolean,
  socios        jsonb,                         -- [{nome, qualificacao}] (sem CPF — LGPD)
  updated_at    timestamptz not null default now()
);

-- Trigrama no nome (busca por similaridade) + filtros de cidade/CEP.
create index if not exists cnpj_index_nome_trgm on public.cnpj_index using gin (nome_busca gin_trgm_ops);
create index if not exists cnpj_index_municipio on public.cnpj_index (municipio);
create index if not exists cnpj_index_cep on public.cnpj_index (cep);

-- RLS: leitura pra autenticados; escrita só service role (ETL).
alter table public.cnpj_index enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='cnpj_index' and policyname='cnpj_index_read') then
    create policy cnpj_index_read on public.cnpj_index for select to authenticated using (true);
  end if;
end $$;

-- Busca por nome (trigrama) + cidade opcional. Devolve os melhores candidatos
-- com o score de similaridade — quem chama ainda passa pelo funil de match.
create or replace function public.buscar_cnpj_local(
  p_nome text,
  p_municipio text default null,
  p_limit int default 8
)
returns table (
  cnpj text, razao_social text, nome_fantasia text, cep text, municipio text,
  uf text, bairro text, situacao text, cnae text, telefone text, porte text,
  mei boolean, socios jsonb, sim real
)
language sql stable parallel safe as $$
  select i.cnpj, i.razao_social, i.nome_fantasia, i.cep, i.municipio, i.uf,
         i.bairro, i.situacao, i.cnae, i.telefone, i.porte, i.mei, i.socios,
         similarity(i.nome_busca, public.imm_unaccent(p_nome)) as sim
  from public.cnpj_index i
  where i.nome_busca % public.imm_unaccent(p_nome)
    and (p_municipio is null or i.municipio = public.imm_unaccent(p_municipio))
  order by sim desc
  limit greatest(p_limit, 1)
$$;
