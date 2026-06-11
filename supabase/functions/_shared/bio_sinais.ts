// Classificação dos sinais de qualificação a partir da bio do Instagram.
// Extraída de encontrar-whatsapp para ser compartilhada com enriquecer-lead.
//
// ANTI-FALSO-POSITIVO:
//   bio_whatsapp_vendas: link wa.me/api.whatsapp.com/wa.link OU frase de intenção
//     de venda próxima a "whats". Número solto NÃO basta.
//   bio_delivery_proprio: frases de entrega própria ("entregamos", "delivery
//     próprio" etc.). Bio com APENAS agregador (iFood/Rappi/Uber Eats) → FALSE.
//   bio_linktree: linktr.ee / linktree / beacons / linkbio no texto ou external_url.

export interface BioSinais {
  linktree: boolean
  whatsappVendas: boolean
  deliveryProprio: boolean
}

// Normaliza texto para matching: minúsculas + remove acentos.
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function classificarBioSinais(bio: string, externalUrl: string | null): BioSinais {
  const t = norm(bio)
  const extNorm = externalUrl ? norm(externalUrl) : ''

  // --- linktree ---
  const linktree =
    /linktr\.ee|linktree|beacons\.|linkbio/.test(t) ||
    /linktr\.ee|linktree|beacons\.|linkbio/.test(extNorm)

  // --- whatsappVendas ---
  const temLinkWA =
    /wa\.me|api\.whatsapp\.com|wa\.link/.test(t) ||
    /wa\.me|api\.whatsapp\.com|wa\.link/.test(extNorm)
  const temFraseVenda =
    /pedidos?\s+pelo\s+whats|pe[cç]a?\s+pelo\s+whatsapp|encomendas?\s+pelo\s+whatsapp|chama\s+no\s+whats|whatsapp\s+para\s+pedidos|pelo\s+whats|via\s+whatsapp/.test(t)
  const whatsappVendas = temLinkWA || temFraseVenda

  // --- deliveryProprio ---
  const deliveryProprio =
    /delivery\s+pr[oó]prio|entregamos|fazemos\s+entrega|tele.?entrega/.test(t)

  return { linktree, whatsappVendas, deliveryProprio }
}
