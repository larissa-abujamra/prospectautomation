import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquare, ArrowUpRight, Search, UserPlus } from 'lucide-react'
import type { Lead } from '../../lib/types'
import { useLeads } from '../../lib/leads'
import { CadastroManualModal } from './CadastroManualModal'
import { fmtDateTime } from '../../lib/format'
import {
  leadsDisparados,
  lerVistoEm,
  marcarVistoAgora,
  statusDisparo,
  useRespostasDesde,
} from '../../lib/disparos'

// Buckets do filtro de status — agrupam os whatsapp_send_status em categorias
// que fazem sentido pro time (o status cru tem 6+ valores).
type CategoriaDisparo = 'replied' | 'visto' | 'enviado' | 'falha'

function categoriaDisparo(lead: Lead): CategoriaDisparo {
  switch (lead.whatsapp_send_status) {
    case 'replied':
      return 'replied'
    case 'read':
    case 'delivered':
      return 'visto'
    case 'failed':
    case 'invalid':
      return 'falha'
    default:
      return 'enviado' // 'sent' ou só acionado no HubSpot
  }
}

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

  // Cadastro manual de contato para disparo.
  const [cadastroAberto, setCadastroAberto] = useState(false)

  // Filtro/busca da tabela: termo (nome ou número) + categoria de status.
  const [q, setQ] = useState('')
  const [filtroStatus, setFiltroStatus] = useState<'' | CategoriaDisparo>('')
  const disparadosVisiveis = useMemo(() => {
    const termo = q.trim().toLowerCase()
    return disparados.filter((l) => {
      if (filtroStatus && categoriaDisparo(l) !== filtroStatus) return false
      if (termo) {
        const numero = (l.whatsapp_dono?.trim() || l.whatsapp_phone || '').toLowerCase()
        if (!l.nome.toLowerCase().includes(termo) && !numero.includes(termo)) return false
      }
      return true
    })
  }, [disparados, q, filtroStatus])

  if (isLoading) {
    return <div className="search-status"><Loader2 size={15} className="spin" /> Carregando…</div>
  }
  if (isError) {
    return <div className="search-status err">Falha ao carregar: {(error as Error).message}</div>
  }

  return (
    <div className="cockpit">
      <div className="oli-disparos-head">
        <button className="btn sm" onClick={() => setCadastroAberto(true)}>
          <UserPlus size={14} /> Cadastrar manualmente
        </button>
      </div>

      {disparados.length === 0 ? (
        <div className="empty-state">
          <h3>Nenhum disparo ainda</h3>
          <p>Quando você enviar mensagens (aba Prospecção ou Base de Dados), cada disparo aparece aqui com o status real.</p>
        </div>
      ) : (
        <>
          <div className="oli-disparos-filtros">
            <div className="search-field">
              <Search size={15} />
              <input
                type="search"
                placeholder="Buscar por nome ou número…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Buscar disparo por nome ou número"
              />
            </div>
            <select
              className="oli-status-select"
              value={filtroStatus}
              onChange={(e) => setFiltroStatus(e.target.value as '' | CategoriaDisparo)}
              aria-label="Filtrar por status"
            >
              <option value="">Todos os status</option>
              <option value="replied">Responderam</option>
              <option value="visto">Entregue ou lido</option>
              <option value="enviado">Enviado / acionado</option>
              <option value="falha">Falhas</option>
            </select>
          </div>

          {disparadosVisiveis.length === 0 ? (
            <div className="empty-state">
              <h3>Nada com esses filtros</h3>
              <p>Ajuste a busca ou o filtro de status para ver mais disparos.</p>
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
                  {disparadosVisiveis.map((lead) => {
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
        </>
      )}

      <p className="muted-line" style={{ marginTop: 14 }}>
        "Acionado no HubSpot" = o workflow de envio foi acionado; a confirmação de
        entrega fica no HubSpot. "Respondeu" chega aqui automaticamente via webhook.
      </p>

      {cadastroAberto && <CadastroManualModal onClose={() => setCadastroAberto(false)} />}
    </div>
  )
}
