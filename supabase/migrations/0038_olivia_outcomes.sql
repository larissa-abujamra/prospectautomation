-- 0038_olivia_outcomes.sql — captura de DESFECHO por conversa (Fase 4, goal 8)
-- =============================================================================
-- "Treinar depois de cada cliente": registra um desfecho toda vez que a conversa
-- chega a um estado terminal (agendado/handoff/optout/pausada). Capturado por
-- TRIGGER no leads — pega TODOS os caminhos (responder, olivia-agendar,
-- olivia-noshow, humano no inbox) sem editar cada function (DRY, à prova de furo).
--
-- quality_score e theme_tags ficam nulos aqui; um scoring posterior (humano ou
-- cron de baixa frequência) pode preenchê-los. A decisão de mudar prompt/estratégia
-- é SEMPRE humana (dashboard) — nada de auto-mutação (risco de marca/invenção).
-- Aditivo e idempotente.
-- =============================================================================

create table if not exists public.conversation_outcomes (
  id            bigint generated always as identity primary key,
  lead_id       uuid references public.leads(id) on delete cascade,
  outcome       text not null,            -- agendado | handoff | optout | pausada
  n_messages    int  not null default 0,  -- nº de mensagens na conversa no momento do desfecho
  handoff_motivo text,                     -- olivia_handoff_motivo, quando houver
  quality_score int,                       -- 1-5, preenchido depois (nullable)
  theme_tags    text[],                    -- temas, preenchido depois (nullable)
  created_at    timestamptz not null default now()
);
create index if not exists conversation_outcomes_outcome_time
  on public.conversation_outcomes (outcome, created_at desc);
create index if not exists conversation_outcomes_lead
  on public.conversation_outcomes (lead_id);

-- RLS: só membros logados leem (mesmo padrão de leads: app interno). Escrita vem
-- do trigger (security definer), não do cliente.
alter table public.conversation_outcomes enable row level security;
drop policy if exists "auth read outcomes" on public.conversation_outcomes;
create policy "auth read outcomes" on public.conversation_outcomes
  for select to authenticated using (true);

-- Trigger: grava o desfecho ao ENTRAR num estado terminal.
create or replace function public.olivia_capture_outcome()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  select count(*) into v_n from public.whatsapp_mensagens where lead_id = NEW.id;
  insert into public.conversation_outcomes (lead_id, outcome, n_messages, handoff_motivo)
  values (NEW.id, NEW.olivia_estado, coalesce(v_n, 0), NEW.olivia_handoff_motivo);
  return NEW;
end $$;

drop trigger if exists trg_olivia_capture_outcome on public.leads;
create trigger trg_olivia_capture_outcome
  after update of olivia_estado on public.leads
  for each row
  when (
    NEW.olivia_estado in ('agendado', 'handoff', 'optout', 'pausada')
    and NEW.olivia_estado is distinct from OLD.olivia_estado
  )
  execute function public.olivia_capture_outcome();

-- Agregados pro dashboard (1 chamada). Janela em dias; default 30.
create or replace function public.olivia_outcomes_agg(p_dias int default 30)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with janela as (
    select * from public.conversation_outcomes
    where created_at >= now() - make_interval(days => greatest(p_dias, 1))
  )
  select jsonb_build_object(
    'desde_dias', greatest(p_dias, 1),
    'total', (select count(*) from janela),
    'por_outcome', coalesce(
      (select jsonb_object_agg(outcome, c) from (select outcome, count(*) c from janela group by outcome) t),
      '{}'::jsonb),
    'media_mensagens', coalesce((select round(avg(n_messages), 1) from janela), 0),
    'media_qualidade', (select round(avg(quality_score), 2) from janela where quality_score is not null),
    'temas_top', coalesce(
      (select jsonb_agg(jsonb_build_object('tema', tema, 'n', c))
         from (select unnest(theme_tags) tema, count(*) c from janela group by 1 order by c desc limit 10) t),
      '[]'::jsonb)
  );
$$;

revoke execute on function public.olivia_outcomes_agg(int) from public, anon;
grant execute on function public.olivia_outcomes_agg(int) to authenticated, service_role;
