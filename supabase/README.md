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

### `olivia-hubspot-webhook` (HubSpot inbox + write-back de workflow)

Endpoint público usado por dois caminhos:

1. **Inbox do HubSpot:** recebe `conversation.newMessage`, valida assinatura v3
   com `HUBSPOT_APP_CLIENT_SECRET`, grava respostas em `whatsapp_mensagens` e
   promove `whatsapp_send_status='replied'` sem sobrescrever estados fortes da
   Olivia.
2. **Workflow/custom code:** depois da ação "enviar WhatsApp" no HubSpot, chama
   o mesmo endpoint com `OLIVIA_HUBSPOT_WRITEBACK_SECRET` (fallback:
   `OLIVIA_TRIGGER_SECRET`) para confirmar que o workflow marcou o contato como
   enviado. Isso corrige o app quando o HubSpot muda `whatsapp_outreach=sent`,
   mas o Supabase ainda está com
   `whatsapp_send_status=null`.

```sh
supabase functions deploy olivia-hubspot-webhook --no-verify-jwt
```

Contrato do write-back:

```http
POST https://jcfeydjzjnjdeubrchbg.supabase.co/functions/v1/olivia-hubspot-webhook
Authorization: Bearer <OLIVIA_HUBSPOT_WRITEBACK_SECRET>
Content-Type: application/json

{
  "hubspot_contact_id": "12345",
  "status": "sent",
  "occurred_at": "2026-06-15T18:10:00Z"
}
```

Também aceita `x-olivia-secret: <OLIVIA_HUBSPOT_WRITEBACK_SECRET>`. Status
aceitos: `sent`, `delivered`, `read`. `replied` continua exclusivo do webhook
assinado de inbox, que tem evidência da mensagem e do thread. A atualização é
idempotente: preenche `whatsapp_sent_at` só quando está vazio, não regride
`delivered/read/replied` para `sent` e não toca em `olivia_estado`,
`hubspot_thread_id` ou histórico de conversa.

**HubSpot Custom Code (após cada ação de envio WhatsApp):**

Configure os input fields `hs_object_id` e `whatsapp_outreach`, e adicione um
secret de custom code chamado `OLIVIA_HUBSPOT_WRITEBACK_SECRET` com o mesmo
valor configurado no Supabase:

```js
exports.main = async (event, callback) => {
  const contactId = event.inputFields.hs_object_id || event.object?.objectId
  const status = event.inputFields.whatsapp_outreach || 'sent'

  const response = await fetch(
    'https://jcfeydjzjnjdeubrchbg.supabase.co/functions/v1/olivia-hubspot-webhook',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OLIVIA_HUBSPOT_WRITEBACK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hubspot_contact_id: String(contactId),
        status,
        occurred_at: new Date().toISOString(),
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Supabase write-back failed: HTTP ${response.status}`)
  }

  callback({ outputFields: { supabase_writeback_status: response.status } })
}
```

Se usar ação nativa de webhook em vez de Custom Code, envie o mesmo JSON e o
header `Authorization: Bearer <OLIVIA_HUBSPOT_WRITEBACK_SECRET>`.

## Olivia WhatsApp: Meta-native mode

Olivia now supports two runtime transports:

- `OLIVIA_MESSAGING_PROVIDER=hubspot` (default/rollback): replies through HubSpot
  Conversations when `hubspot_thread_id` exists and uses HubSpot workflows for
  initial/follow-up/owner templates.
- `OLIVIA_MESSAGING_PROVIDER=meta` (target): replies, owner handoff templates and
  48h follow-ups go through Meta WhatsApp Cloud API directly. HubSpot remains CRM
  sync only.

Required secrets for Meta mode:

```sh
supabase secrets set OLIVIA_MESSAGING_PROVIDER=meta
supabase secrets set WHATSAPP_ACCESS_TOKEN=...        # system user token; rotate after setup
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...     # Meta phone number id
supabase secrets set WHATSAPP_BUSINESS_ACCOUNT_ID=... # WABA id, for ops/reference
supabase secrets set WHATSAPP_APP_SECRET=...          # validates X-Hub-Signature-256
supabase secrets set WHATSAPP_WEBHOOK_VERIFY_TOKEN=...# callback handshake
```

Optional overrides: `WHATSAPP_GRAPH_VERSION` (default `v21.0`),
`WHATSAPP_FOLLOWUP_TEMPLATE` (default `squad_followup_1`),
`WHATSAPP_FOLLOWUP_LANG` (default `pt_BR`), `WHATSAPP_TEMPLATE_GENERIC_F/_M`,
`WHATSAPP_LANG_*`.

Deploy/public callback:

```sh
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy olivia-responder --no-verify-jwt
supabase functions deploy olivia-followup --no-verify-jwt
supabase functions deploy enviar-whatsapp
```

Meta App Dashboard → WhatsApp → Configuration:

- Callback URL: `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`
- Verify token: same value as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Subscribe field: `messages`

Smoke test after secrets + webhook are correct:

1. Send a controlled intro with `enviar-whatsapp` to a user-owned number.
2. Reply from WhatsApp and confirm `whatsapp-webhook` stores an inbound row in
   `whatsapp_mensagens` and triggers `olivia-responder`.
3. Confirm Olivia replies via Meta (`wamid` without `hs:` prefix).
4. Run `olivia-followup` with dry-run first, then `{"dry_run": false}` on one
   eligible test lead.

Rollback is just:

```sh
supabase secrets set OLIVIA_MESSAGING_PROVIDER=hubspot
```

Current Meta blocker from the 2026-06-17 probe: the provided token is valid for
principal `squad_olivia_v1`, but Graph returned zero assigned WhatsApp Business
Accounts on `/me/assigned_whatsapp_business_accounts` and missing permission on
`/me/businesses`. Until the Meta app/system user is assigned to WABA
`1301313551562370` (Inner AI) with `whatsapp_business_messaging` and
`whatsapp_business_management`, or a token from that assigned system user is used,
the Cloud API cannot discover/control Olivia's phone number.

### `enviar-whatsapp` (Módulo WhatsApp · Parte D - Meta Cloud API)

Dispara o template aprovado para UM lead via a **Meta WhatsApp Cloud API**,
escolhendo template por `nome_genero` e `setor`. Em `OLIVIA_MESSAGING_PROVIDER=meta`
este é o caminho de primeira mensagem; em rollback HubSpot continua útil como
dry-run/validador de payload.

```sh
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...    # id do número Olivia-Squad na Cloud API
supabase secrets set WHATSAPP_ACCESS_TOKEN=...        # System User token (whatsapp_business_messaging)
supabase secrets set WHATSAPP_TEMPLATE_LANG=pt_BR     # opcional; deve casar com o idioma registrado do template
supabase secrets set WHATSAPP_DAILY_CAP=20            # opcional; warm-up do número novo
supabase functions deploy enviar-whatsapp
```

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

### `whatsapp-webhook` (Olivia Autônoma · Fase A - inbound Meta)

Recebe webhooks da **Meta Cloud API**: status de entrega dos envios
(`sent`->`delivered`->`read`) e mensagens inbound do lead. Em Meta mode, é o
entrypoint que alimenta `whatsapp_mensagens` e dispara `olivia-responder`.

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
> **Pré-requisito de arquitetura:** o webhook do número precisa apontar para o
> nosso app Meta. Enquanto o número estiver conectado exclusivamente à integração
> WhatsApp do HubSpot, as respostas vão para o inbox do HubSpot e esta função não
> recebe nada.

### `olivia-responder` (Olivia Autônoma · Fase B - cérebro)

Gera a resposta da Olivia a cada inbound: guardrails (opt-out determinístico +
gate de estado) → LLM (Claude via OpenRouter, com tools) → executa a ação. Tools:
`agendar_reuniao`, `confirmar_reuniao`, `escalar_humano`, `marcar_optout`.
**DRY-RUN por padrão.** Disparada fire-and-forget pelo `whatsapp-webhook` em Meta
mode ou pelo webhook HubSpot em rollback. `OLIVIA_MESSAGING_PROVIDER=meta` força
respostas pela Cloud API mesmo quando o lead ainda tem `hubspot_thread_id`.

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
> **Setup do refresh token (1 vez):** crie um OAuth Client (tipo *Web*) num
> projeto do Google Cloud com a **Google Calendar API** ativada e redirect URI
> `http://localhost:53682`. Depois rode `node scripts/google-refresh-token.mjs`
> e faça o consent com a conta certa (ver abaixo). O script imprime o comando
> `secrets set` pronto. Sem os secrets `GOOGLE_*`, a função devolve 503 com
> motivo claro (nada quebra silencioso).

#### Disponibilidade do TIME (multi-rep)

A `olivia-agendar` consulta o **free/busy de vários calendários numa chamada só**
e propõe apenas horários em que pelo menos um rep está livre (guardando QUAIS).
No `confirmar`, escolhe um rep livre (round-robin estável por lead), cria o
evento com Meet e o convida. Configuração:

```sh
supabase secrets set OLIVIA_REPS='[{"nome":"Fulano","email":"fulano@innerai.com"},{"nome":"Ciclana","email":"ciclana@innerai.com"}]'
```

**Restrição que define o setup:** o free/busy só enxerga calendários que a conta
do refresh token consegue ver. Três caminhos:

1. **Conta do Workspace (recomendado):** rode o consent do
   `scripts/google-refresh-token.mjs` com uma conta `@innerai.com` (ex.:
   `stefano@innerai.com` ou `growth@innerai.com`). Dentro do mesmo domínio o
   free/busy dos colegas é visível por padrão → `OLIVIA_REPS` funciona direto.
2. **Gmail pessoal (atual):** cada rep precisa compartilhar a agenda com esse
   Gmail (mínimo "Ver apenas livre/ocupado") em Configurações da agenda →
   Compartilhar com pessoas específicas. Funciona, mas é um passo manual por rep.
3. **Service account com domain-wide delegation:** o mais robusto pra produção
   (sem token de humano), mas exige um super-admin do Workspace autorizar os
   escopos no Admin Console.

Reps cujo calendário não pôde ser lido são **omitidos** (anti-invenção: não
afirmamos disponibilidade de quem não conseguimos ler). A escrita tenta a agenda
do rep e, sem permissão (403), cria na `primary` com o rep como convidado — o
evento aparece na agenda dele do mesmo jeito.

### `olivia-followup` (Olivia Autônoma · Fase D - follow-up 48h sem resposta)

Follow-up ÚNICO para quem recebeu a intro e **nunca respondeu**: seleciona leads
com `whatsapp_sent_at` >= 48h, sem resposta (`whatsapp_send_status` ≠ replied,
`olivia_estado` nulo/`aguardando`) e sem follow-up anterior
(`followup_enviado_em` nulo — migration `0021`, one-shot). Em HubSpot mode, marca
`whatsapp_outreach='followup'` no contato; em Meta mode, envia diretamente o
template `squad_followup_1` pela Cloud API e grava o `wamid`. Teto de 25
leads/execução; lógica pura testada em `_shared/olivia_followup.ts`.

```sh
supabase functions deploy olivia-followup --no-verify-jwt   # auth = x-olivia-secret
```

Secrets: `OLIVIA_TRIGGER_SECRET` (+ URL/service role). Em HubSpot mode também
requer `HUBSPOT_PRIVATE_APP_TOKEN`; em Meta mode requer
`WHATSAPP_PHONE_NUMBER_ID` e `WHATSAPP_ACCESS_TOKEN`.

> **DRY-RUN por padrão:** POST com `{"dry_run": true}` (ou corpo vazio) só
> relata quem SERIA selecionado (`selecionados`, `leads`, `descartados` com
> motivo). Só `{"dry_run": false}` dispara de verdade.

**Agendamento:** `.github/workflows/olivia-followup.yml` roda 2x/dia em dias
úteis (13:00 e 17:00 UTC = 10:00/14:00 BRT) com `dry_run=false`. Requer o
secret **`OLIVIA_TRIGGER_SECRET` nos GitHub secrets do repositório** (Settings →
Secrets and variables → Actions), mesmo valor do secret do Supabase.

**Workflow do HubSpot (criação MANUAL, 1 vez, somente rollback HubSpot):** a API
de automação v4 é bloqueada por escopo neste portal (403), então o workflow
precisa ser criado na UI:

1. Automations → Workflows → criar workflow de **contato**.
2. Gatilho de inscrição: `whatsapp_outreach` **= followup** (e marcar
   **re-inscrição** quando a propriedade mudar para esse valor).
3. Ação: **enviar mensagem do WhatsApp** com o template **`squad_followup_1`**
   (pt_BR, sem variáveis — submetido à Meta em 11/06; precisa estar **aprovado**
   e sincronizado no dropdown do HubSpot antes de ativar).
4. Ativar. O guard anti-spam já existe: quem responde vira
   `whatsapp_outreach='replied'` (olivia-hubspot-webhook) e nunca entra.

## Autenticação

Não há signup público; é ferramenta interna. Crie os usuários do time manualmente
no painel: **Authentication -> Users -> Add user** (email + senha). Esses são os
logins usados na tela `/login` do app.

## Variáveis de ambiente

O frontend lê `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (ver `.env.example`
na raiz). Os valores estão em **Settings -> API** no painel do Supabase.
