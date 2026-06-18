// Briefing da reunião pro rep da Inner (Olivia Autônoma). Partes PURAS, testáveis.
// O contexto que só a Olivia tinha (quem é o cliente) vira um email curto pro rep
// que vai entrar na call. ANTI-VAZAMENTO: este conteúdo é INTERNO — nunca vai pro
// cliente (ver briefingDestinatarioValido). Sem invenção: campo vazio é omitido.

export interface BriefingLead {
  nome: string
  dono_nome?: string | null
  cidade?: string | null
  bairro?: string | null
  setor?: string | null
  instagram_handle?: string | null
  instagram_followers?: number | null
  whatsapp_dono?: string | null
  whatsapp_phone?: string | null
}

export interface BriefingReuniao {
  slotIso: string
  meetLink: string | null
  repNome: string | null
  prospectEmail: string | null
}

/**
 * GUARDA ANTI-VAZAMENTO. Só libera o envio do briefing quando o destinatário:
 *  - é um email válido,
 *  - NÃO é o email do cliente (prospect),
 *  - é do domínio interno (ex.: @innerai.com).
 * Qualquer dúvida → false (não envia). É o que impede o briefing de ir pro cliente.
 */
export function briefingDestinatarioValido(
  repEmail: string | null | undefined,
  prospectEmail: string | null | undefined,
  dominioInterno: string,
): boolean {
  const e = (repEmail ?? '').trim().toLowerCase()
  if (!e || !e.includes('@')) return false
  const p = (prospectEmail ?? '').trim().toLowerCase()
  if (p && e === p) return false
  return e.endsWith(dominioInterno.trim().toLowerCase())
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Data/hora no fuso de São Paulo, legível (ex.: "terça-feira, 23/06/2026 às 11:00").
function formatarDataHora(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const data = d.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  const hora = d.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${data} às ${hora}`
}

/** Monta o email de briefing (assunto + HTML). Só campos conhecidos entram. */
export function montarBriefingReuniao(
  lead: BriefingLead,
  reuniao: BriefingReuniao,
): { subject: string; html: string } {
  const marca = lead.nome?.trim() || 'Cliente'
  const quando = formatarDataHora(reuniao.slotIso)
  const whatsapp = lead.whatsapp_dono?.trim() || lead.whatsapp_phone?.trim() || null
  const local = [lead.bairro?.trim(), lead.cidade?.trim()].filter(Boolean).join(' · ') || null
  const instagram = lead.instagram_handle?.trim()
    ? `@${lead.instagram_handle.trim().replace(/^@/, '')}` +
      (lead.instagram_followers != null ? ` (${lead.instagram_followers.toLocaleString('pt-BR')} seguidores)` : '')
    : null

  // Linhas do briefing — só as que têm valor (anti-invenção).
  const linhas: Array<[string, string]> = []
  linhas.push(['Marca', marca])
  if (lead.dono_nome?.trim()) linhas.push(['Pessoa na call', lead.dono_nome.trim()])
  if (lead.setor?.trim()) linhas.push(['Setor', lead.setor.trim()])
  if (local) linhas.push(['Localização', local])
  if (instagram) linhas.push(['Instagram', instagram])
  if (whatsapp) linhas.push(['WhatsApp', whatsapp])
  linhas.push(['Quando', quando])
  if (reuniao.repNome?.trim()) linhas.push(['Responsável (você)', reuniao.repNome.trim()])

  const rows = linhas
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#6B7280;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#111827;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join('')

  const botaoMeet = reuniao.meetLink
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(reuniao.meetLink)}" ` +
      `style="display:inline-block;background:#111827;color:#fff;text-decoration:none;` +
      `padding:10px 18px;border-radius:10px;font-weight:600">Entrar no Google Meet</a></p>`
    : ''

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827">',
    `<p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9CA3AF;margin:0 0 4px">Briefing da Olivia</p>`,
    `<h2 style="font-size:20px;margin:0 0 4px">${escapeHtml(marca)}</h2>`,
    `<p style="margin:0 0 18px;color:#6B7280;font-size:14px">Reunião agendada automaticamente pela Olivia. Contexto do cliente abaixo.</p>`,
    `<table style="border-collapse:collapse;font-size:14.5px">${rows}</table>`,
    botaoMeet,
    `<p style="margin:24px 0 0;color:#9CA3AF;font-size:12px">Email interno — não encaminhe ao cliente.</p>`,
    '</div>',
  ].join('')

  const subject = `Briefing · ${marca} — reunião ${formatarDataHora(reuniao.slotIso)}`
  return { subject, html }
}
