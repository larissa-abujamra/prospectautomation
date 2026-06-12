-- Import inbound waitlist leads from the external Squad Leads app.
-- The key is separate from google_place_id so the two sourcing systems dedup
-- independently inside the shared public.leads funnel.

alter table public.leads
  add column if not exists squad_leads_id bigint,
  add column if not exists origem text not null default 'google_places',
  add column if not exists inbound_score integer,
  add column if not exists inbound_classification text,
  add column if not exists inbound_revenue_range text,
  add column if not exists inbound_ready_to_implement text,
  add column if not exists inbound_created_at timestamptz,
  add column if not exists inbound_utm_source text,
  add column if not exists inbound_utm_medium text,
  add column if not exists inbound_utm_campaign text,
  add column if not exists inbound_meta jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_squad_leads_id_key'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_squad_leads_id_key unique (squad_leads_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_origem_check'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_origem_check
      check (origem in ('google_places', 'squad_leads_form'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_inbound_score_check'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_inbound_score_check
      check (inbound_score is null or inbound_score between 0 and 100);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_inbound_classification_check'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_inbound_classification_check
      check (
        inbound_classification is null
        or inbound_classification in ('quente', 'nutrir', 'descartar')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_inbound_revenue_range_check'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_inbound_revenue_range_check
      check (
        inbound_revenue_range is null
        or inbound_revenue_range in ('menos_10k', '10k_20k', '20k_50k', '50k_100k', 'acima_100k')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_inbound_ready_to_implement_check'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_inbound_ready_to_implement_check
      check (
        inbound_ready_to_implement is null
        or inbound_ready_to_implement in ('sim_certeza', 'talvez', 'nao_proximos_7dias')
      );
  end if;
end $$;

create index if not exists leads_origem_idx on public.leads(origem);
create index if not exists leads_inbound_classification_idx on public.leads(inbound_classification);
create index if not exists leads_inbound_score_idx on public.leads(inbound_score);
create index if not exists leads_inbound_created_at_idx on public.leads(inbound_created_at);
