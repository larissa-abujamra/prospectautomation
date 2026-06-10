import { useMemo } from 'react'
import { useLeads } from '../lib/leads'

// Cliente Oculto (Fase 1 — leitura): lista leads da BASE que já receberam o
// disparo (candidatos a visita de cliente oculto). Marcar visita/resultado e o
// check na base chegam na Fase 4 (ver .claude/plans/2026-06-10-relayout.md).
export default function ClienteOculto() {
  const { data: leads = [], isLoading } = useLeads()

  // Só da Base de Dados: fora 'descoberto' e 'descartado', com disparo feito.
  const candidatos = useMemo(
    () =>
      leads.filter(
        (l) =>
          l.status !== 'descoberto' &&
          l.status !== 'descartado' &&
          (l.whatsapp_send_status === 'sent' ||
            l.whatsapp_send_status === 'delivered' ||
            l.whatsapp_send_status === 'read' ||
            l.whatsapp_send_status === 'replied'),
      ),
    [leads],
  )

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">04 · Cliente Oculto</div>
        <h1>Cliente Oculto</h1>
        <p className="page-sub">
          Docerias da base que já receberam o disparo — candidatas à visita de
          cliente oculto. O registro da visita entra na Fase 4 do re-layout.
        </p>
      </header>

      {isLoading ? (
        <p className="page-sub">Carregando…</p>
      ) : candidatos.length === 0 ? (
        <div className="callout">
          Nenhuma doceria com disparo enviado ainda. Dispare pela Base de Dados ou
          pela Olivia — quem recebeu mensagem aparece aqui.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="leads-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Bairro</th>
                <th>WhatsApp</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {candidatos.map((l) => (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600 }}>{l.nome}</td>
                  <td>{l.bairro ?? '—'}</td>
                  <td>{l.whatsapp_phone ?? '—'}</td>
                  <td>
                    <span className="badge">{l.whatsapp_send_status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
