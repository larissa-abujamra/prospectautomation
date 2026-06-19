import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useLeads } from '../lib/leads'
import { OliviaCockpit } from '../components/leads/OliviaCockpit'
import { OliviaDisparos } from '../components/leads/OliviaDisparos'
import { LeadDrawer, type DrawerTab } from '../components/leads/LeadDrawer'
import { contarLeadsComResposta, lerVistoEm, useRespostasDesde } from '../lib/disparos'

type Vista = 'acompanhar' | 'disparos'

export default function Olivia() {
  const [vista, setVista] = useState<Vista>('acompanhar')
  const [openId, setOpenId] = useState<string | null>(null)
  // Aba inicial da ficha ao abrir um card. Default 'conversa'; cards de "Reunião
  // agendada" abrem direto no 'briefing'.
  const [openTab, setOpenTab] = useState<DrawerTab>('conversa')
  function abrirLead(id: string, tab?: DrawerTab) {
    setOpenId(id)
    setOpenTab(tab ?? 'conversa')
  }

  // useLeads() necessário para resolver o lead aberto pelo cockpit (LeadDrawer).
  // OliviaCockpit e OliviaDisparos têm suas próprias instâncias; mesma cache RQ.
  const { data: leads = [] } = useLeads()

  // Badge de respostas novas (desde a última visita à aba Disparos).
  const [vistoEm, setVistoEm] = useState(() => lerVistoEm())
  const respostas = useRespostasDesde(vistoEm)
  const respostasNovas = contarLeadsComResposta(respostas.data ?? [])

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
      </div>

      {vista === 'acompanhar' && <OliviaCockpit onOpenLead={abrirLead} />}
      {vista === 'disparos' && <OliviaDisparos onOpenLead={setOpenId} />}

      {openLead && (
        <LeadDrawer lead={openLead} initialTab={openTab} onClose={() => setOpenId(null)} key={openLead.id} />
      )}
    </>
  )
}
