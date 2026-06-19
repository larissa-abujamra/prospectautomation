-- 0037_olivia_conversa_memoria.sql — base de conhecimento POR CONVERSA (Fase 3)
-- =============================================================================
-- Memória estruturada da Olivia, por lead: fatos que o lead DECLAROU (anti-
-- invenção, preenchidos por extração via LLM no olivia-responder) e um resumo
-- rolante das mensagens antigas (além da janela de 40). Injetados no system
-- prompt (formatarMemoria) pra a Olivia "lembrar" e nunca perguntar duas vezes.
-- Aditivo e idempotente. conversa_fatos default '{}' pra simplificar o merge.
-- =============================================================================

alter table leads add column if not exists conversa_fatos jsonb not null default '{}'::jsonb;
alter table leads add column if not exists conversa_resumo text;
