create type lead_status as enum (
  'descoberto','qualificado','enriquecido','em_rota','visitado','contatado','interessado','descartado'
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  -- Módulo 1 (sourcing via Google Places)
  nome text not null,
  endereco text,
  bairro text,
  cidade text default 'São Paulo',
  lat double precision,
  lng double precision,
  google_place_id text unique,
  telefone text,                 -- telefone comercial PÚBLICO (não pessoal)
  website text,
  rating numeric,                -- nota Google
  reviews_count int,             -- nº de avaliações
  instagram_handle text,
  instagram_followers int,       -- preenchido depois; pode ficar null
  -- Módulo 2 (enriquecimento)
  cnpj text,
  razao_social text,
  socios jsonb,                  -- QSA: [{nome, qualificacao}]
  dono_nome text,
  enrich_status jsonb default '{}'::jsonb,  -- {cnpj:'ok'|'missing'|'pending', dono:..., instagram:...}
  -- pipeline
  status lead_status default 'descoberto',
  notas text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index leads_status_idx on public.leads(status);
create index leads_bairro_idx on public.leads(bairro);

-- trigger updated_at
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- RLS: ferramenta interna, workspace compartilhado.
-- Qualquer usuário AUTENTICADO lê/escreve todos os leads (diferente do playbook,
-- onde cada user só via a própria linha).
alter table public.leads enable row level security;
create policy "auth full access" on public.leads
  for all to authenticated using (true) with check (true);
