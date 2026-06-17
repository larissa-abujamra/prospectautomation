-- Olivia scheduling follow-up: prospect email, assigned Inner employee, and
-- durable Google Calendar evidence for scheduled meetings.
-- Aditivo e idempotente; existing scheduled leads keep reuniao_at/reuniao_link.

alter table public.leads
  add column if not exists prospect_email text,
  add column if not exists olivia_pending_slot_iso timestamptz,
  add column if not exists olivia_pending_rep_email text,
  add column if not exists olivia_pending_rep_nome text,
  add column if not exists olivia_assigned_rep_email text,
  add column if not exists olivia_assigned_rep_nome text,
  add column if not exists reuniao_calendar_event_id text,
  add column if not exists reuniao_calendar_link text,
  add column if not exists reuniao_calendar_title text;

create index if not exists leads_olivia_pending_slot_idx
  on public.leads(olivia_pending_slot_iso)
  where olivia_pending_slot_iso is not null;
