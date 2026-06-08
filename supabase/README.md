# Supabase

Backend deste projeto: Postgres + Auth (mesmo padrão do outro projeto da Squad).

## Migrations

As migrations ficam em `supabase/migrations/`, numeradas em ordem de aplicação.

- `0001_init.sql` — cria o enum `lead_status`, a tabela `public.leads` (única fonte
  de verdade do funil), índices, o trigger de `updated_at` e a policy de RLS.
- `0002_funnel.sql` — adiciona `setor` e `hubspot_exported_at` (+ índice de `setor`).

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

### `buscar-negocios` (Etapa 01 — sourcing genérico por setor)

Descobre negócios de qualquer setor (`"<setor> em <bairro>, São Paulo"`) via Google
Places e faz upsert em `public.leads`, gravando o `setor`. A chave do Google fica
**só no servidor**, como secret:

```sh
supabase secrets set GOOGLE_PLACES_API_KEY=sua-chave
supabase functions deploy buscar-negocios
```

> Substitui a antiga `buscar-docerias` (Módulo 1). Após o deploy da nova, remova a
> antiga para não ficar órfã: `supabase functions delete buscar-docerias`.
> O secret aceita `GOOGLE_PLACES_API_KEY` **ou** o nome antigo `GOOGLE_MAPS_API_KEY`
> (compatibilidade — não precisa recriar se já tinha o antigo).

Antes, no Google Cloud: ative o **billing** e **restrinja a chave** à Places API
(Text Search + Place Details são cobrados por requisição). O upsert por
`google_place_id` evita re-buscar/re-cobrar leads já existentes.

Entrada: `{ setor, bairro, max?, comSeguidores? }`. Com `comSeguidores: true`, busca
os seguidores do Instagram (Scrapingdog, ~15 créditos/perfil) dos resultados que
tiverem `instagram_handle` — requer `SCRAPINGDOG_API_KEY`; falha degrada para `null`.

A função é protegida por JWT (só usuários autenticados conseguem invocá-la) e usa a
service role para escrever ignorando a RLS — a autorização já aconteceu na borda.

> Os seguidores do Instagram **não** vêm do Places. São preenchidos pelo toggle acima,
> por edição inline, import de CSV ou pela função `enriquecer-lead`. O helper de
> Scrapingdog é compartilhado em `functions/_shared/instagram.ts`.

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

### `exportar-hubspot` (Etapa 02 — handoff) — STUB

Por enquanto **não chama o HubSpot**: valida se cada lead tem o mínimo pra virar card
(nome + CNPJ + dono) e marca `hubspot_exported_at = now()`; retorna
`{ exported, skipped }`. Idempotente (reexportar só atualiza a data).

```sh
supabase functions deploy exportar-hubspot
```

Para ligar a API real depois:

- O token vira o secret `HUBSPOT_TOKEN` (Private App) — nunca no frontend.
- A constante `HUBSPOT_FIELD_MAP` no topo do arquivo documenta o de-para (company /
  contact / deal) e há um `TODO` marcando onde entram os `fetch` do CRM v3
  (`/crm/v3/objects/{companies,contacts,deals}` + associations). O envio real é quem
  cria o card e dispara o fluxo de WhatsApp no HubSpot — não há UI de mensagem no app.

## Autenticação

Não há signup público — é ferramenta interna. Crie os usuários do time manualmente
no painel: **Authentication → Users → Add user** (email + senha). Esses são os
logins usados na tela `/login` do app.

## Variáveis de ambiente

O frontend lê `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (ver `.env.example`
na raiz). Os valores estão em **Settings → API** no painel do Supabase.
