-- Olivia Autônoma — Fase A (inbound). Plano: .claude/plans/2026-06-10-olivia-autonoma.md
-- Aditivo e idempotente (if not exists) — seguro para leads existentes.
--
-- whatsapp_mensagens: memória da conversa (toda mensagem que entra/sai pelo
-- webhook da Meta Cloud API). Dedup por wamid (a Meta re-entrega webhooks).
-- lead_id é NULLABLE de propósito: mensagem de número desconhecido é guardada
-- mesmo assim (anti-invenção: não descartamos dado real, só não vinculamos).

create table if not exists public.whatsapp_mensagens (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  direcao text not null check (direcao in ('in', 'out')),
  wamid text unique,            -- id da Meta (dedup de re-entrega de webhook)
  tipo text,                    -- 'text' | 'button' | 'interactive' | 'image' | ...
  corpo text,                   -- texto extraído; null p/ mídia sem caption
  enviada_em timestamptz not null default now(),
  raw jsonb,                    -- payload original da Meta (auditoria/debug)
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_mensagens_lead_idx
  on public.whatsapp_mensagens(lead_id, enviada_em);

-- RLS: mesmo padrão do workspace compartilhado (0001) — time autenticado lê tudo.
-- Quem ESCREVE é a Edge Function (service role, bypassa RLS).
alter table public.whatsapp_mensagens enable row level security;
drop policy if exists "auth full access" on public.whatsapp_mensagens;
create policy "auth full access" on public.whatsapp_mensagens
  for all to authenticated using (true) with check (true);

-- Estado da conversa da Olivia no lead (máquina de estados da Fase B; a Fase A
-- só marca 'conversando' quando chega resposta). Valores:
--   'aguardando'  → template enviado, sem resposta ainda
--   'conversando' → lead respondeu, janela de 24h aberta
--   'agendando'   → propondo horários (Fase C)
--   'agendado'    → reunião marcada (objetivo!)
--   'handoff'     → humano assumiu (LLM incerto / pedido explícito)
--   'optout'      → pediu pra parar — NUNCA mais mensagear (LGPD)
alter table public.leads
  add column if not exists olivia_estado text
    check (olivia_estado in ('aguardando','conversando','agendando','agendado','handoff','optout')),
  add column if not exists olivia_handoff_motivo text,
  add column if not exists reuniao_at timestamptz,
  add column if not exists reuniao_link text,
  -- Também em 0010_fase2_base.sql (branch do re-layout): ambas aditivas e
  -- idempotentes, qualquer ordem de aplicação funciona. O webhook casa o número
  -- de quem responde contra whatsapp_phone E whatsapp_dono.
  add column if not exists whatsapp_dono text;

create index if not exists leads_olivia_estado_idx on public.leads(olivia_estado);
