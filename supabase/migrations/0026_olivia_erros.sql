-- Log de erros operacionais visível pro time (não fica só no console da função).
-- Olivia e as edge functions gravam aqui quando uma operação falha (criar evento,
-- ler agenda, LLM, etc.) — assim o time vê o que quebrou sem abrir o painel do
-- Supabase. Inserção é feita pelas functions com a service role (bypassa RLS);
-- leitura é liberada pra qualquer usuário autenticado (ferramenta interna).

create table if not exists public.olivia_erros (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  fonte       text not null,                       -- nome da função/origem (ex.: 'olivia-agendar')
  nivel       text not null default 'error' check (nivel in ('error', 'warn')),
  lead_id     uuid null references public.leads(id) on delete set null,
  mensagem    text not null,                       -- resumo legível do erro
  contexto    jsonb null                           -- detalhe estruturado (status, rep, slot, etc.)
);

-- Listagem padrão: mais recentes primeiro.
create index if not exists olivia_erros_created_at_idx
  on public.olivia_erros (created_at desc);

-- Filtro por lead na ficha.
create index if not exists olivia_erros_lead_id_idx
  on public.olivia_erros (lead_id)
  where lead_id is not null;

alter table public.olivia_erros enable row level security;

-- Leitura pra usuários autenticados (sem signup público — ver README).
drop policy if exists "olivia_erros_select_authenticated" on public.olivia_erros;
create policy "olivia_erros_select_authenticated"
  on public.olivia_erros for select
  to authenticated
  using (true);
