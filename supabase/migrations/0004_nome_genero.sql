-- Módulo WhatsApp (Parte C — gênero do nome para escolher o template).
-- Coluna aditiva e NULLABLE: 'f' | 'm' (artigo a/o). Classificada por LLM no
-- hubspot-sync (default 'f' em qualquer incerteza). Distinta dos outros campos.

alter table public.leads
  add column if not exists nome_genero text;
