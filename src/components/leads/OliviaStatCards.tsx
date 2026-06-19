import { useMemo } from 'react'
import { Building2, MessageCircle, TrendingUp, CalendarCheck } from 'lucide-react'
import type { Lead } from '../../lib/types'

// Os 4 KPI cards coloridos da Olivia. Compartilhados entre a aba Acompanhamento
// e a página de Estatísticas. Tudo derivado de leads — sem query.
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

  const taxaFmt = stats.taxa.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  // Casca colorida: fundo em tom claro da cor + ícone/label/número/sub na cor cheia.
  return (
    <div className="oli-kpis">
      <div className="oli-kpi" style={{ ['--c' as string]: 'var(--fin)' } as React.CSSProperties}>
        <Building2 size={20} className="k-ic" />
        <div className="k-label">No pipeline</div>
        <div className="k-num">{stats.ativos}</div>
        <div className="k-sub">negócios ativos</div>
      </div>
      <div className="oli-kpi" style={{ ['--c' as string]: 'var(--waz)' } as React.CSSProperties}>
        <MessageCircle size={20} className="k-ic" />
        <div className="k-label">Conversando</div>
        <div className="k-num">{stats.conversando}</div>
        <div className="k-sub">em conversa ativa</div>
      </div>
      <div className="oli-kpi" style={{ ['--c' as string]: 'var(--maky)' } as React.CSSProperties}>
        <TrendingUp size={20} className="k-ic" />
        <div className="k-label">Taxa de resposta</div>
        <div className="k-num">{taxaFmt}%</div>
        <div className="k-sub">{stats.responderam} de {stats.disparados} disparos</div>
      </div>
      <div className="oli-kpi" style={{ ['--c' as string]: 'var(--gold)' } as React.CSSProperties}>
        <CalendarCheck size={20} className="k-ic" />
        <div className="k-label">Reuniões</div>
        <div className="k-num">{stats.reunioes}</div>
        <div className="k-sub">agendadas</div>
      </div>
    </div>
  )
}
