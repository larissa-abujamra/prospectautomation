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

## Edge Functions

### `buscar-docerias` (Módulo 1 — sourcing)

Descobre docerias via Google Places e faz upsert em `public.leads`. A chave do
Google fica **só no servidor**, como secret:

```sh
supabase secrets set GOOGLE_MAPS_API_KEY=sua-chave
supabase functions deploy buscar-docerias
```

Antes, no Google Cloud: ative o **billing** do projeto e **restrinja a chave** à
Places API (Text Search + Place Details são cobrados por requisição). O upsert por
`google_place_id` evita re-buscar/re-cobrar leads já existentes.

A função é protegida por JWT (só usuários autenticados conseguem invocá-la) e usa a
service role para escrever ignorando a RLS — a autorização já aconteceu na borda.

> Os seguidores do Instagram **não** vêm daqui (o Places não tem esse dado). São
> preenchidos depois, via edição inline na tabela, import de CSV ou pela função
> `enriquecer-lead`.

### `enriquecer-lead` (Módulo 2 — enriquecimento)

Waterfall por lead: **CNPJ → dono (QSA) → seguidores**.

```sh
supabase secrets set CPFCNPJ_TOKEN=...
supabase secrets set SCRAPINGDOG_API_KEY=...
supabase secrets set OPENROUTER_API_KEY=...
supabase functions deploy enriquecer-lead
```

Secrets opcionais (dependem do plano cpfcnpj):

- `CPFCNPJ_PACOTE_BUSCA` — pacote da busca reversa por razão social (default `4`).
- `CPFCNPJ_PACOTE_CNPJ` — pacote da consulta de CNPJ que retorna o QSA (default `6`).
  Ajuste para o pacote do seu plano que devolve `socios`.

Pipeline:

1. **Candidatos** — busca reversa por razão social no cpfcnpj (cap de 5 candidatos).
2. **Dados oficiais** — consulta cada candidato (razão, fantasia, endereço, QSA).
3. **Disambiguação** — Claude via OpenRouter (`anthropic/claude-sonnet-4.6`,
   `temperature: 0`, só JSON). O modelo **só** pode escolher um CNPJ da lista de
   candidatos ou `null` — trava reforçada no system prompt **e** validada no código
   (CNPJ fora da lista é descartado). `confidence < 0.6` ou `null` → CNPJ `missing`.
4. **Dono** — do registro casado (responsável sócio/admin, ou sócio administrador).
5. **Seguidores** — Scrapingdog (best-effort; falha não trava o resto).

Travas:

- **Anti-invenção:** dado não encontrado/baixa confiança → `null` + `enrich_status`
  `missing`. Nunca grava um CNPJ/dono "provável".
- **LGPD:** ao gravar `socios`, mantém **apenas** `{nome, qualificacao}` — qualquer
  CPF do QSA é descartado antes de persistir.
- **Custo:** não re-enriquece quem já tem CNPJ (salvo `force: true`).

## Autenticação

Não há signup público — é ferramenta interna. Crie os usuários do time manualmente
no painel: **Authentication → Users → Add user** (email + senha). Esses são os
logins usados na tela `/login` do app.

## Variáveis de ambiente

O frontend lê `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (ver `.env.example`
na raiz). Os valores estão em **Settings → API** no painel do Supabase.
