-- Fase 2 do re-layout (plano 2026-06-10): checks da Base de Dados + WhatsApp da dona(o).
-- Aditivo e NULLABLE — seguro para leads existentes.
--   cliente_oculto_at    → quando a visita de cliente oculto foi feita (check ✓)
--   cliente_oculto_notas → observações da visita
--   whatsapp_dono        → nº pessoal da dona(o), preenchido MANUALMENTE pelo time
--                          (decisão LGPD: nada de data broker). O disparo prefere
--                          este número quando presente.
alter table public.leads
  add column if not exists cliente_oculto_at timestamptz,
  add column if not exists cliente_oculto_notas text,
  add column if not exists whatsapp_dono text;
