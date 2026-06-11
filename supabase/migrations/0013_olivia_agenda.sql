-- 0013_olivia_agenda.sql — Olivia Autônoma — Fase C (agendamento).
-- Plano: .claude/plans/2026-06-10-olivia-autonoma.md
-- Aditivo e idempotente. reuniao_at / reuniao_link / olivia_estado já vêm da 0011.
--
-- olivia_slots: horários que a Olivia PROPÔS ao lead (ISO UTC), guardados para
-- confirmar a escolha contra eles — anti-invenção: só marcamos um horário que de
-- fato oferecemos e que estava livre na agenda, nunca um inventado pelo LLM.
alter table public.leads
  add column if not exists olivia_slots jsonb;
