import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useLeads, useOliviaErros } from '../lib/leads'
import { OliviaCockpit } from '../components/leads/OliviaCockpit'
import { OliviaDisparos } from '../components/leads/OliviaDisparos'
import { OliviaErrosPanel } from '../components/leads/OliviaErrosPanel'
import { LeadDrawer } from '../components/leads/LeadDrawer'
import { contarLeadsComResposta, lerVistoEm, useRespostasDesde } from '../lib/disparos'

type Vista = 'acompanhar' | 'disparos' | 'erros'

export default function Olivia() {
  const [vista, setVista] = useState<Vista>('acompanhar')
  const [openId, setOpenId] = useState<string | null>(null)

  // useLeads() necessário para resolver o lead aberto pelo cockpit (LeadDrawer).
  // OliviaCockpit e OliviaDisparos têm suas próprias instâncias; mesma cache RQ.
  const { data: leads = [] } = useLeads()

  // Badge de respostas novas (desde a última visita à aba Disparos).
  const [vistoEm, setVistoEm] = useState(() => lerVistoEm())
  const respostas = useRespostasDesde(vistoEm)
  const respostasNovas = contarLeadsComResposta(respostas.data ?? [])

  // Contador de erros recentes pro badge da aba "Erros" (mesma query do painel —
  // react-query dedupa pela ERROS_KEY, então não há fetch duplicado).
  const erros = useOliviaErros()
  const errosCount = erros.data?.length ?? 0

  const openLead = openId ? leads.find((l) => l.id === openId) ?? null : null

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">
          <Sparkles size={11} style={{ verticalAlign: -1 }} /> Olivia
        </div>
        <h1>Olivia</h1>
        <p className="page-sub">
          Acompanhe as conversas da Olivia e os disparos enviados.
        </p>
      </header>

      <div className="view-toggle" role="tablist" aria-label="Vista da Olivia">
        <button
          role="tab"
          aria-selected={vista === 'acompanhar'}
          className={`vt-btn${vista === 'acompanhar' ? ' active' : ''}`}
          onClick={() => setVista('acompanhar')}
        >
          Acompanhamento
        </button>
        <button
          role="tab"
          aria-selected={vista === 'disparos'}
          className={`vt-btn${vista === 'disparos' ? ' active' : ''}`}
          onClick={() => {
            setVista('disparos')
            setVistoEm(new Date().toISOString())
          }}
        >
          Disparos
          {respostasNovas > 0 && vista !== 'disparos' && (
            <span className="badge" style={{ marginLeft: 6 }}>{respostasNovas}</span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={vista === 'erros'}
          className={`vt-btn${vista === 'erros' ? ' active' : ''}`}
          onClick={() => setVista('erros')}
        >
          Erros
          {errosCount > 0 && vista !== 'erros' && (
            <span className="badge" style={{ marginLeft: 6 }}>{errosCount}</span>
          )}
        </button>
      </div>

      {vista === 'acompanhar' && <OliviaCockpit onOpenLead={setOpenId} />}
      {vista === 'disparos' && <OliviaDisparos onOpenLead={setOpenId} />}
      {vista === 'erros' && <OliviaErrosPanel onOpenLead={setOpenId} />}

      {openLead && (
        <LeadDrawer lead={openLead} initialTab="conversa" onClose={() => setOpenId(null)} key={openLead.id} />
      )}
    </>
  )
}
