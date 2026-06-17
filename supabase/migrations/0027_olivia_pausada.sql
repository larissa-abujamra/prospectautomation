-- 0027: estado 'pausada' no olivia_estado (kill switch por conversa).
-- =============================================================================
-- A 0011 criou o CHECK de olivia_estado SEM 'pausada'. Sem este aditivo, QUALQUER
-- update para 'pausada' falha na constraint — tanto o botão manual do time
-- (desligar a Olivia numa conversa) quanto o auto-pause quando um humano assume
-- o atendimento no inbox do HubSpot. Aditivo e idempotente.
-- =============================================================================

alter table public.leads drop constraint if exists leads_olivia_estado_check;

alter table public.leads
  add constraint leads_olivia_estado_check
  check (
    olivia_estado in (
      'aguardando', 'conversando', 'agendando', 'agendado', 'handoff', 'optout', 'pausada'
    )
  );
