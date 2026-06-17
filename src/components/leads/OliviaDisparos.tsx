import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquare, ArrowUpRight } from 'lucide-react'
import { useLeads } from '../../lib/leads'
import { fmtDateTime } from '../../lib/format'
import {
  leadsDisparados,
  lerVistoEm,
  marcarVistoAgora,
  statusDisparo,
  useRespostasDesde,
} from '../../lib/disparos'
import { ManualOliviaContactForm } from './ManualOliviaContactForm'

// Aba "Disparos": a resposta para "enviei? como foi? alguém respondeu?".
// =============================================================================
// Lista todo lead com disparo iniciado, com o status mais honesto que o app
// consegue afirmar (ver lib/disparos.ts), destaca respostas novas desde a
// última visita e abre a conversa do lead em um clique. Ao montar, marca a
// visita (zera o badge da aba) — mas o destaque "novo" usa o visto ANTERIOR,
// senão nada apareceria como novo.

export function OliviaDisparos({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const { data: leads = [], isLoading, isError, error } = useLeads()

  // Visto anterior congelado no mount: é a régua do "novo" desta visita.
  const [vistoAnterior] = useState(() => lerVistoEm())
  const respostas = useRespostasDesde(vistoAnterior)

  // Entrar na aba conta como "visto": o badge externo zera na próxima leitura.
  useEffect(() => {
    marcarVistoAgora()
  }, [])

  const novosPorLead = useMemo(() => {
    const set = new Set<string>()
    for (const r of respostas.data ?? []) if (r.lead_id) set.add(r.lead_id)
    return set
  }, [respostas.data])

  const disparados = useMemo(() => leadsDisparados(leads), [leads])
  const responderam = disparados.filter((l) => l.whatsapp_send_status === 'replied').length
  const falharam = disparados.filter(
    (l) => l.whatsapp_send_status === 'failed' || l.whatsapp_send_status === 'invalid',
  ).length

  if (isLoading) {
    return <div className="search-status"><Loader2 size={15} className="spin" /> Carregando…</div>
  }
  if (isError) {
    return <div className="search-status err">Falha ao carregar: {(error as Error).message}</div>
  }

  return (
    <div className="cockpit">
      <ManualOliviaContactForm />

      {/* Resumo numérico rápido. */}
      <div className="oli-resumo">
        <div className="oli-resumo-card"><span className="eyebrow">Disparados</span><b>{disparados.length}</b></div>
        <div className="oli-resumo-card"><span className="eyebrow">Responderam</span><b>{responderam}</b></div>
        <div className="oli-resumo-card"><span className="eyebrow">Falhas</span><b>{falharam}</b></div>
        <div className="oli-resumo-card"><span className="eyebrow">Respostas novas</span><b>{novosPorLead.size}</b></div>
      </div>

      {disparados.length === 0 ? (
        <div className="empty-state">
          <h3>Nenhum disparo ainda</h3>
          <p>Quando você enviar mensagens (aba Prospecção ou Base de Dados), cada disparo aparece aqui com o status real.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="leads-table">
            <thead>
              <tr>
                <th className="eyebrow">Negócio</th>
                <th className="eyebrow">Número</th>
                <th className="eyebrow">Disparado em</th>
                <th className="eyebrow">Status</th>
                <th className="eyebrow">Conversa</th>
              </tr>
            </thead>
            <tbody>
              {disparados.map((lead) => {
                const st = statusDisparo(lead)
                const novo = novosPorLead.has(lead.id)
                const numero = lead.whatsapp_dono?.trim() || lead.whatsapp_phone
                return (
                  <tr key={lead.id} className={novo ? 'selected' : undefined}>
                    <td className="cell-nome">
                      {lead.nome}
                      {novo && <span className="badge" style={{ marginLeft: 8 }}>nova resposta</span>}
                    </td>
                    <td className={numero ? undefined : 'cell-dash'}>{numero ?? '—'}</td>
                    <td className={lead.whatsapp_sent_at ? undefined : 'cell-dash'}>
                      {lead.whatsapp_sent_at ? fmtDateTime(lead.whatsapp_sent_at) : '—'}
                    </td>
                    <td>
                      <span className="status-dot" data-status={st.dot} /> {st.label}
                    </td>
                    <td>
                      <button type="button" className="btn ghost sm" onClick={() => onOpenLead(lead.id)}>
                        <MessageSquare size={13} /> Abrir <ArrowUpRight size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted-line" style={{ marginTop: 14 }}>
        "Acionado no HubSpot" = o workflow de envio foi acionado; a confirmação de
        entrega fica no HubSpot. "Respondeu" chega aqui automaticamente via webhook.
      </p>
    </div>
  )
}
