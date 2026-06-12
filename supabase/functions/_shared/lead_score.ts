// Pontuação de qualificação de lead — escala aditiva 0..7.
// Linktree NÃO pontua (guardado para análise futura, sem peso definido).
// Score NULL no banco = lead ainda não classificado (aguarda enriquecimento).

// Faixas de cor (frontend e testes usam os mesmos limites).
export const SCORE_FAIXAS = {
  MID_MIN: 1,
  MID_MAX: 3,
  HIGH_MIN: 4,
} as const

export function calcularLeadScore({
  pontoFisico,
  deliveryProprio,
  whatsappVendas,
  donoIdentificado,
}: {
  pontoFisico: boolean
  deliveryProprio: boolean
  whatsappVendas: boolean
  donoIdentificado: boolean
}): number {
  return (
    (pontoFisico ? 1 : 0) +
    (deliveryProprio ? 2 : 0) +
    (whatsappVendas ? 3 : 0) +
    (donoIdentificado ? 1 : 0)
  )
}
