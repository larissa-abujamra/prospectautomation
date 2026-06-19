import { useState } from 'react'
import { Sparkles, Loader2, X, Check, AlertCircle, Phone } from 'lucide-react'
import { useBulkEnrich, type BulkEnrichResult } from '../lib/leads'

// Bounded por tick no servidor (~20). Cada lead chama encontrar-whatsapp (+ opcional
// enriquecer-lead), então rajada grande estoura o rate de invocação do Supabase —
// mantém o lote pequeno e re-roda pra drenar. Enriquecer dobra as chamadas/lead.
const LIMITE_PADRAO = 12
const LIMITE_MAX = 20

type Estado = 'idle' | 'previa' | 'rodando' | 'feito' | 'erro'

// Acha o WhatsApp (e opcionalmente enriquece) dos leads pendentes — ex.: os
// descobertos pela busca-massa, que entram só com nome/place_id. É o passo SEGURO
// antes do disparo (não envia nada). Reaproveita o setor digitado no formulário.
export function EnriquecerMassaPanel({ setor }: { setor: string }) {
  const [estado, setEstado] = useState<Estado>('idle')
  const [erro, setErro] = useState('')
  const [limite, setLimite] = useState(LIMITE_PADRAO)
  const [enriquecer, setEnriquecer] = useState(false)
  const [previa, setPrevia] = useState<BulkEnrichResult | null>(null)
  const [resultado, setResultado] = useState<BulkEnrichResult | null>(null)
  const enrich = useBulkEnrich()

  const setorFiltro = setor.trim()

  async function preVisualizar() {
    setErro('')
    try {
      const res = await enrich.mutateAsync({ dryRun: true, limite, setor: setorFiltro || null, enriquecer })
      setPrevia(res)
      setEstado('previa')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao pré-visualizar.')
      setEstado('erro')
    }
  }

  async function rodar() {
    setErro('')
    setEstado('rodando')
    try {
      const res = await enrich.mutateAsync({ dryRun: false, limite, setor: setorFiltro || null, enriquecer })
      setResultado(res)
      setEstado('feito')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha no enriquecimento.')
      setEstado('erro')
    }
  }

  function reset() {
    setEstado('idle')
    setPrevia(null)
    setResultado(null)
    setErro('')
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkles size={14} /> Enriquecer em lote (achar WhatsApp)
      </div>
      <p className="muted-line" style={{ marginTop: 0 }}>
        Acha o número de WhatsApp dos leads <b>pendentes</b>{setorFiltro ? <> do setor <b>{setorFiltro}</b></> : ' (todos os setores)'} —
        ex.: os descobertos pela busca em massa. Passo seguro antes do disparo (não envia nada). Re-rode pra drenar a fila.
      </p>

      {estado === 'idle' && (
        <div>
          <div className="enrich-row">
            <span className="er-label">Leads por rodada</span>
            <span className="er-val">
              <input
                type="number"
                min={1}
                max={LIMITE_MAX}
                value={limite}
                onChange={(e) => setLimite(Math.max(1, Math.min(LIMITE_MAX, Number(e.target.value) || 1)))}
                style={{ width: 64, padding: '4px 6px', textAlign: 'right' }}
              />{' '}
              <span className="muted-line">(máx {LIMITE_MAX})</span>
            </span>
          </div>
          <label className="muted-line" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={enriquecer} onChange={(e) => setEnriquecer(e.target.checked)} />
            Também enriquecer (CNPJ/dono/Instagram) — mais lento e caro
          </label>
          <div className="panel-actions" style={{ marginTop: 10 }}>
            <button className="btn" onClick={preVisualizar} disabled={enrich.isPending}>
              {enrich.isPending ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} Pré-visualizar pendentes
            </button>
          </div>
        </div>
      )}

      {estado === 'previa' && previa && (
        <div>
          {(previa.selecionados ?? 0) === 0 ? (
            <div className="search-status">
              Nenhum lead pendente{setorFiltro ? <> em <b>{setorFiltro}</b></> : ''} pra enriquecer.
              <div style={{ marginTop: 8 }}>
                <button className="btn ghost sm" onClick={reset}>Voltar</button>
              </div>
            </div>
          ) : (
            <>
              <div className="enrich-row">
                <span className="er-label">Serão processados</span>
                <span className="er-val"><b>{previa.selecionados}</b> leads{enriquecer ? ' (com enriquecimento)' : ''}</span>
              </div>
              {previa.leads && previa.leads.length > 0 && (
                <ul className="muted-line" style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 140, overflow: 'auto' }}>
                  {previa.leads.slice(0, 10).map((l) => (
                    <li key={l.id}>{l.nome ?? '(sem nome)'}</li>
                  ))}
                  {previa.leads.length > 10 && <li>… e mais {previa.leads.length - 10}</li>}
                </ul>
              )}
              <div className="panel-actions" style={{ marginTop: 10 }}>
                <button className="btn" onClick={rodar} disabled={enrich.isPending}>
                  <Phone size={15} /> Achar WhatsApp de {previa.selecionados}
                </button>
                <button className="btn ghost" onClick={reset} disabled={enrich.isPending}>
                  <X size={14} /> Cancelar
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {estado === 'rodando' && (
        <div className="search-status"><Loader2 size={14} className="spin" /> Procurando números…</div>
      )}

      {estado === 'feito' && resultado && (
        <div className="search-status ok">
          <Check size={14} /> Rodada concluída — <b>{resultado.found ?? 0}</b> com número, {resultado.missing ?? 0} sem,
          {resultado.erros ? <> {resultado.erros} com erro,</> : ''} de {resultado.processados ?? 0} processados.
          Já dá pra disparar os que acharam número (painel abaixo).
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn ghost sm" onClick={reset}>Enriquecer mais</button>
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
