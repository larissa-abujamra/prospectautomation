-- 0021_followup.sql — Fase D: follow-up único de 48h sem resposta.
-- =============================================================================
-- Plano: .claude/plans/2026-06-10-olivia-autonoma.md (Fase D). A olivia-followup
-- seleciona leads cujo template de intro foi acionado há >=48h (whatsapp_sent_at)
-- e que NUNCA responderam, e re-dispara o workflow do HubSpot marcando
-- whatsapp_outreach='followup' no contato. Esta coluna é o one-shot: gravada
-- após o PATCH bem-sucedido, garante que NENHUM lead recebe follow-up 2x.
-- Aditivo e idempotente — seguro de re-aplicar.
-- =============================================================================

alter table public.leads
  add column if not exists followup_enviado_em timestamptz;

-- Índice parcial: a olivia-followup só varre quem foi disparado e AINDA não
-- recebeu follow-up (a maioria dos leads sai do índice ao receber).
create index if not exists leads_followup_pendente_idx
  on public.leads (whatsapp_sent_at)
  where followup_enviado_em is null and whatsapp_sent_at is not null;

comment on column public.leads.followup_enviado_em is
  'Fase D: instante em que o follow-up de 48h foi DISPARADO (PATCH '
  'whatsapp_outreach=followup no HubSpot; o envio real é do workflow). '
  'Não-nulo = nunca mais re-disparar (one-shot). NULL = ainda elegível.';
