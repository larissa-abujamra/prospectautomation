# Prod Audit — prospectautomation — 2026-06-18

Full audit (backend, security, data, frontend/UI/UX) of https://prospectautomation.vercel.app.
3 parallel agents (backend/security/data) + main-thread Playwright. Internal shared-workspace tool.

## Frontend / UI / UX — ✅ healthy
- `/olivia`, `/prospectar`: 0 console errors. New features render (Erros tab, kill switch, reschedule controls). Reschedule calendar-move proven live (event moved on Google Calendar).

## CRITICAL — none

## HIGH
- **H1 — DEBUNKED (no action):** backend agent flagged "OLIVIA_DRY_RUN=true blocking all sends" — FALSE. They called functions in dry-run mode. Reality: **358 free-form sends/48h, 327/6h**, last 18:55 today. Sends work.
- **H2 — Migration filename collisions** (concurrent work): `0028_olivia_nudge` + `0028_whatsapp_ddd_mismatch`; `0029_olivia_remarcar` + `0029_scrape_jobs`. Both applied via Management API (columns exist), but `supabase db push` dedups by version number → a future migration could be silently skipped. FIX: renumber to unique versions (e.g. the whatsapp_ddd/scrape_jobs pair → 0030/0031).
- **H3 — scrape-worker auth mismatch** (busca-massa, Cursor WIP): `scrape-worker` calls `buscar-grade`/`geocodar-local` with `x-olivia-secret`, but those use `requireAuthenticatedUser` (user JWT). Likely 401 → the bulk-scan worker may not actually run. VERIFY before relying on busca-massa.
- **(sec) PostgREST `.or()` phone interpolation** in `whatsapp-webhook`/`olivia-hubspot-webhook`: webhook phone digits interpolated into a filter string (only `\D`-strip guards). Harden: assert `/^\d{10,15}$/` before interpolation.

## MEDIUM
- **config.toml verify_jwt drift:** `enriquecer-lead`, `encontrar-whatsapp`, `hubspot-sync` live=`false` but config=`true`. Next deploy flips them to `true` (correct for these user-facing fns) — low harm, but reconcile to avoid surprises.
- **Stuck `agendando` leads** (Chocolatim ~21h, all slots expired; Motchimu): no re-offer until lead messages. The NEW 23h nudge covers `agendando` → will re-engage once it fires. Verify nudge cron runs on schedule.
- **Raw error messages to client** (PostgREST/provider `e.message` returned): info leak, internal-only low impact, one-line fixes (log internally, return generic).
- **olivia-responder rate-limit + lock fail-open** on DB error: documented trade-off; add prod alert.
- **scrape-worker uses hardcoded-path secret** to authenticate cross-function (see H3).

## LOW
- 2 legacy `+34` (Spanish) fabricated phone numbers (pre-fix artifacts: Bella Napoli E2E + 1) — cleanup; the fabrication fix stopped new ones.
- 14 orphan `whatsapp_mensagens` (lead_id null) — E2E test pollution today.
- `olivia_erros` empty — no errors logged yet (stuck-agendando leads predate the logging deploy); instrumentation is wired, just unused so far.
- Scrapingdog API key passed as URL query param (log-exposure risk) — prefer header auth.
- 6 functions missing from config.toml (`buscar-grade`, `geocodar-local`, `scrape-*`, `autocomplete-local`) — verify_jwt undocumented → reconcile.

## Funnel health (data agent)
- 2,040 leads; 711 created in 24h (bulk run active). 569 dispatched → 167 replied (29%) → 145 conversando → 8 agendado (~1.4% booking).
- 29% reply is healthy for cold WhatsApp. conversando→agendado is the thin point (the new nudge targets exactly this).
- Nudge/no-show marker columns empty = EXPECTED (features shipped today; eligible chats are >24h → skipped). Confirm the new GitHub crons fire on schedule over the next day.

## Note on "fire 200"
327 sends in the last 6h already — adding 200 cold templates at once meaningfully raises WhatsApp tier/ban risk. Strongly recommend staged dispatch.
