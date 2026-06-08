-- Módulo WhatsApp (Parte B — sync com HubSpot).
-- Colunas aditivas e NULLABLE. Distintas de `hubspot_exported_at` (stub de UI da
-- outra frente): aqui guardamos o id real do contato criado/atualizado no HubSpot
-- via a função hubspot-sync, garantindo idempotência (re-sync atualiza, não duplica).

alter table public.leads
  add column if not exists hubspot_contact_id text,
  add column if not exists hubspot_synced_at  timestamptz;
