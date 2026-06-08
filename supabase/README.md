# Supabase

Backend deste projeto: Postgres + Auth (mesmo padrão do outro projeto da Squad).

## Migrations

As migrations ficam em `supabase/migrations/`, numeradas em ordem de aplicação.

- `0001_init.sql` — cria o enum `lead_status`, a tabela `public.leads` (única fonte
  de verdade do funil), índices, o trigger de `updated_at` e a policy de RLS.

### Como aplicar

Esta migration **precisa ser aplicada manualmente** no projeto Supabase. Duas opções:

1. **Painel (SQL Editor)** — recomendado para começar:
   abra o projeto no painel → **SQL Editor** → cole o conteúdo de
   `0001_init.sql` → **Run**.

2. **CLI** — se você usa a Supabase CLI com o projeto linkado:
   ```sh
   supabase db push
   ```

## Autenticação

Não há signup público — é ferramenta interna. Crie os usuários do time manualmente
no painel: **Authentication → Users → Add user** (email + senha). Esses são os
logins usados na tela `/login` do app.

## Variáveis de ambiente

O frontend lê `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (ver `.env.example`
na raiz). Os valores estão em **Settings → API** no painel do Supabase.
