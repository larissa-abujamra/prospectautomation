-- Follow-up conversacional (nudge) de 23h: retoma chats que ESFRIARAM.
-- =============================================================================
-- Diferente do follow-up frio (0021 / olivia-followup), que mira quem NUNCA
-- respondeu. Aqui o gatilho é uma CONVERSA viva (>=1 mensagem do cliente) em que
-- a Olivia falou por último e o cliente sumiu há >=23h. 23h é de propósito: ainda
-- dentro da janela de 24h do WhatsApp → dá pra mandar mensagem livre (natural,
-- contextual). Passou de 24h → só template (squad_followup_1).
--
-- Re-armável: olivia_nudge_em guarda o último nudge; o chat volta a ser elegível
-- só se o cliente responder DEPOIS do nudge (last_in > olivia_nudge_em). Assim é
-- um nudge por período de silêncio, sem perturbar.

alter table public.leads
  add column if not exists olivia_nudge_em timestamptz;

-- Seleção dos chats elegíveis ao nudge. Agrega whatsapp_mensagens por lead:
-- último inbound, última msg e direção da última msg. Determinístico; a função
-- pura elegivelParaNudge re-valida no edge (defesa em profundidade).
create or replace function public.olivia_chats_para_nudge(
  janela_horas int default 23,
  limite int default 25
)
returns table (
  id uuid,
  nome text,
  olivia_estado text,
  whatsapp_phone text,
  whatsapp_dono text,
  hubspot_contact_id text,
  last_in timestamptz,
  last_msg_at timestamptz,
  horas_silencio numeric
)
language sql
stable
as $$
  select
    l.id,
    l.nome,
    l.olivia_estado,
    l.whatsapp_phone,
    l.whatsapp_dono,
    l.hubspot_contact_id,
    m.last_in,
    m.last_msg_at,
    round(extract(epoch from (now() - m.last_in)) / 3600.0, 1) as horas_silencio
  from public.leads l
  join lateral (
    select
      max(wm.enviada_em) filter (where wm.direcao = 'in') as last_in,
      max(wm.enviada_em) as last_msg_at,
      (array_agg(wm.direcao order by wm.enviada_em desc))[1] as last_dir
    from public.whatsapp_mensagens wm
    where wm.lead_id = l.id
  ) m on true
  where l.olivia_estado in ('conversando', 'agendando')  -- chat vivo, não terminal
    and m.last_in is not null                              -- >=1 mensagem do cliente
    and m.last_dir = 'out'                                 -- Olivia falou por último
    and m.last_in <= now() - make_interval(hours => janela_horas)
    and (l.olivia_nudge_em is null or l.olivia_nudge_em < m.last_in) -- re-armado
  order by m.last_in asc
  limit limite;
$$;
