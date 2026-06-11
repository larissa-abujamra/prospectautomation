-- 0016_olivia_horario.sql — adia respostas da Olivia para o horário comercial.
-- =============================================================================
-- Inbound fora do expediente NÃO é respondido na hora (responder de madrugada
-- denuncia o bot). A olivia-responder, com OLIVIA_HORARIO=1, marca aqui quando a
-- resposta deve sair; a olivia-flush varre e re-invoca a responder na abertura.
-- Aditivo e idempotente — seguro de re-aplicar.
-- =============================================================================

alter table public.leads add column if not exists olivia_reply_apos timestamptz;

-- Índice parcial: a olivia-flush só consulta quem TEM resposta adiada pendente.
create index if not exists leads_olivia_reply_apos_idx
  on public.leads (olivia_reply_apos)
  where olivia_reply_apos is not null;

comment on column public.leads.olivia_reply_apos is
  'Olivia: instante a partir do qual uma resposta adiada (inbound fora do horário '
  'comercial) deve ser enviada. olivia-flush varre <= now() e re-invoca a '
  'olivia-responder. NULL = sem resposta pendente.';

-- =============================================================================
-- ATIVAÇÃO DO CRON (passo de GO-LIVE — rodar à mão, NÃO aplicado por esta migration)
-- -----------------------------------------------------------------------------
-- Por quê manual: liga o agendador (custo recorrente) e guarda o segredo interno
-- no comando do job. Rode só quando a Olivia for ao vivo, com a cadência/segredo
-- reais. Roda a cada 30min DENTRO do expediente (seg–sex 9–18:30) — o próprio
-- cron já respeita o horário; a flush só envia o que venceu.
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--
--   select cron.schedule(
--     'olivia-flush',
--     '0,30 9-18 * * 1-5',           -- a cada 30min, 9h–18h30, seg–sex (UTC! ajuste p/ -3)
--     $$
--       select net.http_post(
--         url     := 'https://jcfeydjzjnjdeubrchbg.supabase.co/functions/v1/olivia-flush',
--         headers := jsonb_build_object(
--           'Content-Type', 'application/json',
--           'x-olivia-secret', current_setting('app.olivia_trigger_secret', true)
--         ),
--         body    := '{}'::jsonb
--       );
--     $$
--   );
--
-- OBS de fuso: o schedule do pg_cron é em UTC. Para 9h–18h30 BRT (UTC-3), use
-- '0,30 12-21 * * 1-5'. Guarde o segredo via:
--   alter database postgres set app.olivia_trigger_secret = '<OLIVIA_TRIGGER_SECRET>';
-- =============================================================================
