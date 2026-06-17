import { Loader2, AlertTriangle, ExternalLink, RotateCcw } from 'lucide-react'
import { useOliviaErros } from '../../lib/leads'
import { fmtDateTime } from '../../lib/format'

// Painel "Erros": o que as edge functions registraram em olivia_erros (criar
// evento no Calendar, ler agenda, LLM, etc.). Antes esses erros ficavam só no
// console do Supabase — aqui o time vê ao vivo o que quebrou, com o detalhe e um
// atalho pra abrir o lead afetado. Read-only.

export function OliviaErrosPanel({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const { data: erros = [], isLoading, isError, error, refetch, isFetching } = useOliviaErros()

  return (
    <section>
      <div className="table-bar">
        <span className="table-count">
          <b>{erros.length}</b> {erros.length === 1 ? 'erro recente' : 'erros recentes'}
        </span>
        <button className="btn ghost sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
          Atualizar
        </button>
      </div>

      {isLoading ? (
        <div className="search-status"><Loader2 size={15} className="spin" /> Carregando erros…</div>
      ) : isError ? (
        <div className="search-status err">Falha ao carregar os erros: {(error as Error).message}</div>
      ) : erros.length === 0 ? (
        <div className="empty-state">
          <h3>Nenhum erro registrado</h3>
          <p>Quando a Olivia ou uma função falhar (criar reunião, ler agenda, LLM…), o erro aparece aqui.</p>
        </div>
      ) : (
        <ul className="oli-leads">
          {erros.map((e) => (
            <li key={e.id} className="oli-lead" style={{ alignItems: 'flex-start' }}>
              <span
                className="status-dot"
                data-status={e.nivel === 'warn' ? 'pending' : 'missing'}
                style={{ marginTop: 4 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <AlertTriangle size={13} style={{ color: 'var(--maky)', flex: 'none' }} />
                  <b>{e.mensagem}</b>
                </div>
                <div className="muted-line" style={{ fontSize: 12, marginTop: 2 }}>
                  {e.fonte} · {fmtDateTime(e.created_at)}
                </div>
                {e.contexto && (
                  <pre
                    style={{
                      fontSize: 11,
                      marginTop: 6,
                      padding: 8,
                      borderRadius: 6,
                      background: 'var(--surface-2, rgba(0,0,0,0.04))',
                      overflowX: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {JSON.stringify(e.contexto, null, 2)}
                  </pre>
                )}
                {e.lead_id && (
                  <button
                    className="btn ghost sm"
                    style={{ marginTop: 6 }}
                    onClick={() => onOpenLead(e.lead_id!)}
                  >
                    <ExternalLink size={13} /> Abrir lead
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
