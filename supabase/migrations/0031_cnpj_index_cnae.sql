-- 0031: índice (uf, cnae) no cnpj_index para a busca em massa por setor.
-- =============================================================================
-- O ETL da Receita (scripts/load-rf-cnpj.mjs) carrega empresas por CNAE+UF. Para
-- puxar "todas as docerias de SP" do índice local (de graça, sem Places), a
-- consulta é `where uf = 'SP' and cnae like '4721%'`. Este índice composto
-- atende igualdade em uf + faixa de prefixo em cnae. Aditivo e idempotente.
-- =============================================================================

create index if not exists cnpj_index_uf_cnae on public.cnpj_index (uf, cnae);
