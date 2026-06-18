import { useRef, useState } from 'react'
import { Radar, Loader2, X, Check, AlertCircle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { LEADS_KEY } from '../lib/leads'
import { termoBusca } from '../lib/setores'
import {
  geocodarLocal,
  planejarMassa,
  rodarBuscaMassa,
  type PlanoMassa,
  type ProgressoMassa,
} from '../lib/buscaMassa'

// Parâmetros fixos da Fase 2a (densidade boa sem explodir custo). Em Fase 2b
// viram configuráveis + cap por job + fila em background pra estados inteiros.
const CELL_KM = 2
const MAX_TERMOS = 2
const MAX_PAGINAS = 2

type Estado = 'idle' | 'planejando' | 'preview' | 'rodando' | 'feito' | 'erro'

// Varre a REGIÃO inteira (cidade/bairro) ladrilhando em grade — sem o teto de 60
// da busca normal. Reusa o setor + local já digitados no formulário acima.
export function BuscaMassaPanel({ setor, local }: { setor: string; local: string }) {
  const qc = useQueryClient()
  const [estado, setEstado] = useState<Estado>('idle')
  const [erro, setErro] = useState('')
  const [plano, setPlano] = useState<PlanoMassa | null>(null)
  const [prog, setProg] = useState<ProgressoMassa | null>(null)
  const cancelRef = useRef<{ cancelado: boolean }>({ cancelado: false })

  const podeEstimar = !!setor.trim() && !!local.trim()

  async function estimar() {
    setErro('')
    setEstado('planejando')
    try {
      const geo = await geocodarLocal(local.trim())
      const p = planejarMassa(geo, { cellKm: CELL_KM, maxTermos: MAX_TERMOS, maxPaginas: MAX_PAGINAS })
      setPlano(p)
      setEstado('preview')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao localizar a região.')
      setEstado('erro')
    }
  }

  async function varrer() {
    if (!plano) return
    setErro('')
    setEstado('rodando')
    setProg({ tilesDone: 0, totalTiles: plano.totalCelulas, insertedTotal: 0, requisicoesTotal: 0 })
    cancelRef.current = { cancelado: false }
    try {
      await rodarBuscaMassa({
        setor: termoBusca(setor.trim()),
        bbox: plano.bbox,
        cellKm: CELL_KM,
        maxTermos: MAX_TERMOS,
        maxPaginas: MAX_PAGINAS,
        onProgress: (p) => setProg(p),
        cancelRef: cancelRef.current,
      })
      setEstado('feito')
      qc.invalidateQueries({ queryKey: LEADS_KEY })
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na varredura.')
      setEstado('erro')
    }
  }

  function cancelar() {
    cancelRef.current.cancelado = true
  }

  const pct =
    prog && prog.totalTiles > 0 ? Math.min(100, Math.round((prog.tilesDone / prog.totalTiles) * 100)) : 0

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Radar size={14} /> Busca em massa — varrer a região toda
      </div>
      <p className="muted-line" style={{ marginTop: 0 }}>
        Ladrilha <b>{local || 'a região'}</b> em células e busca por cada uma — sem o teto de 60 da busca
        normal. Usa o mesmo setor e local acima.
      </p>

      {estado === 'idle' && (
        <button className="btn" onClick={estimar} disabled={!podeEstimar} title={podeEstimar ? '' : 'Preencha setor e local acima'}>
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
            <span className="er-val">{plano.totalCelulas} (~{CELL_KM} km cada)</span>
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
            <button className="btn" onClick={varrer}>
              <Radar size={15} /> Varrer a região
            </button>
            <button className="btn ghost" onClick={() => setEstado('idle')}>
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
            <button className="btn ghost sm" onClick={() => { setEstado('idle'); setProg(null); setPlano(null) }}>
              Nova varredura
            </button>
          </div>
        </div>
      )}

      {estado === 'erro' && (
        <div className="search-status err" style={{ marginTop: 8 }}>
          <AlertCircle size={14} /> {erro}
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={() => setEstado('idle')}>Tentar de novo</button>
          </div>
        </div>
      )}
    </div>
  )
}
