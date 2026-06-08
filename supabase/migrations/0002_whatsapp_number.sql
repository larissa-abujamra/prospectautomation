-- Módulo WhatsApp (Parte A — descoberta do número).
-- Colunas aditivas e NULLABLE: não quebram dados existentes, seguem o princípio
-- anti-invenção (sem número confiável → null, aparece como "—" na UI).

alter table public.leads
  add column if not exists whatsapp_phone  text,  -- E.164 (+55...), null se não achado
  add column if not exists whatsapp_source text,  -- 'google' | 'instagram' | 'website' | 'manual'
  add column if not exists whatsapp_status text;   -- 'pending' | 'found' | 'missing' | 'invalid'

-- Filtro/contagem por status de WhatsApp (ex.: "quantos têm número pronto?").
create index if not exists leads_whatsapp_status_idx on public.leads(whatsapp_status);
