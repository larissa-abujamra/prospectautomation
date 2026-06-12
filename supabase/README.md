# Supabase

Backend deste projeto: Postgres + Auth (mesmo padrão do outro projeto da Squad).

## Migrations

As migrations ficam em `supabase/migrations/`, numeradas em ordem de aplicação.

- `0001_init.sql` — cria o enum `lead_status`, a tabela `public.leads` (única fonte
  de verdade do funil), índices, o trigger de `updated_at` e a policy de RLS.
- `0002_funnel.sql` — adiciona `setor` e `hubspot_exported_at` (+ índice de `setor`).
- `0005_horario.sql` — adiciona `horario_funcionamento jsonb` (horário do Google Places).
- `0006_porte.sql` — adiciona `porte text` + `mei boolean` (faixa legal de porte da BrasilAPI).
- `0019_squad_leads_import.sql` — adiciona origem/idempotência do app Squad Leads
  (`squad_leads_id`, `origem`) e qualificação inbound filtrável.

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

### `instagram-followers` (Etapa 01 — @handle + seguidores automáticos)

Entrada `{ handle?, nome?, cidade? }` → `{ handle, followers }`. Se vier sem handle,
**descobre o @handle pelo Google** (1º link `instagram.com/<perfil>` dos resultados,
via Scrapingdog) e então busca os seguidores do perfil. A chave fica **só no
servidor** (`SCRAPINGDOG_API_KEY`).

```sh
supabase functions deploy instagram-followers
```

Após uma busca, o frontend chama isto **em segundo plano** (concorrência 3) para os
leads `descoberto` sem `instagram_followers` — sem travar a tabela; `@handle` e
seguidores preenchem conforme cada perfil volta. Perfil privado/sem handle/erro →
`null` ("—"). Import por CSV segue como fallback manual.

> Custo: descoberta = 1 Google Search por lead sem handle; seguidores = ~15
> créditos/perfil. Como roda pra cada lead novo da busca, é o passo que mais
> consome créditos — dimensione o volume das buscas de acordo.

### `buscar-negocios` (Etapa 01 — sourcing genérico por setor)

Descobre negócios de qualquer setor em qualquer cidade (`"<termo> em <bairro>,
<cidade>"`) via Google Places e faz upsert em `public.leads`, gravando o `setor`.
A busca por setor é inteligente (`_shared/busca_setor.ts`): o termo é expandido
em sinônimos do segmento (confeitaria → doceria, bolos…) com viés de categoria
do Places (`includedType`, não-estrito), então o resultado não depende do nome
literal do negócio. A chave do Google fica **só no servidor**, como secret:

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

### `importar-squad-leads` (Etapa 01 — inbound da waitlist Squad Leads)

Sincroniza leads inbound do app externo Squad Leads (`https://squad-leads.vercel.app/api`)
para `public.leads`, com dedup por `squad_leads_id` (separado de `google_place_id`).
O botão **Sincronizar Squad Leads** na etapa Buscar chama esta função manualmente.

```sh
supabase secrets set SQUAD_LEADS_ADMIN_PASSWORD=...   # senha admin do app fonte
supabase functions deploy importar-squad-leads
```

A função é protegida por JWT (só usuários autenticados conseguem invocar), faz login
no app fonte, busca `/admin/leads?sort=date_desc`, normaliza telefone/Instagram,
preserva sinais auto-declarados em `inbound_meta` e devolve apenas contagens
(`imported`, `updated`, `skipped`, `total`). `hasCnpj=sim` é só hint: **não**
preenche `cnpj`; o enriquecimento oficial continua descobrindo/validando CNPJ.

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

### `exportar-hubspot` (Etapa 02 - handoff)

Cria/atualiza o contato e o negócio no HubSpot, associados no pipeline de
prospecção. É idempotente: usa `google_place_id` como chave de dedup do contato
e grava `hubspot_exported_at`.

```sh
supabase functions deploy exportar-hubspot
```

Secret: `HUBSPOT_PRIVATE_APP_TOKEN` (Private App), nunca no frontend.

### `encontrar-whatsapp` (Módulo WhatsApp · Parte A — descoberta do número)

Waterfall por lead: **telefone do Google (só celular) → bio/link do Instagram →
site → Perplexity Sonar (busca web)**. Normaliza pra E.164 e classifica
fixo/celular (fixo não é whatsapp-able). Grava `whatsapp_phone` +
`whatsapp_source` + `whatsapp_status` (`found`/`missing`).
Lógica pura e testada em `_shared/phone.ts`; o fetch de site passa pela guarda
anti-SSRF em `_shared/ssrf.ts` (allowlist de protocolo, DNS barrando IP interno,
redirects revalidados). Secrets opcionais: `SCRAPINGDOG_API_KEY` (bio do
Instagram) e `PERPLEXITY_API_KEY` (fonte 4 — a resposta do Sonar é validada em
`_shared/perplexity.ts`: só celular BR vira WhatsApp; handle/site só preenchem
campo vazio; nada inventado entra no banco).

### `hubspot-sync` (Módulo WhatsApp · Parte B+C — contato no HubSpot + gatilho)

Upsert de UM lead como **contato** no HubSpot via `crm/v3/objects/contacts/batch/upsert`,
dedup pela propriedade **única** `google_place_id` (leads não têm e-mail) →
idempotente. Classifica o **gênero do nome** (LLM via OpenRouter, default `f`) e
grava `nome_genero` no contato; com `{ trigger: true }` marca `whatsapp_outreach=ready`.
Mapeamento puro em `_shared/hubspot.ts` (+ `_shared/genero.ts`). Secret:

```sh
supabase secrets set HUBSPOT_PRIVATE_APP_TOKEN=pat-...   # app "prospect-automation-whatsapp"
supabase functions deploy hubspot-sync
```

### `enviar-whatsapp` (Módulo WhatsApp · Parte D - fallback legado Meta)

Função dormente. Dispara o template aprovado para UM lead via a **Meta WhatsApp
Cloud API**, escolhendo template por `nome_genero` e `setor`, mas **não é o
caminho de go-live atual**. O runtime ativo escreve `whatsapp_outreach=ready` e
o workflow do HubSpot envia o template.

```sh
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...    # id do número Olivia-Squad na Cloud API
supabase secrets set WHATSAPP_ACCESS_TOKEN=...        # System User token (whatsapp_business_messaging)
supabase secrets set WHATSAPP_TEMPLATE_LANG=pt_BR     # opcional; deve casar com o idioma registrado do template
supabase secrets set WHATSAPP_DAILY_CAP=20            # opcional; warm-up do número novo
supabase functions deploy enviar-whatsapp
```

> **Status:** fallback legado para validar payloads Meta ou rollback manual. Não
> configure `WHATSAPP_*` como blocker do launch HubSpot.
>
> **DRY-RUN:** sem os secrets `WHATSAPP_*` (ou com `{ dry_run: true }`), a função
> **monta e devolve o payload exato sem enviar** — dá pra validar lead, gênero→template
> e os 3 parâmetros antes de qualquer disparo real. Lógica pura testada em
> `_shared/whatsapp_send.ts`. Travas: só envia lead mensageável (anti-invenção),
> não re-envia quem já recebeu (idempotência) e respeita o teto diário (warm-up).
>
> **Template por perfil (setor):** a escolha é uma matriz **segmento × gênero**
> (`_shared/whatsapp_send.ts` -> `templateFor`/`langFor`). Confeitaria/Cafeteria/
> Doceria -> templates de doces (os `squad_prospeccao_intro_f/_m` já aprovados);
> qualquer outro setor (ou sem setor) -> `squad_intro_generic_f/_m`, que precisam
> ser **criados e aprovados no WhatsApp Manager** antes do primeiro disparo.
> Overrides opcionais: `WHATSAPP_TEMPLATE_GENERIC_F/_M` e
> `WHATSAPP_LANG_GENERIC_F/_M` (default `pt_BR`). O `hubspot-sync` também grava a
> propriedade custom `setor_grupo` (`doces`|`generic`) no contato, para os
> workflows por segmento ramificarem.

### `whatsapp-webhook` (Olivia Autônoma · Fase A - inbound, dormente)

Função dormente no launch HubSpot. Recebe webhooks da **Meta Cloud API**: status
de entrega dos envios (`sent`->`delivered`->`read`) e mensagens inbound do lead.
Só use se a conversa direta por Meta Cloud API for reativada.

```sh
supabase secrets set WHATSAPP_WEBHOOK_VERIFY_TOKEN=<string aleatória longa>
supabase secrets set WHATSAPP_APP_SECRET=<App Secret do app Meta>
supabase functions deploy whatsapp-webhook --no-verify-jwt   # a Meta chama sem JWT
```

Depois, no **Meta App Dashboard → WhatsApp → Configuration → Webhook**: Callback
URL `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`, Verify
token igual ao secret, e subscrever o campo **messages**.

> **Segurança:** o endpoint é público (`--no-verify-jwt`), então TODO POST é
> validado pela assinatura HMAC `X-Hub-Signature-256` com o App Secret; sem
> `WHATSAPP_APP_SECRET` configurado, nenhum payload é processado. Responde 200
> rápido mesmo para evento com erro interno (a Meta re-entrega em non-2xx).
>
> **Pré-requisito de arquitetura legado:** o webhook do número precisa apontar
> para o nosso app Meta. Enquanto o número estiver conectado à integração
> WhatsApp do HubSpot, as respostas vão para o inbox do HubSpot e esta função
> não recebe nada.

### `olivia-responder` (Olivia Autônoma · Fase B - cérebro, dormente)

Gera a resposta da Olivia a cada inbound: guardrails (opt-out determinístico +
gate de estado) → LLM (Claude via OpenRouter, com tools) → executa a ação. Tools:
`agendar_reuniao`, `confirmar_reuniao`, `escalar_humano`, `marcar_optout`.
**DRY-RUN por padrão.** Dormente no launch HubSpot. Disparada fire-and-forget
pelo `whatsapp-webhook` apenas se a conversa direta por Meta for reativada.

```sh
supabase secrets set OPENROUTER_API_KEY=...        # mesmo do hubspot-sync
supabase secrets set OLIVIA_MODEL=anthropic/claude-sonnet-4   # testado nesta conta
supabase secrets set OLIVIA_TRIGGER_SECRET=<aleatório>        # webhook→responder→agendar
supabase functions deploy olivia-responder --no-verify-jwt
```

> Proteções de custo/abuso (ativas): rate limit global por minuto via RPC
> `olivia_rate_hit` (`OLIVIA_MAX_POR_MIN`, default 30 -> 429); slots propostos
> expiram em 24h (re-propõe). Pré-go-live resta só validar transcripts antes de
> `OLIVIA_DRY_RUN=false`.

### `olivia-agendar` (Olivia Autônoma · Fase C - agendamento, dormente)

Fala com o **Google Calendar**. Dois modos (chamada só pela `olivia-responder`,
com `OLIVIA_TRIGGER_SECRET`): `propor` lê o free/busy e devolve 2 a 3 horários
livres (horário comercial, fuso São Paulo); `confirmar` cria o evento com **Google
Meet**, manda o convite e grava `reuniao_at`/`reuniao_link`, `olivia_estado='agendado'`,
`status='interessado'`. Requer a migration `0012`. **DRY-RUN por padrão.**

```sh
supabase secrets set GOOGLE_CLIENT_ID=...
supabase secrets set GOOGLE_CLIENT_SECRET=...
supabase secrets set GOOGLE_REFRESH_TOKEN=...      # OAuth de usuário (Gmail pessoal)
supabase secrets set GOOGLE_CALENDAR_ID=primary    # opcional
supabase functions deploy olivia-agendar --no-verify-jwt
```

> **Anti-invenção:** só propõe horário REALMENTE livre na agenda e só confirma um
> horário que foi proposto (`slotEhValido`), nunca um inventado pelo LLM.
>
> **Setup do refresh token (1 vez):** crie um OAuth Client (tipo *Web/Desktop*) num
> projeto do Google Cloud com a **Google Calendar API** ativada e o escopo
> `https://www.googleapis.com/auth/calendar.events`. Rode o consent uma vez com a
> conta que vai hospedar as reuniões (a do dono) e troque o `code` por um
> **refresh token** (não expira). Esse é o passo manual gated da Fase C,
> análogo a apontar o webhook da Meta na Fase A. Sem os secrets `GOOGLE_*`, a
> função devolve 503 com motivo claro (nada quebra silencioso).

## Autenticação

Não há signup público; é ferramenta interna. Crie os usuários do time manualmente
no painel: **Authentication -> Users -> Add user** (email + senha). Esses são os
logins usados na tela `/login` do app.

## Variáveis de ambiente

O frontend lê `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (ver `.env.example`
na raiz). Os valores estão em **Settings -> API** no painel do Supabase.
