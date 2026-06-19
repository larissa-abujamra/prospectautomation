import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useCriarReuniaoNova } from '../../lib/leads'

// Modal "Nova reunião" (coluna Reunião agendada): cria uma reunião do zero pra
// uma empresa que não está no funil. Se a empresa já existir como lead (mesmo
// pausada/descartada), o hook reaproveita — traz de volta, sem duplicar.
// Reusa as classes .modal-* / .cadastro-form do app.
export function NovaReuniaoModal({ onClose }: { onClose: () => void }) {
  const criar = useCriarReuniaoNova()
  const [empresa, setEmpresa] = useState('')
  const [pessoa, setPessoa] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [prospectEmail, setProspectEmail] = useState('')
  const [quando, setQuando] = useState('')
  const [link, setLink] = useState('')
  const [repEmail, setRepEmail] = useState('')
  const [repNome, setRepNome] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const podeEnviar = empresa.trim() !== '' && quando !== '' && !criar.isPending

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!podeEnviar) return
    criar.mutate(
      {
        empresa,
        pessoa: pessoa.trim() || undefined,
        whatsapp: whatsapp.trim() || undefined,
        prospectEmail: prospectEmail.trim() || undefined,
        reuniaoAt: new Date(quando).toISOString(),
        reuniaoLink: link.trim() || undefined,
        repEmail: repEmail.trim() || undefined,
        repNome: repNome.trim() || undefined,
      },
      { onSuccess: () => onClose() },
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Nova reunião</h3>
        <p className="modal-msg">
          Agenda uma reunião pra uma empresa que não está no funil. Se a empresa já
          existir, ela é trazida de volta (sem duplicar).
        </p>
        <form onSubmit={submit} className="cadastro-form">
          <div className="field">
            <label className="eyebrow" htmlFor="nr-empresa">Empresa</label>
            <input id="nr-empresa" value={empresa} onChange={(e) => setEmpresa(e.target.value)} placeholder="Ex.: Delícias by Rose" autoFocus />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="nr-pessoa">Pessoa (contato)</label>
            <input id="nr-pessoa" value={pessoa} onChange={(e) => setPessoa(e.target.value)} placeholder="Opcional" />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="nr-whats">WhatsApp</label>
            <input id="nr-whats" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="Opcional · 11 91234-5678" inputMode="tel" />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="nr-email">Email do cliente</label>
            <input id="nr-email" type="email" value={prospectEmail} onChange={(e) => setProspectEmail(e.target.value)} placeholder="cliente@empresa.com" />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="nr-quando">Data e hora</label>
            <input id="nr-quando" type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="nr-link">Link do Meet</label>
            <input id="nr-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://meet.google.com/…" />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="nr-rep-email">Email do responsável (Inner)</label>
            <input id="nr-rep-email" type="email" value={repEmail} onChange={(e) => setRepEmail(e.target.value)} placeholder="vendedor@innerai.com" />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="nr-rep-nome">Nome do responsável</label>
            <input id="nr-rep-nome" value={repNome} onChange={(e) => setRepNome(e.target.value)} placeholder="Opcional" />
          </div>

          {criar.isError && <div className="search-status err">{(criar.error as Error).message}</div>}

          <div className="modal-actions" style={{ marginTop: 2 }}>
            <button type="button" className="btn ghost sm" onClick={onClose} disabled={criar.isPending}>
              Cancelar
            </button>
            <button type="submit" className="btn sm" disabled={!podeEnviar}>
              {criar.isPending ? (<><Loader2 size={14} className="spin" /> Salvando…</>) : 'Marcar reunião'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
