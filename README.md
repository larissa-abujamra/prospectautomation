# Squad · Prospecção Docerias SP

Ferramenta **interna** do time de vendas da Squad para prospectar confeitarias/docerias
em São Paulo. Não é produto para cliente final.

Fluxo macro (funil): **descobrir → enriquecer → rotear pra visita presencial**. Cada
doceria é um *lead* com um `status` que evolui ao longo do funil. A tabela `leads` é a
**única fonte de verdade**.

> **Princípio inegociável (anti-invenção):** nenhum campo é chutado. Dado não encontrado
> fica `null` no banco e aparece como "—" na UI. Nunca preencher com aproximação ou
> placeholder que pareça um dado real.

## Stack

- Vite + React + TypeScript (SPA com React Router; deploy na Vercel — `base: '/'`)
- Supabase (Postgres + Auth + Edge Functions)
- `react-router-dom`, `lucide-react`, `@tanstack/react-query`
- Fonte Fustat (`@fontsource/fustat`); UI à mão com os tokens em `src/styles/tokens.css`

## Rodando localmente

```sh
npm install
cp .env.example .env.local   # preencha com VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
npm run dev
```

As credenciais ficam em **Settings → API** no painel do Supabase. Nunca commite chaves.

## Banco de dados

Ver [`supabase/README.md`](supabase/README.md). A migration `0001_init.sql` precisa ser
aplicada manualmente (SQL Editor do painel ou `supabase db push`).

## Autenticação

Sem signup público — é ferramenta interna. As contas são criadas manualmente no painel
do Supabase (**Authentication → Users**). A tela `/login` usa email + senha.

## Estrutura

```
src/
  auth/        gate de sessão (RequireAuth) + hook useSession
  components/  AppShell (layout) + Sidebar
  lib/         client do Supabase
  pages/       Login, Leads, Mapa
  styles/      tokens.css (design system)
supabase/
  migrations/  0001_init.sql
```

## Rotas

- `/login` — fora do gate de autenticação
- `/` — Leads (cabeçalho + estado vazio; tabela real chega no próximo passo)
- `/mapa` — placeholder (mapa chega no próximo passo)

## Scripts

- `npm run dev` — servidor de desenvolvimento
- `npm run build` — type-check + build de produção
- `npm run preview` — preview do build
- `npm run lint` — ESLint

## Deploy

**Vercel** (atual). Build `vite build`, output `dist/` (auto-detectado). Como é uma
SPA com `BrowserRouter`, o [`vercel.json`](vercel.json) reescreve **todas** as rotas
para `/index.html` — sem isso, atualizar (F5) ou abrir uma rota direta (ex.: `/mapa`)
retornaria 404 do Vercel. Arquivos estáticos reais (`/assets/...`) têm precedência
sobre a regra, então só caminhos inexistentes caem no fallback.

**GitHub Pages** (alternativa, subdiretório): buildar com a base do repositório —
`BASE_PATH=/<repo>/ npm run build` — e usar uma estratégia de fallback de SPA
(ex.: copiar `index.html` para `404.html`).
