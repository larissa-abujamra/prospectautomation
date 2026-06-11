# Olivia — Runbook de Go-Live

Consolidação de tudo que precisa estar de pé pra ligar a Olivia (a SDR de IA que
prospecta, conversa disfarçada de humana e agenda reunião por Google Meet).
**Estado atual: a Fase A está LIVE; B e C estão construídas e DORMENTES.**

---

## 1. Arquitetura (A → B → C)

| Fase | O que faz | Funções | Estado |
|------|-----------|---------|--------|
| **A — Prospecção + cold WhatsApp** | scraping (Google Places) → enriquece → dispara o template via **workflow do HubSpot** | `buscar-negocios`, `enriquecer-lead`, `encontrar-whatsapp`, `hubspot-sync`, `exportar-hubspot` | 🟢 **LIVE** |
| **B — Conversa (humana)** | inbound → `olivia-responder` (Claude via OpenRouter) responde via **Meta Cloud API**, com pacing humano e horário comercial | `whatsapp-webhook`, `olivia-responder`, `olivia-flush` | 🟡 dormente |
| **C — Qualifica + agenda** | a responder delega à `olivia-agendar`, que cria o evento no **Google Calendar com link do Meet** | `olivia-agendar` | 🟡 dormente |

**Onde o time acompanha:** página **Olivia → Acompanhamento** (cockpit: handoff,
reuniões, conversas) + aba **Conversa** na ficha de cada lead.

⚠️ **Dois caminhos de envio diferentes:** o cold template sai pelo **workflow do
HubSpot**; as respostas da conversa saem pela **Meta Cloud API direta**. Pra a
conversa funcionar, o número que o HubSpot usa pra disparar TEM que ser o **mesmo
número WABA** ligado ao `whatsapp-webhook` — senão as respostas não chegam na Olivia.

---

## 2. Secrets (Supabase → Edge Functions)

✅ **Já configurados:** `OPENROUTER_API_KEY`, `OLIVIA_MODEL`, `OLIVIA_TRIGGER_SECRET`,
`WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `HUBSPOT_PRIVATE_APP_TOKEN`

❌ **Faltam pra Fase B (conversa):**
- `WHATSAPP_PHONE_NUMBER_ID` — número WABA da Olivia na Cloud API
- `WHATSAPP_ACCESS_TOKEN` — System User token c/ `whatsapp_business_messaging`
- `WHATSAPP_APP_SECRET` — valida o HMAC do inbound no webhook

❌ **Faltam pra Fase C (agenda):**
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_ID` (opcional; default `primary`)

⚙️ **Chaves de ativação/tuning (todas opcionais, default seguro):**
| Env | Default | Liga o quê |
|-----|---------|------------|
| `OLIVIA_DRY_RUN` | `true` (dry-run) | `false` = envia de verdade |
| `OLIVIA_HORARIO` | off | `1` = adia inbound fora do expediente |
| `OLIVIA_HORARIO_INICIO`/`_FIM`/`_TZ` | `9`/`19`/`America/Sao_Paulo` | janela do expediente |
| `OLIVIA_PACING` | on | `0` = desliga o atraso humano |
| `OLIVIA_MAX_POR_MIN` | `30` | teto de respostas/min (custo LLM) |

---

## 3. Ordem de go-live (caminho seguro)

1. **Meta WABA.** Configure os 3 `WHATSAPP_*`. Aponte o webhook da Meta pra
   `whatsapp-webhook` (verify token já existe). Confirme: é o **mesmo número** do
   disparo HubSpot.
2. **Deploy das funções B/C** (ver §4).
3. **Valide em DRY-RUN** (deixe `OLIVIA_DRY_RUN` sem setar). Mande mensagem pro
   número → o inbound aparece na aba **Conversa**; a responder calcula a resposta e
   loga `texto_que_enviaria` sem enviar. Leia vários transcripts: soa humana? nunca
   inventa preço/caso?
4. **Google Calendar.** Configure os 4 `GOOGLE_*`. Teste a `olivia-agendar`
   (propor → confirmar) → evento real + link do Meet aparecem (e na aba "Próximas
   reuniões" do cockpit).
5. **Ligue o horário comercial** (recomendado): `OLIVIA_HORARIO=1` + ative o
   pg_cron da `olivia-flush` (ver §5).
6. **Vire ao vivo:** `OLIVIA_DRY_RUN=false`, `OLIVIA_MAX_POR_MIN` conservador
   (10–15 no warm-up). Acompanhe o cockpit (fila de handoff) de perto no 1º dia.
7. **Tune** pacing + rate limit com base no comportamento real.

---

## 4. Deploy das edge functions

```bash
export SUPABASE_ACCESS_TOKEN=<token>
REF=jcfeydjzjnjdeubrchbg
npx --yes supabase@latest functions deploy olivia-responder --no-verify-jwt --project-ref $REF
npx --yes supabase@latest functions deploy olivia-flush     --no-verify-jwt --project-ref $REF
npx --yes supabase@latest functions deploy olivia-agendar   --no-verify-jwt --project-ref $REF
```

O frontend (cockpit/Conversa/chips) já sobe sozinho pela integração Vercel↔git a
cada merge na `main`.

---

## 5. Ativação do cron da `olivia-flush` (horário comercial)

Manual de propósito (liga custo recorrente + guarda o segredo no job). Roda a
cada 30min DENTRO do expediente; o schedule do pg_cron é **UTC** → 9–18:30 BRT = 12–21 UTC.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
alter database postgres set app.olivia_trigger_secret = '<OLIVIA_TRIGGER_SECRET>';

select cron.schedule('olivia-flush', '0,30 12-21 * * 1-5', $$
  select net.http_post(
    url     := 'https://jcfeydjzjnjdeubrchbg.supabase.co/functions/v1/olivia-flush',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'x-olivia-secret', current_setting('app.olivia_trigger_secret', true)),
    body    := '{}'::jsonb
  );
$$);
```

Pra desligar: `select cron.unschedule('olivia-flush');`

---

## 6. Rollback / kill-switch

- **Parar TODA resposta automática:** `OLIVIA_DRY_RUN=true` (volta a só calcular,
  não envia). Efeito imediato, sem deploy.
- **Parar só o flush noturno:** `select cron.unschedule('olivia-flush');`
- **Desligar horário/pacing:** `OLIVIA_HORARIO`/`OLIVIA_PACING` (ver §2).
- Opt-out de lead é **definitivo** (LGPD) — `olivia_estado='optout'`, nunca mais é mensageado.

---

## 7. Limitações conhecidas / dívidas

- **Colisão de numeração 0013**: `0013_rate_limit` (#36) e `0013_olivia_prelive`
  (parceiro) coexistem; ambos idempotentes/aplicados. Renomear num próximo toque
  pra o `supabase db push` não ficar ambíguo.
- **Pacing × flush**: a `olivia-flush` dispara a responder fire-and-forget; um envio
  que falhe no flush não tem retry automático (o inbound fica visível no cockpit).
- Rotacionar os tokens de management `sbp_…` (vieram por chat nesta sessão).
