-- Anti-resposta-dupla POR MENSAGEM (wamid). O guard antigo ("última msg já é da
-- Olivia") depende de a SAÍDA ter sido gravada em whatsapp_mensagens; se essa
-- gravação atrasa/falha (visto em prod), um 2º trigger (echo do HubSpot, retry de
-- webhook, invocação manual) vê o inbound como não-respondido e responde DE NOVO.
--
-- Aqui guardamos o wamid do último inbound que a Olivia respondeu e fazemos um
-- CLAIM ATÔMICO antes de responder: se o wamid já foi reivindicado, pula. Não
-- depende da gravação da saída. RPC parametrizada (wamid tem ':' / '.' / base64,
-- que quebrariam um filtro PostgREST montado à mão).
alter table leads add column if not exists olivia_last_in_wamid text;

create or replace function public.olivia_claim_inbound(p_lead uuid, p_wamid text)
returns boolean
language plpgsql
as $$
declare
  v_rows int;
begin
  update leads
     set olivia_last_in_wamid = p_wamid
   where id = p_lead
     and coalesce(olivia_last_in_wamid, '') <> p_wamid;
  get diagnostics v_rows = row_count;
  return v_rows > 0; -- true = reivindicado agora (pode responder); false = já respondido
end;
$$;
