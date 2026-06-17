-- Tracks when WhatsApp discovery last completed for a lead.
-- Nullable for existing data: a previous missing/invalid without this timestamp
-- is treated as stale and can be rediscovered on the next search.

alter table public.leads
  add column if not exists whatsapp_checked_at timestamptz;

create index if not exists leads_whatsapp_checked_at_idx
  on public.leads(whatsapp_checked_at);
