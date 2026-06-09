-- Id do NEGÓCIO (deal) criado no HubSpot pelo "Importar pra HubSpot". Negócio
-- não tem propriedade única de dedup como o contato (google_place_id), então
-- guardamos o id aqui para não recriar em re-exportações (idempotência).
-- Aditivo e NULLABLE: seguro para leads existentes.

alter table public.leads
  add column if not exists hubspot_deal_id text;
