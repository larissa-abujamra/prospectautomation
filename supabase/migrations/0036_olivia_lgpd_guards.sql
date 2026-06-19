-- 0036_olivia_lgpd_guards.sql — guardas de LGPD em nível de banco (defesa-em-profundidade)
-- =============================================================================
-- O app já trata opt-out de forma determinística e nunca responde quem está em
-- 'optout' (deveResponder / ESTADOS_SILENCIO no olivia_brain). Aqui adicionamos
-- duas garantias que NÃO dependem do código de aplicação:
--
--   (1) TRAVA TERMINAL do opt-out: uma vez 'optout', o olivia_estado nunca volta
--       para um estado ativo. Protege contra bug/corrida que reativasse um lead
--       que pediu pra parar (LGPD: opt-out é definitivo). Reverter (raro/manual)
--       exige desabilitar o trigger de propósito.
--
--   (2) PURGE (direito ao esquecimento): redige o conteúdo das mensagens de um
--       lead (corpo + raw) mantendo só a casca de auditoria (direcao/tipo/data),
--       e marca o lead como 'optout'. Chamável só pela service role.
-- =============================================================================

-- (1) Trava terminal do opt-out -----------------------------------------------
create or replace function public.olivia_optout_terminal()
returns trigger
language plpgsql
as $$
begin
  -- Só chega aqui quando OLD já era 'optout' e o UPDATE mexe em olivia_estado
  -- (ver cláusula WHEN do trigger). Voltar pra qualquer coisa != 'optout' é
  -- proibido; re-setar pra 'optout' (idempotente) passa.
  if NEW.olivia_estado is distinct from 'optout' then
    raise exception 'olivia_estado optout é terminal (LGPD): não pode voltar para %', NEW.olivia_estado
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_olivia_optout_terminal on public.leads;
create trigger trg_olivia_optout_terminal
  before update of olivia_estado on public.leads
  for each row
  when (OLD.olivia_estado = 'optout')
  execute function public.olivia_optout_terminal();

-- (2) Purge / direito ao esquecimento -----------------------------------------
-- Redige o conteúdo (corpo + raw) das mensagens do lead, preservando a casca de
-- auditoria, e garante 'optout'. Retorna o nº de mensagens redigidas. Idempotente.
create or replace function public.olivia_purge_lead(p_lead uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows int;
begin
  if p_lead is null then
    return 0;
  end if;

  -- Lead esquecido nunca mais é mensageado: garante opt-out (a trava acima
  -- aceita setar PARA optout).
  update public.leads
     set olivia_estado = 'optout'
   where id = p_lead
     and coalesce(olivia_estado, '') <> 'optout';

  -- Redige o conteúdo das mensagens; mantém id/direcao/tipo/enviada_em pra auditoria.
  update public.whatsapp_mensagens
     set corpo = null,
         raw = jsonb_build_object('purged_at', now())
   where lead_id = p_lead;
  get diagnostics v_rows = row_count;

  return v_rows;
end $$;

revoke execute on function public.olivia_purge_lead(uuid) from public, anon, authenticated;
grant execute on function public.olivia_purge_lead(uuid) to service_role;
