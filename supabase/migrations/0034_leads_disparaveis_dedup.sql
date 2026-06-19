-- leads_disparaveis: seleção de leads prontos para disparo de WhatsApp em lote,
-- com DEDUP POR NÚMERO. Antes o bulk-dispatch deduplicava só por linha de lead
-- (whatsapp_sent_at), então redes com um WhatsApp central — várias filiais como
-- linhas separadas e MESMO número — recebiam uma mensagem POR FILIAL
-- (ex.: Fábrica de Doces Brasil, 10 filiais → 10 mensagens no mesmo número).
--
-- Esta função:
--   (1) exclui qualquer número que JÁ recebeu mensagem (coalesce(dono, phone)
--       com whatsapp_sent_at em qualquer linha) — não repete com quem já enviamos;
--   (2) deduplica DENTRO do lote (distinct on número, mantém o mais antigo).
-- O filtro por linha + o claim atômico do hubspot-sync seguem como rede contra corrida.
create or replace function public.leads_disparaveis(p_setor text default null, p_limite int default 20)
returns table(id uuid, nome text, setor text)
language sql stable as $$
  with candidatos as (
    select l.id, l.nome, l.setor, l.created_at, coalesce(l.whatsapp_dono, l.whatsapp_phone) as num
    from leads l
    where l.origem = 'google_places'
      and l.whatsapp_status = 'found'
      and l.whatsapp_sent_at is null
      and (l.whatsapp_ddd_mismatch is null or l.whatsapp_ddd_mismatch = false)
      and (p_setor is null or l.setor ilike '%' || p_setor || '%')
  ),
  nao_enviados as (
    select c.* from candidatos c
    where c.num is not null
      and not exists (
        select 1 from leads s
        where coalesce(s.whatsapp_dono, s.whatsapp_phone) = c.num
          and s.whatsapp_sent_at is not null
      )
  ),
  unicos as (
    select distinct on (num) id, nome, setor, created_at
    from nao_enviados
    order by num, created_at asc
  )
  select id, nome, setor from unicos
  order by created_at asc
  limit p_limite;
$$;
