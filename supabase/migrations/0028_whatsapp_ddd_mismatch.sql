-- 0028: flag whatsapp_ddd_mismatch (revisão de número de outra praça).
-- =============================================================================
-- A descoberta (encontrar-whatsapp) marca true quando o DDD do número achado
-- (em site/Instagram/Sonar) diverge da praça de referência do lead (DDD do
-- telefone do Google Places). Não bloqueia por si só — é um sinal para revisão
-- humana antes do disparo, já que negócios locais costumam ter WhatsApp no mesmo
-- DDD e um DDD distante num número achado é, em geral, fornecedor/agência.
-- Aditivo e idempotente.
-- =============================================================================

alter table public.leads
  add column if not exists whatsapp_ddd_mismatch boolean not null default false;

comment on column public.leads.whatsapp_ddd_mismatch is
  'true quando o DDD do whatsapp_phone diverge da praça do lead (DDD do telefone Google). Sinal de revisão — possível número errado/fornecedor.';
