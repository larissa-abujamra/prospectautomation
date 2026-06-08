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

### `instagram-followers` (Etapa 01 — seguidores automáticos)

Recebe `{ handle }` e devolve `{ followers: number | null }` (Scrapingdog, ~15
créditos/perfil). A chave fica **só no servidor** (`SCRAPINGDOG_API_KEY`).

```sh
supabase functions deploy instagram-followers
```

Após uma busca, o frontend chama isto **em segundo plano** (concorrência 3) só para
os leads que têm `instagram_handle` e ainda não têm `instagram_followers` — sem
travar a tabela; a coluna preenche conforme cada perfil volta. Perfil privado/erro →
fica `null` ("—"). Quem não tem handle não é tentado (descobrir handle faltante fica
para depois). Import por CSV segue como fallback manual.

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
supabase secrets set SCRAPINGDOG_API_KEY=...     # Google Search + scrape + Instagram
supabase secrets set OPENROUTER_API_KEY=...      # juiz Claude (só p/ desempate)
supabase functions deploy enriquecer-lead
```

> **BrasilAPI / cnpj.ws / cnpja não usam chave** (dados oficiais + QSA, grátis). O
> `cpfcnpj` e o Perplexity Sonar foram removidos desta função.

Pipeline:

0. **Nome limpo** — tira o sufixo `"- bairro, São Paulo - SP, …"` que o Places gruda e o
   bairro solto no fim do nome (mantém o original para o juiz comparar).
1. **Google Search (Scrapingdog)** — query `"<nome limpo>" cnpj <cidade>` (aspas importam).
2. **CNPJ pela URL** — extrai o CNPJ dos resultados na ordem **link → título → snippet**
   (páginas tipo `cnpj.biz/<14díg>` trazem o número na URL); valida **mod-11**; dedup, cap 5.
   Se nada sair dos metadados, **faz scrape** da 1ª–2ª URL de agregador via Scrapingdog
   (`/scrape?dynamic=true`, passa pelo anti-bot) e extrai do HTML.
3. **Confirmação + QSA** — cada candidato é confirmado na fonte oficial, tentando
   **BrasilAPI → cnpj.ws → cnpja** (retry/backoff em 429); só seguem os que existem.
4. **Juiz (Claude/OpenRouter)** — só se houver **>1** confirmado; 1 só → usa direto. Trava:
   `best_cnpj` da lista ou `null`; `confidence < 0.5` → `missing`.
5. **Dono** — do QSA (sócio "Administrador"; ou o único sócio).
6. **Seguidores** — Scrapingdog (best-effort; falha não trava o resto).

Anti-invenção: o resultado do Google **propõe**, a fonte oficial **confirma**. Logs
(painel → Functions): a query, os `link`s, os CNPJs extraídos e qual fonte confirmou.

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
