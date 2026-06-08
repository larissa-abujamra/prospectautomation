import { useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { useExportarHubspot, podeExportar } from '../../lib/leads'
import type { Lead } from '../../lib/types'

// Importa pra HubSpot em lote, só os selecionados que estão prontos
// (enriquecidos: têm CNPJ + dono). Idempotente — reexportar atualiza a data.
export function BatchHubspot({
  leads,
  selectedIds,
}: {
  leads: Lead[]
  selectedIds: Set<string>
}) {
  const exp = useExportarHubspot()
  const [msg, setMsg] = useState<string | null>(null)

  const elegiveis = leads.filter((l) => selectedIds.has(l.id) && podeExportar(l))
  const n = selectedIds.size

  function run() {
    if (elegiveis.length === 0) return
    setMsg(null)
    exp.mutate(
      elegiveis.map((l) => l.id),
      {
        onSuccess: (res) => {
          const parts = [`${res.exported.length} exportado(s)`]
          if (res.skipped.length) parts.push(`${res.skipped.length} ignorado(s)`)
          setMsg(parts.join(' · '))
        },
        onError: (e) => setMsg((e as Error).message),
      },
    )
  }

  if (exp.isPending) {
    return (
      <button className="btn" disabled>
        <Loader2 size={15} className="spin" /> Exportando…
      </button>
    )
  }

  if (n === 0 || elegiveis.length === 0) {
    return (
      <button
        className="btn ghost"
        disabled
        title={n === 0 ? 'Selecione leads enriquecidos.' : 'Nenhum selecionado tem CNPJ + dono — enriqueça antes.'}
      >
        <Upload size={15} /> Importar pra HubSpot
      </button>
    )
  }

  return (
    <>
      <button className="btn" onClick={run}>
        <Upload size={15} /> Importar {elegiveis.length} pra HubSpot
      </button>
      {msg && <span className="search-status" style={{ marginTop: 0 }}>{msg}</span>}
    </>
  )
}
