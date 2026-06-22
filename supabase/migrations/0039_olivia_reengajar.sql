-- 0039_olivia_reengajar.sql — marca do template de CONTINUAÇÃO (Fase: re-abre 24h)
-- =============================================================================
-- Quando um chat VIVO (respondeu, conversou) esfria por >= 24h, a janela de
-- mensagem livre do WhatsApp fecha e só dá pra reabrir com TEMPLATE aprovado. O
-- olivia-nudge passa a disparar um template de CONTINUAÇÃO (via whatsapp_outreach
-- no HubSpot) em vez de pular. Este carimbo é só para relatório/auditoria — o
-- one-shot por período de silêncio continua sendo o olivia_nudge_em (re-armado
-- pela RPC olivia_chats_para_nudge quando o cliente responde de novo). Aditivo.
-- =============================================================================

alter table leads add column if not exists olivia_reengajar_em timestamptz;
