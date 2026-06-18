-- 0029: fila de busca em massa (jobs por estado/região + tasks por município).
-- =============================================================================
-- Um JOB representa uma varredura de um escopo (UF inteira, região metropolitana
-- ou cidade) para um setor. Ele é quebrado em TASKS — uma por município — que o
-- scrape-worker drena em background (cron), geocodificando o município e rodando
-- a grade (buscar-grade) em lotes. Resumável: cada task guarda seu cursor.
--
-- max_inserts = teto de leads NOVOS por job (cap de custo); 0/null = sem teto.
-- Escrita pelas Edge Functions via service role; leitura pelo time (authenticated).
-- =============================================================================

create table if not exists public.scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  setor text not null,
  escopo_tipo text not null check (escopo_tipo in ('uf', 'metro', 'cidade')),
  escopo_valor text not null,
  cell_km numeric not null default 2,
  max_termos int not null default 2,
  max_paginas int not null default 2,
  max_inserts int,                 -- teto de leads novos (cap de custo); null = sem teto
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'cancelled')),
  total_tasks int not null default 0,
  tasks_done int not null default 0,
  found_total int not null default 0,
  inserted_total int not null default 0,
  requisicoes_total int not null default 0
);

create table if not exists public.scrape_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.scrape_jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  local text not null,             -- "Campinas, SP" — pronto pra geocodificar
  uf text,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  bbox jsonb,                      -- bounds geocodificadas (preenchidas no 1º tick)
  total_cells int,
  cursor int not null default 0,
  found int not null default 0,
  inserted int not null default 0,
  requisicoes int not null default 0,
  erro text
);

create index if not exists scrape_tasks_job_idx on public.scrape_tasks(job_id);
-- O worker busca tasks não-terminais (pending/running) — índice parcial enxuto.
create index if not exists scrape_tasks_aberta_idx
  on public.scrape_tasks(job_id) where status in ('pending', 'running');
create index if not exists scrape_jobs_status_idx on public.scrape_jobs(status);

-- RLS: o time (authenticated) lê o progresso; as Edge Functions escrevem via
-- service role (bypassa RLS). App é interno (todo usuário logado é da equipe).
alter table public.scrape_jobs enable row level security;
alter table public.scrape_tasks enable row level security;

drop policy if exists scrape_jobs_select_auth on public.scrape_jobs;
create policy scrape_jobs_select_auth on public.scrape_jobs
  for select to authenticated using (true);

drop policy if exists scrape_tasks_select_auth on public.scrape_tasks;
create policy scrape_tasks_select_auth on public.scrape_tasks
  for select to authenticated using (true);
