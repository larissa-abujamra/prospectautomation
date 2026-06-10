# Olivia Autônoma — templates por perfil + conversa automática até a reunião

Proposto em 10/06/2026 (sessão Stefano). Estende o plano `2026-06-10-relayout.md`.
Objetivo final: **a Olivia conduz a conversa inteira no WhatsApp sozinha — o humano
só entra na reunião agendada.**

## Parte 1 — Template por perfil (setor)

A Meta só exige template pré-aprovado na PRIMEIRA mensagem (business-initiated).
Hoje há 2 templates por gênero (`squad_prospeccao_intro_f/_m`). A proposta é uma
matriz **segmento × gênero**:

| Grupo | Setores (campo `setor`) | Templates | Social proof |
|---|---|---|---|
| `doces` | Confeitaria, Cafeteria | `squad_intro_doces_f/_m` | Scherby's, Brigadayros, We Lov Cakes |
| `generic` | Pizzaria, Hamburgueria, Restaurante, Pet shop, Academia, Salão, Floricultura | `squad_intro_generic_f/_m` | cases gerais |

Copy do `doces` (já validada, mensagem da Olivia):

> Oi, tudo bem? Acompanho o trabalho de vocês e acho incrível!
> Eu sou a Olivia, do Squad.com — a gente ajuda docerias e confeitarias a venderem
> mais com atendimento por IA no WhatsApp (que parece humano de verdade) e uma
> solução de logística e entrega. [...] Nossa solução já está rodando em negócios
> parecidos com o de vocês, como Scherby's, Brigadayros e We Lov Cakes.
> Será que consigo falar com o dono ou responsável?

O `generic` troca "docerias e confeitarias" por "negócios locais como o seu" e o
social proof por cases do segmento (ou genéricos). Variáveis iguais: {{1}}=nome,
{{2}}=cidade, {{3}}=nome.

### Mudanças de código (pequenas)

- `_shared/whatsapp_send.ts`: `templateForGenero(genero)` vira
  `templateFor(setor, genero)` com mapa `SETOR_GRUPO` (Confeitaria/Cafeteria →
  doces; resto → generic). Lang por template via env (padrão atual mantido).
- `enviar-whatsapp/index.ts`: passa `lead.setor` na escolha.
- Se o disparo for via workflow HubSpot: nova property `setor_grupo` no contato
  (preenchida pelo `hubspot-sync`) + branch a mais no workflow (If setor_grupo…).
- Pré-requisito externo: criar/aprovar os 2 novos templates no WhatsApp Manager
  (idealmente todos em pt_BR para acabar com a gambiarra do `intro_m` em `en`).

## Parte 2 — Olivia autônoma (inbound + cérebro + agendamento)

### Decisão de arquitetura a confirmar (fork)

Um número de WABA entrega webhook para UM app só. Hoje as respostas caem no
**inbox do HubSpot** (humano responde). Para a Olivia responder sozinha, o webhook
do número precisa ser NOSSO:

- **Recomendado:** mover o número para app Meta próprio; Cloud API end-to-end
  (o `enviar-whatsapp` já envia direto). HubSpot continua como CRM via
  `hubspot-sync` (contato/deal/estágio) — só perde o inbox nativo.
- Alternativa descartada: responder via API de conversas do HubSpot (a automação
  já é bloqueada por escopo neste portal — automation 403).

### Fase A — Inbound (webhook + memória)

- Edge Function `whatsapp-webhook`: GET (hub.challenge verify) + POST (messages
  + statuses). Statuses atualizam `whatsapp_send_status`
  (sent→delivered→read→replied) com dedup por `whatsapp_msg_id` (campo já existe).
- Migration `0011_olivia_conversas.sql`:
  - `whatsapp_mensagens` (id, lead_id, direcao in/out, wamid unique, corpo,
    timestamp, raw jsonb)
  - colunas em `leads`: `olivia_estado` ('aguardando' | 'conversando' |
    'agendando' | 'agendado' | 'handoff' | 'optout'), `olivia_handoff_motivo`,
    `reuniao_at timestamptz`, `reuniao_link text`
- Secrets: `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (validar
  assinatura `X-Hub-Signature-256` — obrigatório, endpoint é público).

### Fase B — Cérebro (LLM respondedora)

- Edge Function `olivia-responder` (chamada pelo webhook a cada inbound):
  1. Carrega lead + histórico de mensagens.
  2. Guardrails ANTES do LLM: opt-out ("não", "pare", "remover" → `optout`,
     nunca mais mensagear — LGPD); estado `handoff`/`optout` → silêncio.
  3. LLM (Claude via OpenRouter) com persona Olivia + contexto do lead
     (nome, dona, setor, cidade) + objetivo único: **qualificar e marcar
     reunião**. Tool-use: `propor_horarios`, `agendar_reuniao`,
     `escalar_humano`, `marcar_optout`.
  4. Resposta freeform é permitida (janela de 24h aberta pela resposta do lead).
  5. Cadência humana: delay 30–120s antes de responder, nunca instantâneo.
- Handoff por padrão no começo: tudo que o LLM marcar como incerto
  (preço, irritação, pergunta fora do script) → `handoff` + notificação ao time.
  Autonomia cresce conforme confiança.

### Fase C — Agendamento (o objetivo)

- Google Calendar API (conta stefanogebara@gmail.com, OAuth refresh token como
  secret): `freebusy` para propor 2–3 horários comerciais, `events.insert` com
  Google Meet + convite. Confirmação no WhatsApp + lembrete 1h antes.
- Ao agendar: lead → `status='interessado'`, deal → estágio avançado no HubSpot,
  notificação ao time (e-mail/WhatsApp interno). **Humano só entra na reunião.**

### Fase D — Re-engajamento

- Sem resposta em 48h/7d → template de follow-up aprovado (fora da janela de 24h
  só template). 2 tentativas no máximo, depois `descartado`.

## Princípios mantidos

- Anti-invenção: a Olivia nunca inventa preço/case/dado; sem certeza → handoff.
- Dry-run primeiro: webhook + responder nascem com `OLIVIA_DRY_RUN=true`
  (loga a resposta que ENVIARIA sem enviar) até validarmos transcript real.
- Warm-up/teto diário continuam no envio.
- Cada fase = PR testável (partes puras unit-testadas no Vitest, como hoje).

## Pendências externas (não-código)

1. Confirmar fork do webhook (mover número do HubSpot p/ app próprio).
2. Aprovar templates novos no WhatsApp Manager (doces/generic × f/m, pt_BR).
3. Secret OpenRouter/Anthropic p/ o LLM.
4. OAuth do Google Calendar (refresh token) da conta que recebe as reuniões.
