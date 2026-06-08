alter table public.leads add column if not exists porte text;   -- valor cru da BrasilAPI (faixa legal de porte)
alter table public.leads add column if not exists mei boolean;  -- flag MEI (opcao_pelo_mei)
