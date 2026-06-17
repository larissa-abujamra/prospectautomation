import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useCadastrarManual } from '../../lib/leads'

// Modal da aba Disparos: cadastra um contato à mão (empresa + pessoa + WhatsApp)
// e dispara pela Olivia/HubSpot. Reusa as classes .modal-* do ConfirmDialog.
export function CadastroManualModal({ onClose }: { onClose: () => void }) {
  const [empresa, setEmpresa] = useState('')
  const [pessoa, setPessoa] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const cadastrar = useCadastrarManual()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const podeEnviar = empresa.trim() !== '' && whatsapp.trim() !== '' && !cadastrar.isPending

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!podeEnviar) return
    cadastrar.mutate({ empresa, pessoa, whatsapp }, { onSuccess: () => onClose() })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Cadastrar manualmente</h3>
        <p className="modal-msg">
          Adiciona um contato direto para a Olivia disparar pelo HubSpot.
        </p>
        <form onSubmit={submit} className="cadastro-form">
          <div className="field">
            <label className="eyebrow" htmlFor="cm-empresa">Empresa</label>
            <input
              id="cm-empresa"
              value={empresa}
              onChange={(e) => setEmpresa(e.target.value)}
              placeholder="Ex.: Confeitaria Doce Lar"
              autoFocus
            />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="cm-pessoa">Pessoa (contato)</label>
            <input
              id="cm-pessoa"
              value={pessoa}
              onChange={(e) => setPessoa(e.target.value)}
              placeholder="Ex.: Maria (opcional)"
            />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="cm-whats">WhatsApp</label>
            <input
              id="cm-whats"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              placeholder="Ex.: 11 91234-5678"
              inputMode="tel"
            />
          </div>

          {cadastrar.isError && (
            <div className="search-status err">{(cadastrar.error as Error).message}</div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={cadastrar.isPending}>
              Cancelar
            </button>
            <button type="submit" className="btn" disabled={!podeEnviar}>
              {cadastrar.isPending ? (
                <><Loader2 size={15} className="spin" /> Cadastrando…</>
              ) : (
                'Cadastrar e disparar'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
