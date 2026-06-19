import { Radar, Loader2, X, Check, AlertCircle } from 'lucide-react'
import { useBuscaMassa } from '../context/BuscaMassaContext'

// Varre a REGIÃO inteira (cidade/bairro) ladrilhando em grade — sem o teto de 60
// da busca normal. Reusa o setor + local já digitados no formulário acima.
// O estado da varredura vive no BuscaMassaProvider (AppShell), então a varredura
// CONTINUA e o progresso sobrevive ao trocar de página (não cancela na navegação).
export function BuscaMassaPanel({ setor, local }: { setor: string; local: string }) {
  const { estado, erro, plano, prog, localRodando, cellKm, estimar, varrer, cancelar, reset } =
    useBuscaMassa()

  const podeEstimar = !!setor.trim() && !!local.trim()
  const pct =
    prog && prog.totalTiles > 0 ? Math.min(100, Math.round((prog.tilesDone / prog.totalTiles) * 100)) : 0
  // Durante a varredura mostra o local que ela está rodando (o form pode ter
  // mudado ou resetado ao navegar) — fora dela, o local atual do formulário.
  const localMostrar = estado === 'rodando' ? localRodando ?? local : local

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Radar size={14} /> Busca em massa — varrer a região toda
      </div>
      <p className="muted-line" style={{ marginTop: 0 }}>
        Ladrilha <b>{localMostrar || 'a região'}</b> em células e busca por cada uma — sem o teto de 60 da
        busca normal. Usa o mesmo setor e local acima. Continua rodando mesmo se você trocar de página.
      </p>

      {estado === 'idle' && (
        <button
          className="btn"
          onClick={() => estimar(local)}
          disabled={!podeEstimar}
          title={podeEstimar ? '' : 'Preencha setor e local acima'}
        >
          <Radar size={15} /> Estimar varredura
        </button>
      )}

      {estado === 'planejando' && (
        <div className="search-status"><Loader2 size={14} className="spin" /> Localizando a região…</div>
      )}

      {estado === 'preview' && plano && (
        <div>
          <div className="enrich-row">
            <span className="er-label">Células</span>
            <span className="er-val">{plano.totalCelulas} (~{cellKm} km cada)</span>
          </div>
          <div className="enrich-row">
            <span className="er-label">Requisições estimadas</span>
            <span className="er-val">≈ {plano.custo.requisicoes}</span>
          </div>
          <div className="enrich-row">
            <span className="er-label">Custo estimado (Google)</span>
            <span className="er-val">≈ US$ {plano.custo.usd.toFixed(2)}</span>
          </div>
          <div className="panel-actions" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => varrer(setor)}>
              <Radar size={15} /> Varrer a região
            </button>
            <button className="btn ghost" onClick={reset}>
              <X size={14} /> Cancelar
            </button>
          </div>
        </div>
      )}

      {estado === 'rodando' && prog && (
        <div>
          <div className="enrich-row">
            <span className="er-label">Progresso</span>
            <span className="er-val">{prog.tilesDone}/{prog.totalTiles} células ({pct}%)</span>
          </div>
          <div className="enrich-row">
            <span className="er-label">Leads novos</span>
            <span className="er-val"><b>{prog.insertedTotal}</b></span>
          </div>
          <div style={{ height: 6, background: 'var(--border, #eee)', borderRadius: 4, overflow: 'hidden', margin: '8px 0' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent, #6c5ce7)', transition: 'width .3s' }} />
          </div>
          <button className="btn ghost sm" onClick={cancelar}>
            <X size={14} /> Parar
          </button>
        </div>
      )}

      {estado === 'feito' && prog && (
        <div className="search-status ok">
          <Check size={14} /> Varredura concluída — <b>{prog.insertedTotal}</b> leads novos de {prog.totalTiles} células
          (~{prog.requisicoesTotal} requisições). Veja na Base de Dados.
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={reset}>
              Nova varredura
            </button>
          </div>
        </div>
      )}

      {estado === 'erro' && (
        <div className="search-status err" style={{ marginTop: 8 }}>
          <AlertCircle size={14} /> {erro}
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={reset}>Tentar de novo</button>
          </div>
        </div>
      )}
    </div>
  )
}
