# Olivia Platform Maintenance Loop

Recurring health/maintenance checklist for the Olivia WhatsApp SDR platform
(HubSpot Conversations + Supabase edge functions) and the meeting-reminder flow.

**Cadence:** twice daily — morning ~09:11 and evening ~18:07 (America/Sao_Paulo),
via session crons (see "Scheduling" below).
**Scope chosen by user (2026-06-22):** Reminder flow + delivery · Olivia responder
health · Follow-up + data integrity. (Cost/cron audit intentionally excluded.)

This doc is the source of truth. The cron prompt just says "run the maintenance
loop per this runbook." Update the checks here, not in the cron.

---

## Credentials & endpoints

- **Supabase SQL** (read-only checks): `POST https://api.supabase.com/v1/projects/jcfeydjzjnjdeubrchbg/database/query`
  with header `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` (from `.env.local`).
  Body: `{"query": "<SQL>"}`. Project ref `jcfeydjzjnjdeubrchbg`.
- **HubSpot REST**: `Authorization: Bearer $HUBSPOT_PRIVATE_APP_TOKEN` (`.env.local`).
  Portal `50173893`. NOTE: this token lacks the `automation` scope → workflow
  enrollment runs can NOT be read via API; use Playwright UI for those.
- **Playwright MCP**: logged into HubSpot via Google SSO (stefanogebara@gmail.com).
  Re-login at app.hubspot.com → Entrar com Google if the session dropped.

All checks are READ-ONLY. Never modify a workflow, contact, lead, or send a
message during a maintenance run. Report findings only.

---

## Check 1 — Reminder flow + delivery

Workflow **"Lembrete de reunião 9h"** (id `1840516149`), trigger "Data da reunião
é Hoje", chain: Atraso(09:00 -03) → Gerenciar assinaturas (opt-in WhatsApp
Transactional) → Enviar mensagem do WhatsApp (template `lembrete_reuniao_squad`).

Via Playwright:
1. Open `https://app.hubspot.com/workflows/50173893/platform/flow/1840516149/edit`
   → confirm status **LIGADO**. If DESLIGADO, flag it (someone turned it off).
2. "Histórico de desempenho" → "Histórico da inscrição", filter range = today.
3. For each enrolled contact, the execution log should show, all "Sucesso":
   - "Atraso concluído"
   - "O status da assinatura foi atualizado com sucesso"
   - WhatsApp send → "Ação bem-sucedida" (note: "Aguardando confirmação da
     entrega" is normal/async, not a failure).
4. Report: # enrolled today, # fully delivered, # with errors + the failing step.

Expected baseline: enrollments = number of contacts whose `data_reuniao` = today.
Cross-check that count in Supabase (reuniao_at is the SP-day mirror):
```sql
select count(*) as meetings_today
from public.leads
where reuniao_at >= date_trunc('day', now() at time zone 'America/Sao_Paulo')
  and reuniao_at <  date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '1 day';
```
**Zero enrolled on a day with zero meetings is EXPECTED — not a failure.** Say so plainly.

---

## Check 2 — Olivia responder health

a) **Operational errors (last 24h)** — the `olivia_erros` table is where functions
log failures (LLM, agenda, send, OCR, audio, etc.):
```sql
select fonte, nivel, count(*) as n, max(created_at) as ultimo,
       (array_agg(mensagem order by created_at desc))[1] as exemplo
from public.olivia_erros
where created_at > now() - interval '24 hours'
group by fonte, nivel
order by n desc;
```
Flag any `nivel='error'` cluster. Quote the example message + count.

b) **Stuck conversations** — inbound with no Olivia reply. A live chat where the
last message is inbound ('in') and it's been >1h is the smell:
```sql
with last_msg as (
  select distinct on (lead_id) lead_id, direcao, enviada_em
  from public.whatsapp_mensagens
  where lead_id is not null
  order by lead_id, enviada_em desc
)
select l.id, l.olivia_estado, lm.enviada_em as ultima_msg,
       round(extract(epoch from (now()-lm.enviada_em))/3600.0,1) as horas
from last_msg lm
join public.leads l on l.id = lm.lead_id
where lm.direcao = 'in'
  and l.olivia_estado in ('conversando','agendando')
  and lm.enviada_em < now() - interval '1 hour'
order by lm.enviada_em asc
limit 30;
```
A few are normal (client mid-conversation); a spike (>~10) or items >6h old =
investigate (webhook down? responder erroring? check olivia_erros).

c) **Throughput sanity (last 24h)** — did Olivia send anything at all?
```sql
select direcao, count(*) from public.whatsapp_mensagens
where enviada_em > now() - interval '24 hours' group by direcao;
```
Zero 'out' over a full day with inbound 'in' present = responder likely broken → escalate.

d) **State distribution** (context for the above):
```sql
select olivia_estado, count(*) from public.leads
where olivia_estado is not null group by olivia_estado order by count(*) desc;
```

---

## Check 3 — Follow-up + data integrity

a) **Nudge / continuation pipeline** — is the 23h/24h re-engagement flowing?
```sql
select count(*) filter (where olivia_nudge_em   > now() - interval '24 hours') as nudges_24h,
       count(*) filter (where olivia_reengajar_em > now() - interval '24 hours') as continuacoes_24h
from public.leads;
```
Also dry-run the selector RPC to see how many SHOULD be nudged right now:
```sql
select count(*) from olivia_chats_para_nudge(23, 50);
```
A large backlog here with zero nudges_24h = the olivia-nudge cron isn't firing.

b) **Reminder data integrity** — upcoming meetings that LACK the HubSpot props the
9h flow needs. reuniao_at is set in Supabase; data_reuniao/hora_reuniao must be
mirrored to HubSpot (PR #92 code). Find future meetings missing the mirror by
spot-checking the contact in HubSpot:
```sql
select id, hubspot_contact_id, reuniao_at
from public.leads
where reuniao_at > now()
  and reuniao_at < now() + interval '7 days'
  and olivia_estado = 'agendado'
order by reuniao_at asc;
```
For each (or a sample), GET the HubSpot contact and confirm `data_reuniao` +
`hora_reuniao` are populated:
`GET /crm/v3/objects/contacts/{hubspot_contact_id}?properties=data_reuniao,hora_reuniao`.
Flag any agendado lead with a future reuniao_at but empty data_reuniao/hora_reuniao
— that contact will NOT get its reminder.

c) **HubSpot↔Supabase sync drift** — agendado/conversando leads with no
hubspot_contact_id (can't be enrolled in any HubSpot flow):
```sql
select count(*) from public.leads
where olivia_estado in ('conversando','agendando','agendado')
  and (hubspot_contact_id is null or hubspot_contact_id = '');
```
Non-zero = sync gap; list a few ids.

---

## Report format

Post a concise digest to the user (not raw dumps):

```
🩺 Olivia maintenance — <date> <morning|evening>
1. Reminder flow: <status LIGADO/OFF> · <N> enrolled today · <N> delivered · <N> failed (<reason>)
2. Responder:     <N> errors/24h (<top fonte>) · <N> stuck chats · out/in 24h = <a>/<b>
3. Follow-up:     nudges 24h=<n> contin=<n> · <N> upcoming meetings missing props · <N> sync gaps
⚠️  Issues: <bulleted, with root cause if known>   |   ✅ All green
```
If everything is green, one line is enough. Only go long on anomalies.
Never auto-fix in a maintenance run — surface the issue and propose the fix.

---

## Scheduling

Session crons (in-memory, fire only while a Claude REPL is running & idle;
recurring jobs auto-expire after 7 days):
- Morning: `11 9 * * *` → "run the Olivia maintenance loop per
  .claude/plans/2026-06-22-olivia-maintenance-loop/README.md"
- Evening: `7 18 * * *` → same.

**Durability caveat:** these only fire if Claude is running at that time. For
true unattended monitoring, port Checks 1–3 into a Supabase Edge Function on a
daily `pg_cron`/scheduled trigger (HubSpot API + SQL portions are server-runnable;
the workflow-enrollment UI check would need the `automation` scope added to the
private app token, or a Conversations/messages-API delivery query instead).
