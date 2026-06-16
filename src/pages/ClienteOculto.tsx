import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Map as MapIcon } from 'lucide-react'
import { useLeads, useUpdateLead } from '../lib/leads'
import { isClienteOcultoPendente, isClienteOcultoFeita } from '../lib/clienteOculto'
import { temCoord } from '../lib/route'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { fmtDate, fmtText } from '../lib/format'
import type { Lead, WhatsappSendStatus } from '../lib/types'

// Cliente Oculto (Fase 4 do re-layout — plano 2026-06-10): registrar a visita.
// Duas seções: Pendentes (disparo enviado, visita ainda não feita) e Feitas
// (com cliente_oculto_at). Marcar/desfazer grava direto no lead — o check ✓
// aparece na Base de Dados e na aba C. Oculto da ficha. A régua de "pendente"
// vive em lib/clienteOculto (compartilhada com Sidebar e Rotas).

// Rótulos pt-BR do status de envio (badge da coluna Disparo).
const DISPARO_LABEL: Record<WhatsappSendStatus, string> = {
  sent: 'Enviado',
  delivered: 'Entregue',
  read: 'Lido',
  replied: 'Respondeu',
  failed: 'Falhou',
  invalid: 'Inválido',
}

export default function ClienteOculto() {
  const { data: leads = [], isLoading } = useLeads()
  const update = useUpdateLead()

  // Ficha do lead clicado (mesmo padrão das outras páginas).
  const [openId, setOpenId] = useState<string | null>(null)
  // Mini-form inline do "Marcar feita": lead em edição + notas digitadas.
  const [formId, setFormId] = useState<string | null>(null)
  const [notas, setNotas] = useState('')

  const pendentes = useMemo(() => leads.filter(isClienteOcultoPendente), [leads])
  const feitas = useMemo(() => leads.filter(isClienteOcultoFeita), [leads])
  // Pendentes com coordenada = roteáveis (o resto não tem onde plotar no mapa).
  const pendentesRoteaveis = useMemo(() => pendentes.filter(temCoord), [pendentes])

  const navigate = useNavigate()

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null

  // Abre o mini-form de notas para um lead (fecha o que estiver aberto).
  function abrirForm(id: string) {
    setFormId(id)
    setNotas('')
  }

  // Confirma a visita: timestamp gerado AQUI, no momento real do clique.
  // Notas vazias viram null (anti-invenção: não grava string vazia).
  function confirmarVisita(id: string) {
    const texto = notas.trim()
    update.mutate(
      {
        id,
        patch: {
          cliente_oculto_at: new Date().toISOString(),
          cliente_oculto_notas: texto === '' ? null : texto,
        },
      },
      {
        onSuccess: () => {
          setFormId(null)
          setNotas('')
        },
      },
    )
  }

  // Desfaz a visita: limpa só a data — as notas ficam preservadas no lead.
  function desfazerVisita(id: string) {
    update.mutate({ id, patch: { cliente_oculto_at: null } })
  }

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Cliente Oculto</div>
        <h1>Cliente Oculto</h1>
        <p className="page-sub">
          Negócios da base que receberam o disparo entram como pendentes. Depois
          da visita, marque como feita — o check ✓ aparece na Base de Dados.
        </p>
      </header>

      {isLoading ? (
        <p className="page-sub">Carregando…</p>
      ) : (
        <>
          {/* ---------- Pendentes ---------- */}
          <section className="co-section">
            <div className="co-section-head">
              <span className="eyebrow">Pendentes · {pendentes.length}</span>
              {pendentesRoteaveis.length > 0 && (
                <button
                  className="btn ghost sm"
                  onClick={() => navigate('/rotas', { state: { routeIds: pendentesRoteaveis.map((l) => l.id) } })}
                  title="Abre a Rotas com o roteiro otimizado das visitas pendentes (com endereço)."
                >
                  <MapIcon size={14} /> Montar roteiro ({pendentesRoteaveis.length})
                </button>
              )}
            </div>

            {pendentes.length === 0 ? (
              <div className="callout">
                Nenhuma visita pendente. Quem recebe o disparo de WhatsApp (pela
                Base de Dados ou pela Olivia) aparece aqui como candidato à
                visita de cliente oculto.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="leads-table co-table">
                  <thead>
                    <tr>
                      <th className="eyebrow">Nome</th>
                      <th className="eyebrow">Bairro</th>
                      <th className="eyebrow">WhatsApp</th>
                      <th className="eyebrow">Disparo</th>
                      <th className="eyebrow">Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendentes.map((l) => (
                      // Fragmento com key: a linha do lead + (se aberto) a linha
                      // extra do mini-form de notas logo abaixo.
                      <FragmentoPendente
                        key={l.id}
                        lead={l}
                        formAberto={formId === l.id}
                        notas={notas}
                        salvando={update.isPending}
                        onAbrirLinha={() => setOpenId(l.id)}
                        onAbrirForm={() => abrirForm(l.id)}
                        onFecharForm={() => setFormId(null)}
                        onNotas={setNotas}
                        onConfirmar={() => confirmarVisita(l.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ---------- Feitas ---------- */}
          <section className="co-section">
            <span className="eyebrow">Feitas · {feitas.length}</span>

            {feitas.length === 0 ? (
              <div className="callout">
                Nenhuma visita registrada ainda. Marque uma pendente como feita —
                data e notas ficam guardadas aqui e viram o check ✓ na Base.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="leads-table co-table">
                  <thead>
                    <tr>
                      <th className="eyebrow">Nome</th>
                      <th className="eyebrow">Bairro</th>
                      <th className="eyebrow">Data da visita</th>
                      <th className="eyebrow">Notas</th>
                      <th className="eyebrow">Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feitas.map((l) => (
                      <tr key={l.id} onClick={() => setOpenId(l.id)}>
                        <td className="cell-nome">{l.nome}</td>
                        <td className={l.bairro ? undefined : 'cell-dash'}>
                          {fmtText(l.bairro)}
                        </td>
                        <td className="cell-num">{fmtDate(l.cliente_oculto_at)}</td>
                        <td>
                          {l.cliente_oculto_notas ? (
                            <span className="co-notas" title={l.cliente_oculto_notas}>
                              {l.cliente_oculto_notas}
                            </span>
                          ) : (
                            <span className="cell-dash">—</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn ghost sm"
                            disabled={update.isPending}
                            onClick={(e) => {
                              e.stopPropagation()
                              desfazerVisita(l.id)
                            }}
                          >
                            Desfazer
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {openLead && (
        <LeadDrawer key={openLead.id} lead={openLead} onClose={() => setOpenId(null)} />
      )}
    </>
  )
}

// Linha de um lead pendente + mini-form inline de notas (quando aberto).
// Componente separado só para a tabela acima não virar um bloco gigante.
function FragmentoPendente({
  lead,
  formAberto,
  notas,
  salvando,
  onAbrirLinha,
  onAbrirForm,
  onFecharForm,
  onNotas,
  onConfirmar,
}: {
  lead: Lead
  formAberto: boolean
  notas: string
  salvando: boolean
  onAbrirLinha: () => void
  onAbrirForm: () => void
  onFecharForm: () => void
  onNotas: (v: string) => void
  onConfirmar: () => void
}) {
  return (
    <>
      <tr onClick={onAbrirLinha}>
        <td className="cell-nome">{lead.nome}</td>
        <td className={lead.bairro ? undefined : 'cell-dash'}>{fmtText(lead.bairro)}</td>
        <td className={lead.whatsapp_phone ? 'cell-num' : 'cell-dash'}>
          {fmtText(lead.whatsapp_phone)}
        </td>
        <td>
          {lead.whatsapp_send_status ? (
            <span className="badge">{DISPARO_LABEL[lead.whatsapp_send_status]}</span>
          ) : (
            <span className="cell-dash">—</span>
          )}
        </td>
        <td>
          <button
            className="btn sm"
            disabled={formAberto}
            onClick={(e) => {
              e.stopPropagation()
              onAbrirForm()
            }}
          >
            Marcar feita
          </button>
        </td>
      </tr>

      {formAberto && (
        <tr className="co-form-row" onClick={(e) => e.stopPropagation()}>
          <td colSpan={5}>
            <div className="co-form">
              <label className="eyebrow" htmlFor={`co-notas-${lead.id}`}>
                Notas da visita (opcional)
              </label>
              <textarea
                id={`co-notas-${lead.id}`}
                value={notas}
                placeholder="Atendimento, produto, movimento…"
                onChange={(e) => onNotas(e.target.value)}
                // autoFocus: o form acabou de ser aberto pelo clique no botão.
                autoFocus
              />
              <div className="co-form-actions">
                <button className="btn sm" disabled={salvando} onClick={onConfirmar}>
                  Confirmar visita
                </button>
                <button className="btn ghost sm" disabled={salvando} onClick={onFecharForm}>
                  Cancelar
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
