import { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader2, Square } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { enriquecerLead, LEADS_KEY } from '../../lib/leads'
import type { Lead } from '../../lib/types'

// Enriquecimento em lote da seleção. Concorrência 1 (sequencial) pra não
// estourar rate limit/custo. Pula leads que já têm CNPJ (não duplica custo) e
// pode ser interrompido. As linhas atualizam conforme cada lead termina.
export function BatchEnrich({
  leads,
  selectedIds,
}: {
  leads: Lead[]
  selectedIds: Set<string>
}) {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const stopRef = useRef(false)

  // Se a aba for desmontada com o lote rodando, sinaliza parada — o loop é
  // fire-and-forget, então sem isto ele seguiria gastando crédito sem dono.
  useEffect(() => () => { stopRef.current = true }, [])

  const selectedLeads = leads.filter((l) => selectedIds.has(l.id))
  const queue = selectedLeads.filter((l) => !l.cnpj)
  const n = selectedIds.size

  async function run() {
    if (queue.length === 0) return
    setRunning(true)
    stopRef.current = false
    setProgress({ done: 0, total: queue.length })
    for (let i = 0; i < queue.length; i++) {
      if (stopRef.current) break
      try {
        await enriquecerLead(queue[i].id, false)
      } catch {
        // um lead que falha não derruba o lote
      }
      await qc.invalidateQueries({ queryKey: LEADS_KEY })
      setProgress({ done: i + 1, total: queue.length })
    }
    setRunning(false)
  }

  if (running) {
    return (
      <div className="batch-wrap">
        <Loader2 size={15} className="spin" />
        <div className="progress">
          <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
        </div>
        <span className="batch-label">
          {progress.done}/{progress.total}
        </span>
        <button
          className="btn ghost sm"
          onClick={() => (stopRef.current = true)}
          title="Para após o lead atual terminar (não cancela o que já está em andamento)."
        >
          <Square size={13} /> Parar
        </button>
      </div>
    )
  }

  if (n === 0) {
    return (
      <button className="btn ghost" disabled title="Selecione leads para enriquecer em lote.">
        0 selecionados
      </button>
    )
  }

  if (queue.length === 0) {
    return (
      <button className="btn ghost" disabled title="Todos os selecionados já têm CNPJ.">
        {n} selecionados (já enriquecidos)
      </button>
    )
  }

  return (
    <button className="btn" onClick={run}>
      <Sparkles size={15} /> Enriquecer {queue.length}{' '}
      {queue.length === 1 ? 'selecionado' : 'selecionados'}
    </button>
  )
}
