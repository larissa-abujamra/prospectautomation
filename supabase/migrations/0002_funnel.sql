alter table public.leads add column if not exists setor text;
alter table public.leads add column if not exists hubspot_exported_at timestamptz;
create index if not exists leads_setor_idx on public.leads(setor);
