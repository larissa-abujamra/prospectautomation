import type { Lead, WhatsappSendStatus } from './types'

// Regra única de "pendente de cliente oculto", compartilhada por ClienteOculto,
// Sidebar (contagem do menu) e Rotas (roteiro das visitas). Antes vivia copiada
// em 2 lugares com comentário "espelhe lá" (finding da auditoria 10/06).

// Disparo conta como feito a partir de 'sent' (mesma régua do check da Base).
export const DISPARO_FEITO: ReadonlySet<WhatsappSendStatus> = new Set([
  'sent',
  'delivered',
  'read',
  'replied',
])

// Lead da Base (fora de descoberto/descartado) — as telas que usam isto puxam
// só da Base de Dados.
function daBase(l: Lead): boolean {
  return l.status !== 'descoberto' && l.status !== 'descartado'
}

// Pendente de cliente oculto: recebeu o disparo E a visita ainda não foi registrada.
export function isClienteOcultoPendente(l: Lead): boolean {
  return (
    daBase(l) &&
    l.whatsapp_send_status != null &&
    DISPARO_FEITO.has(l.whatsapp_send_status) &&
    l.cliente_oculto_at == null
  )
}

// Visita de cliente oculto já registrada (seção "Feitas").
export function isClienteOcultoFeita(l: Lead): boolean {
  return daBase(l) && l.cliente_oculto_at != null
}
