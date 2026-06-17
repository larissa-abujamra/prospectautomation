-- Allow manually entered Olivia contacts to live in the shared leads funnel.
-- They still use google_place_id as the HubSpot dedupe property, with a synthetic
-- value like manual_olivia:<normalized_phone>.

alter table public.leads
  drop constraint if exists leads_origem_check;

alter table public.leads
  add constraint leads_origem_check
  check (origem in ('google_places', 'squad_leads_form', 'manual_olivia'));
