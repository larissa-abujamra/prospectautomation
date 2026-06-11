-- Trava anti-resposta-dupla da Olivia (rajadas de mensagens disparam invocações
-- paralelas da olivia-responder; só quem ganha o CAS nesta coluna responde —
-- e espera alguns segundos antes de ler o histórico, cobrindo a rajada inteira).
alter table public.leads
  add column if not exists olivia_lock timestamptz;
