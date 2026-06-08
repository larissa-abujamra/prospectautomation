-- Módulo WhatsApp (Parte D — envio via Meta Cloud API).
-- Colunas aditivas e NULLABLE para rastrear o disparo do template (independente
-- do número-finding em whatsapp_status). Distintas de hubspot_* (CRM).

alter table public.leads
  add column if not exists whatsapp_send_status text,   -- 'sent'|'failed'|'invalid'|'delivered'|'read'|'replied'
  add column if not exists whatsapp_sent_at    timestamptz,
  add column if not exists whatsapp_msg_id      text;     -- wamid da Meta (rastreio + dedup de webhook)

create index if not exists leads_whatsapp_send_status_idx on public.leads(whatsapp_send_status);
