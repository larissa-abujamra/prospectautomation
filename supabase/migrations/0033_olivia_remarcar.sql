-- Reschedule + no-show da Olivia.
-- =============================================================================
-- olivia_noshow_em: carimbo one-shot do follow-up automático de no-show — depois
-- que a reunião passa e a Olivia manda a mensagem de "não te encontrei, vamos
-- remarcar?", grava aqui pra não repetir. Re-arma naturalmente: ao remarcar, o
-- reuniao_at vira o novo horário e olivia_noshow_em é zerado.

alter table public.leads
  add column if not exists olivia_noshow_em timestamptz;

-- Reuniões que JÁ passaram e ainda estão 'agendado' (possível no-show), sem
-- mensagem de no-show ainda. grace_horas = quanto esperar depois do horário antes
-- de assumir que não compareceu. Usada pelo cron olivia-noshow.
create or replace function public.olivia_reunioes_noshow(
  grace_horas numeric default 2,
  limite int default 25
)
returns table (
  id uuid,
  nome text,
  reuniao_at timestamptz,
  whatsapp_phone text,
  whatsapp_dono text,
  hubspot_contact_id text,
  horas_desde_reuniao numeric
)
language sql
stable
as $$
  select
    l.id,
    l.nome,
    l.reuniao_at,
    l.whatsapp_phone,
    l.whatsapp_dono,
    l.hubspot_contact_id,
    round(extract(epoch from (now() - l.reuniao_at)) / 3600.0, 1) as horas_desde_reuniao
  from public.leads l
  where l.olivia_estado = 'agendado'
    and l.reuniao_at is not null
    and l.reuniao_at <= now() - (grace_horas * interval '1 hour')
    and l.olivia_noshow_em is null
  order by l.reuniao_at asc
  limit limite;
$$;
