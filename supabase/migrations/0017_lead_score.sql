-- 0017_lead_score.sql — sinais de qualificação da bio do Instagram + lead score.
-- =============================================================================
-- Persiste os 4 booleanos extraídos da bio do Instagram e o score calculado.
-- Score é gravado como coluna normal (não generated): backfill barato se a
-- fórmula mudar (UPDATE recalculando dos booleanos, sem novo scrape).
-- Aditivo e idempotente — seguro de re-aplicar.
-- =============================================================================

alter table public.leads
  add column if not exists bio_ponto_fisico     boolean NOT NULL DEFAULT false,
  add column if not exists bio_linktree         boolean NOT NULL DEFAULT false,
  add column if not exists bio_whatsapp_vendas  boolean NOT NULL DEFAULT false,
  add column if not exists bio_delivery_proprio boolean NOT NULL DEFAULT false,
  add column if not exists lead_score           smallint NULL;

comment on column public.leads.bio_ponto_fisico is
  'TRUE quando o lead tem endereço real do Google Places (ponto físico confirmado).';
comment on column public.leads.bio_linktree is
  'TRUE quando a bio do Instagram contém link de agregador de links (linktr.ee, beacons…). '
  'Não pontuado no score — guardado para análise futura.';
comment on column public.leads.bio_whatsapp_vendas is
  'TRUE quando a bio tem link wa.me/api.whatsapp.com/wa.link OU frase de intenção '
  'de venda via WhatsApp ("pedidos pelo whats", "peça pelo whatsapp" etc.).';
comment on column public.leads.bio_delivery_proprio is
  'TRUE para "delivery próprio", "entregamos", "fazemos entrega", "tele-entrega". '
  'FALSE se a bio só citar agregadores (iFood/Rappi/Uber Eats) sem frases de entrega própria.';
comment on column public.leads.lead_score is
  'Score de qualificação (0–6): ponto_fisico +1 / delivery_proprio +2 / whatsapp_vendas +3. '
  'NULL = lead ainda não classificado (aguarda enriquecimento). '
  'Fórmula: calcularLeadScore em _shared/lead_score.ts.';
