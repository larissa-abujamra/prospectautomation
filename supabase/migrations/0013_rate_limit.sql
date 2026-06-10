-- 0013_rate_limit.sql — primitivo de rate-limit ATÔMICO (anti-custo / loop-breaker)
-- =============================================================================
-- Por quê: (1) o teto diário de WhatsApp em enviar-whatsapp era um count-then-send
-- (TOCTOU): dois envios concorrentes liam "count < cap" e ambos passavam, furando
-- o cap de warm-up (risco de ban do número na Meta). (2) Quando o RESPONDER da
-- Olivia (Fase B) ligar a auto-resposta por LLM no inbound, um contato tagarela ou
-- dois bots conversando viram um loop de gasto SEM teto. Este primitivo resolve os
-- dois: uma janela deslizante por "bucket", consumida de forma atômica.
--
-- Uso (edge function, via service role):
--   const ok = await rpc('rate_limit_consume', { p_bucket, p_max, p_window_secs })
--   buckets sugeridos:
--     'wa:send:daily'                 max=20  janela=86400   (warm-up do número)
--     'olivia:reply:'+phone           max=5   janela=3600    (por contato)
--     'olivia:reply:global'           max=120 janela=3600    (teto global do responder)
-- =============================================================================

create table if not exists public.rate_limit_event (
  id         bigint generated always as identity primary key,
  bucket     text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_event_bucket_time
  on public.rate_limit_event (bucket, created_at);

-- Só a service role (que ignora RLS) toca isto, via a RPC abaixo. RLS ligada +
-- sem policy = cliente anon/authenticated não lê/escreve direto.
alter table public.rate_limit_event enable row level security;

-- Consome 1 slot do bucket dentro da janela, de forma ATÔMICA. Retorna true se
-- havia slot (e registra o consumo), false se estourou o teto. O advisory lock
-- por bucket serializa concorrentes (lock de transação — seguro no pooler, é
-- liberado no fim da chamada). search_path fixo (hardening do advisor).
create or replace function public.rate_limit_consume(
  p_bucket text,
  p_max int,
  p_window_secs int
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  if p_bucket is null or p_bucket = '' or p_max <= 0 or p_window_secs <= 0 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_bucket, 0));
  -- GC preguiçoso: limpa eventos bem mais velhos que a janela (mantém a tabela enxuta).
  delete from public.rate_limit_event
    where bucket = p_bucket and created_at < now() - make_interval(secs => p_window_secs * 2);
  select count(*) into n from public.rate_limit_event
    where bucket = p_bucket and created_at > now() - make_interval(secs => p_window_secs);
  if n >= p_max then
    return false;
  end if;
  insert into public.rate_limit_event(bucket) values (p_bucket);
  return true;
end $$;

-- Não é pra ser chamada do cliente — só do servidor (service role).
revoke execute on function public.rate_limit_consume(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_consume(text, int, int) to service_role;
