import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useLeadsUI } from '../../context/leadsUI'

// Bandeja (re-layout Fase 2): barra preta flutuante embaixo que só aparece
// quando há seleção — a ÚNICA casa de ações em lote. Cada página injeta seus
// próprios botões via children; a contagem vem de fora porque cada página
// conta apenas o que está visível no seu pool.
export function Bandeja({ count, children }: { count: number; children: ReactNode }) {
  const { clearSelection } = useLeadsUI()

  if (count === 0) return null

  return (
    <div className="bandeja" role="toolbar" aria-label="Ações em lote">
      <span className="bandeja-count">
        <b>{count}</b> {count === 1 ? 'selecionado' : 'selecionados'}
      </span>
      <div className="bandeja-actions">{children}</div>
      <button
        className="bandeja-close"
        onClick={clearSelection}
        title="Limpar seleção"
        aria-label="Limpar seleção"
      >
        <X size={15} />
      </button>
    </div>
  )
}
