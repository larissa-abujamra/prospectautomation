import { useState } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { useBuscarDocerias } from '../../lib/leads'

// Painel "Buscar docerias" — dispara a Edge Function de sourcing.
export function SearchPanel() {
  const [bairro, setBairro] = useState('')
  const [max, setMax] = useState(40)
  const buscar = useBuscarDocerias()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const b = bairro.trim()
    if (!b || buscar.isPending) return
    buscar.mutate({ bairro: b, max })
  }

  return (
    <div className="card search-card">
      <div className="eyebrow" style={{ marginBottom: 14 }}>Buscar docerias</div>

      <form className="search-row" onSubmit={handleSubmit}>
        <div className="field">
          <label className="eyebrow" htmlFor="bairro">Bairro</label>
          <input
            id="bairro"
            placeholder="Ex.: Pinheiros"
            value={bairro}
            onChange={(e) => setBairro(e.target.value)}
          />
        </div>

        <div className="field narrow">
          <label className="eyebrow" htmlFor="qtd">Quantidade</label>
          <select id="qtd" value={max} onChange={(e) => setMax(Number(e.target.value))}>
            <option value={20}>20</option>
            <option value={40}>40</option>
            <option value={60}>60</option>
          </select>
        </div>

        <button type="submit" className="btn-glow" disabled={buscar.isPending || !bairro.trim()}>
          <span className="btn-glow-bg" />
          <span className="btn-glow-content">
            {buscar.isPending ? (
              <>
                <Loader2 size={16} className="spin" /> Buscando…
              </>
            ) : (
              <>
                <Search size={16} /> Buscar
              </>
            )}
          </span>
        </button>
      </form>

      {buscar.isError && (
        <div className="search-status err">
          {(buscar.error as Error)?.message ?? 'Falha na busca.'}
        </div>
      )}
      {buscar.isSuccess && !buscar.isPending && (
        <div className="search-status">
          {buscar.data.inserted} {buscar.data.inserted === 1 ? 'nova' : 'novas'},{' '}
          {buscar.data.updated} {buscar.data.updated === 1 ? 'atualizada' : 'atualizadas'}.
        </div>
      )}

      <div className="callout" style={{ marginTop: 16 }}>
        A busca traz nome, endereço, telefone, nota e avaliações do Google.
        Seguidores do Instagram e CNPJ são preenchidos depois.
      </div>
    </div>
  )
}
