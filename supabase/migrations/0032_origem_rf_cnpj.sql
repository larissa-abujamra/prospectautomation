-- 0032: origem 'rf_cnpj' (leads importados do índice da Receita Federal).
-- =============================================================================
-- A busca em massa pelo índice local da Receita (importar-cnpj-leads) insere
-- empresas como leads. Sem 'rf_cnpj' no CHECK de origem, esse insert falha.
-- Aditivo. (Leads RF entram crus — sem place_id/site/WhatsApp — e seguem para a
-- descoberta/enriquecimento como qualquer lead 'descoberto'.)
-- =============================================================================

alter table public.leads drop constraint if exists leads_origem_check;

alter table public.leads
  add constraint leads_origem_check
  check (origem = any (array['google_places', 'squad_leads_form', 'manual_olivia', 'rf_cnpj']));
