// Pontuação de qualificação de lead — escala aditiva 0..6.
// Linktree NÃO pontua (guardado para análise futura, sem peso definido).
// Score NULL no banco = lead ainda não classificado (aguarda enriquecimento).
export function calcularLeadScore({
  pontoFisico,
  deliveryProprio,
  whatsappVendas,
}: {
  pontoFisico: boolean
  deliveryProprio: boolean
  whatsappVendas: boolean
}): number {
  return (pontoFisico ? 1 : 0) + (deliveryProprio ? 2 : 0) + (whatsappVendas ? 3 : 0)
}
