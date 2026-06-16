import { useMemo } from 'react'
import type { Lead } from '../../lib/types'

// Os 4 stat cards (liquid glass) da Olivia. Compartilhados entre a aba
// Acompanhamento e a página de Estatísticas. Tudo derivado de leads — sem query.
// "Ativos" = qualquer estado da Olivia menos opt-out (lead morto).
// "Conversando" inclui 'agendando' (segue sendo conversa ativa; não há coluna própria).
// "Taxa de resposta" = responderam / disparados, sobre TODOS os leads disparados.

const ATIVOS = new Set(['aguardando', 'conversando', 'agendando', 'agendado', 'handoff'])

export function OliviaStatCards({ leads }: { leads: Lead[] }) {
  const stats = useMemo(() => {
    let ativos = 0
    let conversando = 0
    let reunioes = 0
    for (const l of leads) {
      const e = l.olivia_estado
      if (!e) continue
      if (ATIVOS.has(e)) ativos++
      if (e === 'conversando' || e === 'agendando') conversando++
      if (e === 'agendado') reunioes++
    }
    const disparados = leads.filter(
      (l) => l.whatsapp_sent_at != null || l.whatsapp_send_status != null,
    ).length
    const responderam = leads.filter((l) => l.whatsapp_send_status === 'replied').length
    const taxa = disparados > 0 ? (responderam / disparados) * 100 : 0
    return { ativos, conversando, reunioes, disparados, responderam, taxa }
  }, [leads])

  return (
    <div className="oli-stats">
      <div className="oli-stat glass-card">
        <span className="eyebrow">No pipeline</span>
        <span className="oli-stat-num">{stats.ativos}</span>
        <span className="oli-stat-sub">negócios ativos</span>
      </div>
      <div className="oli-stat glass-card">
        <span className="eyebrow">Conversando</span>
        <span className="oli-stat-num fin">{stats.conversando}</span>
        <span className="oli-stat-sub">em conversa ativa</span>
      </div>
      <div className="oli-stat glass-card">
        <span className="eyebrow">Reuniões</span>
        <span className="oli-stat-num waz">{stats.reunioes}</span>
        <span className="oli-stat-sub">agendadas</span>
      </div>
      <div className="oli-stat glass-card">
        <span className="eyebrow">Taxa de resposta</span>
        <span className="oli-stat-num maky">
          {stats.taxa.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
        </span>
        <span className="oli-stat-sub">
          {stats.responderam} de {stats.disparados} disparos
        </span>
      </div>
    </div>
  )
}
