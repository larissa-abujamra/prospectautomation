-- Olivia Autônoma — endurecimento pré-go-live. Plano: .claude/plans/2026-06-10-olivia-autonoma.md
-- Aditivo e idempotente.
--
-- 1) olivia_slots_at: quando os horários foram propostos. Confirmar um slot
--    velho (lead some e volta dias depois) re-propõe em vez de marcar — o lead
--    pode estar pensando noutra lista. TTL aplicado no código.
alter table public.leads
  add column if not exists olivia_slots_at timestamptz;

-- 2) Rate limit global por janela (teto de custo de LLM). Contador atômico por
--    bucket de minuto; a Edge Function (service role) incrementa via RPC.
create table if not exists public.olivia_rate (
  bucket   text primary key,        -- ex.: '2026-06-10T16:42' (minuto UTC)
  contador int  not null default 0,
  criado_em timestamptz not null default now()
);

alter table public.olivia_rate enable row level security;
-- Sem policy para 'authenticated' de propósito: só o service role (Edge) mexe.

-- Incrementa o bucket e diz se AINDA está dentro do limite (<= p_max). Atômico:
-- o insert...on conflict...returning resolve corrida de chamadas concorrentes.
create or replace function public.olivia_rate_hit(p_bucket text, p_max int)
returns boolean
language plpgsql
as $$
declare
  c int;
begin
  insert into public.olivia_rate (bucket, contador)
  values (p_bucket, 1)
  on conflict (bucket) do update set contador = public.olivia_rate.contador + 1
  returning contador into c;
  return c <= p_max;
end;
$$;
