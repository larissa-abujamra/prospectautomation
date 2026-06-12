# Olivia - Runbook de Go-Live

Runbook do launch atual da Olivia para prospecção e WhatsApp outbound.
**Fonte da automação ativa: HubSpot.** Meta fica apenas para criação, aprovação e
sincronização de templates do WhatsApp. As funções de Meta Cloud API direta ficam
no repositório como fallback legado, fora do caminho de go-live.

---

## 1. Arquitetura Ativa

| Etapa | O que acontece | Dono do envio |
|------|----------------|---------------|
| Prospecção | App busca leads, enriquece e encontra WhatsApp | App/Supabase |
| CRM | `exportar-hubspot` cria contato + negócio no HubSpot | App/Supabase |
| Gatilho | `hubspot-sync` grava `whatsapp_outreach=ready` no contato | App/Supabase |
| Template | Workflow do HubSpot envia o WhatsApp aprovado | HubSpot |
| Acompanhamento | Time acompanha contato, negócio e resposta no HubSpot | HubSpot |

Contrato do app com o HubSpot:

- `google_place_id`: chave de dedup do contato.
- `phone`: telefone escolhido para CRM.
- `hs_whatsapp_phone_number`: telefone que a integração WhatsApp do HubSpot usa.
- `nome_genero`: `f` ou `m`, usado para escolher template feminino/masculino.
- `setor`: setor bruto para filtro operacional.
- `setor_grupo`: `doces` ou `generic`, usado para ramificar templates por perfil.
- `whatsapp_outreach`: quando vale `ready`, o workflow do HubSpot deve enviar.

Funções dormentes, fora do go-live atual: `enviar-whatsapp`, `whatsapp-webhook`,
`olivia-responder`, `olivia-flush`, `olivia-agendar`.

---

## 2. Secrets

Obrigatório para o launch HubSpot:

- `HUBSPOT_PRIVATE_APP_TOKEN`

Útil, mas não bloqueia envio, porque só melhora classificação de gênero:

- `OPENROUTER_API_KEY`

Não são blockers deste launch:

- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_ID`

Esses secrets só voltam a ser necessários se reativarmos conversa direta via Meta
Cloud API ou agendamento automático com Google Calendar.

---

## 3. Setup No HubSpot

1. Confirme que a integração WhatsApp do HubSpot está conectada ao WABA correto.
2. Confirme que os templates aprovados aparecem no editor de workflow do HubSpot.
3. Crie ou revise as propriedades customizadas usadas pelo app:
   - `google_place_id`
   - `whatsapp_outreach`
   - `nome_genero`
   - `setor`
   - `setor_grupo`
4. No workflow de envio, use enrollment por contato com:
   - `whatsapp_outreach` igual a `ready`
   - `hs_whatsapp_phone_number` conhecido
5. Ramifique por `nome_genero` e, quando os templates segmentados estiverem
   disponíveis, também por `setor_grupo`.
6. A ação de envio deve ser a ação nativa de WhatsApp do HubSpot, não chamada API
   a partir do app.
7. Depois do envio, o workflow deve impedir reenvio acidental. Exemplo: marcar
   `whatsapp_outreach` como `sent` ou mover o negócio para Tentativa de Contato,
   conforme a automação ativa no portal.

Template/copy:

- Usar `Scherbi's` exatamente.
- Não usar em dash em texto de template ou prompt.
- Meta/WhatsApp Manager é usado só para criar e aprovar templates.

---

## 4. Ordem De Go-Live

1. **Templates.** Em Meta/WhatsApp Manager, confirme aprovação dos templates.
2. **HubSpot.** Confirme que esses templates aparecem no workflow do HubSpot.
3. **Workflow.** Ligue o workflow que envia quando `whatsapp_outreach=ready`.
4. **App.** Use um lead de teste com número controlado e acione "Enviar WhatsApp
   (HubSpot)".
5. **Contato.** No HubSpot, confirme que o contato recebeu:
   - `hs_whatsapp_phone_number`
   - `nome_genero`
   - `setor_grupo`
   - `whatsapp_outreach=ready`
6. **Envio.** Confirme no HubSpot que o contato entrou no workflow correto e que
   o template foi enviado pelo canal WhatsApp do HubSpot.
7. **Escala.** Teste 1 lead `doces` e 1 lead `generic` antes de processar lote.
8. **Operação.** Rode lotes pequenos no primeiro dia e acompanhe respostas dentro
   do HubSpot.

Não fazer no launch atual:

- Não buscar System User token da Meta.
- Não apontar webhook da Meta para `whatsapp-webhook`.
- Não ativar `olivia-responder`, `olivia-flush` ou `olivia-agendar`.
- Não depender de `OLIVIA_DRY_RUN=false` para outbound.

---

## 5. Deploy

As funções necessárias para o caminho HubSpot são:

```bash
export SUPABASE_ACCESS_TOKEN=<token>
REF=jcfeydjzjnjdeubrchbg
npx --yes supabase@latest functions deploy hubspot-sync --project-ref $REF
npx --yes supabase@latest functions deploy exportar-hubspot --project-ref $REF
```

Funções legadas de Meta direta não precisam ser deployadas para este launch.
O frontend sobe pela integração Vercel/git a cada merge na `main`.

---

## 6. Rollback / Kill Switch

- Desligar o workflow no HubSpot para parar envios imediatamente.
- Trocar o enrollment do workflow para exigir uma condição manual adicional.
- No app, não clicar em "Enviar WhatsApp (HubSpot)" nem rodar lotes.
- Se um lead foi enfileirado por engano, alterar `whatsapp_outreach` antes da
  ação de envio do workflow rodar.

---

## 7. Limitações Conhecidas / Dívidas

- A confirmação final de envio fica no HubSpot. O app confirma que escreveu o
  gatilho do workflow, não que o WhatsApp já foi entregue.
- `whatsapp_sent_at` hoje representa "workflow acionado" no app. A entrega real
  deve ser auditada no HubSpot.
- As funções `whatsapp-webhook`, `olivia-responder`, `olivia-flush` e
  `olivia-agendar` continuam dormentes até uma decisão explícita de retomar
  conversa direta por Meta Cloud API.
- Rotacionar os tokens de management `sbp_...` que vieram por chat nesta sessão.
