-- 0030: estado 'paused' nos jobs de busca em massa (pausar/retomar).
-- =============================================================================
-- A 0029 criou o CHECK de status sem 'paused'. Sem este aditivo, pausar um job
-- (scrape-control) falha na constraint. O worker já só pega jobs 'pending'/
-- 'running', então 'paused' e 'cancelled' são naturalmente ignorados. Aditivo.
-- =============================================================================

alter table public.scrape_jobs drop constraint if exists scrape_jobs_status_check;

alter table public.scrape_jobs
  add constraint scrape_jobs_status_check
  check (status in ('pending', 'running', 'paused', 'done', 'cancelled'));
