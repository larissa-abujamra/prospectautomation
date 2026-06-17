-- Stores the HubSpot contact created/reused for the owner/responsible person
-- indicated during Olivia's handoff flow. Nullable for existing leads and for
-- cases where HubSpot creation fails and the flow falls back to manual handoff.

alter table public.leads
  add column if not exists hubspot_responsavel_contact_id text;
