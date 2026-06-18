import { useState } from 'react'
import { Send, Loader2, X, Check, AlertCircle, AlertTriangle } from 'lucide-react'
import { useBulkDispatch, type BulkDispatchResult } from '../lib/leads'

// O servidor limita em 100 (MAX_POR_LOTE) e dispara em chunks paralelos pequenos.
// O gargalo é o rate de invocação function->function do Supabase (não a Meta —
// número em tier 100k/dia). Default modesto; suba até 100 por lote.
const LIMITE_PADRAO = 50
const LIMITE_MAX = 100

type Estado = 'idle' | 'previa' | 'rodando' | 'feito' | 'erro'

// Dispara o workflow de WhatsApp do HubSpot em LOTE para os leads prontos
// (whatsapp_status=found, nunca disparados, sem DDD divergente). Sempre passa
// por uma PRÉ-VISUALIZAÇÃO (dry-run) antes do envio real — nada é enviado até o
// clique de confirmação. Reaproveita o setor digitado no formulário como filtro.
export function DisparoMassaPanel({ setor }: { setor: string }) {
  const [estado, setEstado] = useState<Estado>('idle')
  const [erro, setErro] = useState('')
  const [limite, setLimite] = useState(LIMITE_PADRAO)
  const [previa, setPrevia] = useState<BulkDispatchResult | null>(null)
  const [resultado, setResultado] = useState<BulkDispatchResult | null>(null)
  const disparo = useBulkDispatch()

  const setorFiltro = setor.trim()

  async function preVisualizar() {
    setErro('')
    try {
      const res = await disparo.mutateAsync({ dryRun: true, limite, setor: setorFiltro || null })
      setPrevia(res)
      setEstado('previa')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao pré-visualizar.')
      setEstado('erro')
    }
  }

  async function dispararDeVerdade() {
    setErro('')
    setEstado('rodando')
    try {
      const res = await disparo.mutateAsync({ dryRun: false, limite, setor: setorFiltro || null })
      setResultado(res)
      setEstado('feito')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha no disparo.')
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
        <Send size={14} /> Disparar WhatsApp em lote
      </div>
      <p className="muted-line" style={{ marginTop: 0 }}>
        Aciona o workflow de WhatsApp do HubSpot para os leads <b>prontos</b> (com número achado,
        nunca disparados){setorFiltro ? <> do setor <b>{setorFiltro}</b></> : ' (todos os setores)'}.
        Sempre mostra uma prévia antes — <b>nada é enviado até você confirmar</b>.
      </p>

      {estado === 'idle' && (
        <div>
          <div className="enrich-row">
            <span className="er-label">Tamanho do lote</span>
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
          <div className="panel-actions" style={{ marginTop: 10 }}>
            <button className="btn" onClick={preVisualizar} disabled={disparo.isPending}>
              {disparo.isPending ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Pré-visualizar disparo
            </button>
          </div>
        </div>
      )}

      {estado === 'previa' && previa && (
        <div>
          {previa.selecionados === 0 ? (
            <div className="search-status">
              Nenhum lead pronto para disparo{setorFiltro ? <> em <b>{setorFiltro}</b></> : ''}.
              <div style={{ marginTop: 8 }}>
                <button className="btn ghost sm" onClick={reset}>Voltar</button>
              </div>
            </div>
          ) : (
            <>
              <div className="enrich-row">
                <span className="er-label">Serão disparados</span>
                <span className="er-val"><b>{previa.selecionados}</b> leads</span>
              </div>
              {previa.leads && previa.leads.length > 0 && (
                <ul className="muted-line" style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 140, overflow: 'auto' }}>
                  {previa.leads.slice(0, 10).map((l) => (
                    <li key={l.id}>{l.nome ?? '(sem nome)'}</li>
                  ))}
                  {previa.leads.length > 10 && <li>… e mais {previa.leads.length - 10}</li>}
                </ul>
              )}
              <div className="search-status err" style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>Isto envia mensagens reais de WhatsApp via HubSpot. Confirme só quando estiver certo.</span>
              </div>
              <div className="panel-actions" style={{ marginTop: 10 }}>
                <button className="btn danger" onClick={dispararDeVerdade} disabled={disparo.isPending}>
                  <Send size={15} /> Disparar para {previa.selecionados}
                </button>
                <button className="btn ghost" onClick={reset} disabled={disparo.isPending}>
                  <X size={14} /> Cancelar
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {estado === 'rodando' && (
        <div className="search-status"><Loader2 size={14} className="spin" /> Disparando o lote…</div>
      )}

      {estado === 'feito' && resultado && (
        <div className="search-status ok">
          <Check size={14} /> Lote disparado — <b>{resultado.disparados ?? 0}</b> enviados
          {resultado.erros ? <>, <b>{resultado.erros}</b> com erro</> : ''} de {resultado.selecionados} selecionados.
          {resultado.erros_detalhe && resultado.erros_detalhe.length > 0 && (
            <ul className="muted-line" style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 120, overflow: 'auto' }}>
              {resultado.erros_detalhe.slice(0, 8).map((e) => (
                <li key={e.id}>{e.id}: {e.erro}</li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={reset}>Disparar outro lote</button>
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
