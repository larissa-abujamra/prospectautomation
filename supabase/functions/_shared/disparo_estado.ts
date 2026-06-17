// Estado do funil da Olivia ao ACIONAR um disparo (junto com whatsapp_sent_at).
// Coloca o lead em 'aguardando' no Acompanhamento — mas SÓ se ele ainda não
// conversou, pra um re-disparo NÃO regredir conversando/agendado/handoff/optout.
//
// Compartilhado pelos DOIS caminhos de disparo (hubspot-sync = workflow HubSpot
// do go-live; enviar-whatsapp = Meta Cloud API direta/legada) pra eles nunca
// divergirem de novo. Antes o estado ficava NULL até o lead responder, então os
// disparados sumiam do board.
export function estadoDeDisparo(
  oliviaEstadoAtual: string | null | undefined,
): 'aguardando' | null {
  return oliviaEstadoAtual == null || oliviaEstadoAtual === 'aguardando' ? 'aguardando' : null
}
