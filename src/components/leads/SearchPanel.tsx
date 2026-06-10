import { useState } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { useBuscarNegocios } from '../../lib/leads'
import { SETORES, termoBusca } from '../../lib/setores'

// Painel "Buscar negócios" — dispara a Edge Function de sourcing (genérica).
export function SearchPanel() {
  const [setor, setSetor] = useState('')
  const [bairro, setBairro] = useState('')
  const [max, setMax] = useState(40)
  const buscar = useBuscarNegocios()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const s = setor.trim()
    const b = bairro.trim()
    if (!s || !b || buscar.isPending) return
    // Seguidores agora carregam sozinhos em segundo plano (ver followersRunner),
    // então a busca não pede o fetch de seguidores ao servidor (comSeguidores: false).
    buscar.mutate({ setor: termoBusca(s), bairro: b, max, comSeguidores: false })
  }

  return (
    <div className="card search-card">
      {/* Nomeia a AÇÃO (descobrir no Google), não repete o H1 "Buscar negócios":
          distingue esta busca do rail "Filtrar resultados" logo abaixo, que tem
          os mesmos campos Setor/Bairro mas filtra a lista já trazida. */}
      <div className="eyebrow" style={{ marginBottom: 16 }}>Buscar no Google</div>

      <form className="search-row" onSubmit={handleSubmit}>
        <div className="field">
          <label className="eyebrow" htmlFor="setor">Setor</label>
          <select id="setor" value={setor} onChange={(e) => setSetor(e.target.value)}>
            <option value="">Selecione o setor</option>
            {SETORES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

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

        <button type="submit" className="btn-glow" disabled={buscar.isPending || !setor.trim() || !bairro.trim()}>
          <span className="btn-glow-bg" />
          <span className="btn-glow-content">
            {buscar.isPending ? (
              <><Loader2 size={16} className="spin" /> Buscando…</>
            ) : (
              <><Search size={16} /> Buscar</>
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
    </div>
  )
}
