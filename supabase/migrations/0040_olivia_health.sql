-- 0040_olivia_health.sql — monitoramento de saúde server-side da plataforma Olivia
-- =============================================================================
-- A Edge Function olivia-health-check roda 2x/dia (GitHub Actions) e grava aqui
-- um snapshot do estado da plataforma: erros do responder, chats travados,
-- pipeline de follow-up e integridade dos dados de reunião. Server-side de
-- propósito — sobrevive fora de qualquer sessão de ferramenta/CLI.
--
-- olivia_health_snapshot(): junta TODAS as métricas que dá pra calcular no banco
-- em UMA chamada (a function só complementa com a checagem de props no HubSpot).
-- A checagem da EXECUÇÃO do workflow de lembrete (enrollment runs) NÃO é feita
-- aqui: a private app não tem o escopo `automation` — fica como gap conhecido
-- (ver runbook). Tudo READ-ONLY; nada é corrigido automaticamente.
-- Aditivo e idempotente.
-- =============================================================================

create table if not exists public.olivia_health_checks (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  run_kind    text not null default 'manual',         -- morning | evening | manual
  status      text not null check (status in ('ok', 'warn', 'crit')),
  issues      int  not null default 0,                 -- nº de problemas detectados
  resultado   jsonb not null                           -- snapshot completo + issues
);

create index if not exists olivia_health_checks_time
  on public.olivia_health_checks (created_at desc);

-- RLS: leitura pro time logado (app interno). Escrita vem da Edge Function
-- (service role, bypassa RLS) — mesmo padrão de olivia_erros / outcomes.
alter table public.olivia_health_checks enable row level security;
drop policy if exists "auth read health" on public.olivia_health_checks;
create policy "auth read health" on public.olivia_health_checks
  for select to authenticated using (true);

-- Snapshot agregado em UMA chamada. SP-day correto: date_trunc no fuso de SP e
-- de volta pra timestamptz (at time zone duas vezes) pra comparar com reuniao_at.
create or replace function public.olivia_health_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_dia_ini timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  v_result  jsonb;
begin
  with ultimo as (
    -- última mensagem por lead (direção define "esperando resposta")
    select distinct on (lead_id) lead_id, direcao, enviada_em
    from public.whatsapp_mensagens
    where lead_id is not null
    order by lead_id, enviada_em desc
  ),
  travados as (
    select l.id, l.olivia_estado as estado,
           round(extract(epoch from (now() - u.enviada_em)) / 3600.0, 1) as horas
    from ultimo u
    join public.leads l on l.id = u.lead_id
    where u.direcao = 'in'
      and l.olivia_estado in ('conversando', 'agendando')
      and u.enviada_em < now() - interval '1 hour'
  ),
  proximas as (
    select id, hubspot_contact_id, reuniao_at
    from public.leads
    where olivia_estado = 'agendado'
      and reuniao_at > now()
      and reuniao_at < now() + interval '7 days'
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'responder', jsonb_build_object(
      'erros_24h', (select count(*) from public.olivia_erros where created_at > now() - interval '24 hours' and nivel = 'error'),
      'warns_24h', (select count(*) from public.olivia_erros where created_at > now() - interval '24 hours' and nivel = 'warn'),
      'erros_por_fonte', coalesce(
        (select jsonb_object_agg(fonte, c) from (
          select fonte, count(*) c from public.olivia_erros
          where created_at > now() - interval '24 hours' and nivel = 'error' group by fonte) t),
        '{}'::jsonb),
      'erro_exemplo', (select mensagem from public.olivia_erros
        where created_at > now() - interval '24 hours' and nivel = 'error'
        order by created_at desc limit 1),
      'msgs_in_24h', (select count(*) from public.whatsapp_mensagens where enviada_em > now() - interval '24 hours' and direcao = 'in'),
      'msgs_out_24h', (select count(*) from public.whatsapp_mensagens where enviada_em > now() - interval '24 hours' and direcao = 'out'),
      'chats_travados', (select count(*) from travados),
      'chats_travados_top', coalesce(
        (select jsonb_agg(jsonb_build_object('lead_id', id, 'estado', estado, 'horas', horas))
           from (select * from travados order by horas desc limit 5) s),
        '[]'::jsonb),
      'estados', coalesce(
        (select jsonb_object_agg(olivia_estado, c) from (
          select olivia_estado, count(*) c from public.leads
          where olivia_estado is not null group by olivia_estado) t),
        '{}'::jsonb)
    ),
    'followup', jsonb_build_object(
      'nudges_24h', (select count(*) from public.leads where olivia_nudge_em > now() - interval '24 hours'),
      'continuacoes_24h', (select count(*) from public.leads where olivia_reengajar_em > now() - interval '24 hours'),
      'nudge_backlog', (select count(*) from public.olivia_chats_para_nudge(23, 500))
    ),
    'reuniao', jsonb_build_object(
      'reunioes_hoje', (select count(*) from public.leads where reuniao_at >= v_dia_ini and reuniao_at < v_dia_ini + interval '1 day'),
      'proximas_7d', (select count(*) from proximas),
      'proximas_amostra', coalesce(
        (select jsonb_agg(jsonb_build_object('lead_id', id, 'hubspot_contact_id', hubspot_contact_id, 'reuniao_at', reuniao_at))
           from (select * from proximas order by reuniao_at limit 20) p),
        '[]'::jsonb),
      'sync_gaps', (select count(*) from public.leads
        where olivia_estado in ('conversando', 'agendando', 'agendado')
          and (hubspot_contact_id is null or hubspot_contact_id = ''))
    )
  ) into v_result;

  return v_result;
end $$;

revoke execute on function public.olivia_health_snapshot() from public, anon;
grant execute on function public.olivia_health_snapshot() to authenticated, service_role;
