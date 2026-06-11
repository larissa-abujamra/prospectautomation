-- Olivia no inbox do HubSpot (decisão de 11/06: tudo centrado no HubSpot).
-- Guarda o thread de Conversas do lead para a olivia-responder responder DE
-- VOLTA pelo inbox (em vez da Cloud API direta). Preenchido pelo
-- olivia-hubspot-webhook a cada mensagem recebida.
alter table public.leads
  add column if not exists hubspot_thread_id text;
