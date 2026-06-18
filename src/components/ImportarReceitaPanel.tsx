import { useState } from 'react'
import { Database, Loader2, AlertCircle, Check, Send } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LEADS_KEY } from '../lib/leads'
import { importarCnpjLeads, prepararRfParaDisparo } from '../lib/buscaMassa'
import { UFS } from '../../supabase/functions/_shared/ibge'

// Importa empresas do ÍNDICE LOCAL da Receita (grátis, sem Places) como leads
// crus, por UF + setor [+ município]. Requer o índice carregado
// (scripts/load-rf-cnpj.mjs); enquanto vazio, retorna 0.
export function ImportarReceitaPanel({ setor }: { setor: string }) {
  const qc = useQueryClient()
  const [uf, setUf] = useState('SP')
  const [municipio, setMunicipio] = useState('')
  const [max, setMax] = useState(1000)

  const imp = useMutation({
    mutationFn: () => importarCnpjLeads({ uf, municipio: municipio.trim() || undefined, setor: setor.trim(), max }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })

  const [prep, setPrep] = useState<{ done: number; total: number; resolved: number } | null>(null)
  const preparar = useMutation({
    mutationFn: () => {
      setPrep({ done: 0, total: 0, resolved: 0 })
      return prepararRfParaDisparo(50, setPrep)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: LEADS_KEY }),
  })

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Database size={14} /> Importar da Receita (grátis, sem Google)
      </div>
      <p className="muted-line" style={{ marginTop: 0 }}>
        Puxa empresas do índice local da Receita por UF + setor — sem custo de Places. Entram crus
        (CNPJ + dono já vêm), prontos pra descoberta de WhatsApp. Requer o índice carregado.
      </p>

      <div className="search-row" style={{ alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div className="field">
          <label className="eyebrow">Estado</label>
          <select value={uf} onChange={(e) => setUf(e.target.value)}>
            {UFS.map((u) => <option key={u.sigla} value={u.sigla}>{u.sigla}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="eyebrow">Município (opcional)</label>
          <input value={municipio} onChange={(e) => setMunicipio(e.target.value)} placeholder="Ex.: Campinas (vazio = UF toda)" />
        </div>
        <div className="field narrow">
          <label className="eyebrow">Máx.</label>
          <select value={max} onChange={(e) => setMax(Number(e.target.value))}>
            <option value={500}>500</option>
            <option value={1000}>1.000</option>
            <option value={5000}>5.000</option>
            <option value={10000}>10.000</option>
          </select>
        </div>
        <button className="btn" onClick={() => imp.mutate()} disabled={imp.isPending || !setor.trim()} title={setor.trim() ? '' : 'Preencha o setor acima'}>
          {imp.isPending ? <><Loader2 size={15} className="spin" /> Importando…</> : <><Database size={15} /> Importar</>}
        </button>
      </div>

      {imp.isError && (
        <div className="search-status err" style={{ marginTop: 8 }}>
          <AlertCircle size={14} /> {(imp.error as Error).message}
        </div>
      )}
      {imp.isSuccess && (
        <div className="search-status ok" style={{ marginTop: 8 }}>
          <Check size={14} /> {imp.data.inserted} leads novos ({imp.data.scanned} varridos, {imp.data.skipped_existing} já existiam).
          CNAE: {imp.data.cnae.join(', ') || '—'}.
          {imp.data.scanned === 0 && ' Índice vazio? Rode o ETL da Receita (load-rf-cnpj).'}
        </div>
      )}

      {/* Sendability: leads da Receita entram sem place_id (o HubSpot precisa
          dele). Resolve no Google em lote os que vai contatar (1 req/lead). */}
      <div className="panel-actions" style={{ marginTop: 10 }}>
        <button className="btn ghost sm" onClick={() => preparar.mutate()} disabled={preparar.isPending}
          title="Resolve no Google os leads da Receita sem place_id (custa 1 requisição por lead).">
          {preparar.isPending
            ? <><Loader2 size={14} className="spin" /> Resolvendo {prep ? `${prep.done}/${prep.total}` : '…'}</>
            : <><Send size={14} /> Preparar p/ disparo (resolver no Google)</>}
        </button>
      </div>
      {preparar.isSuccess && (
        <div className="search-status ok" style={{ marginTop: 6 }}>
          <Check size={14} /> {preparar.data.resolved}/{preparar.data.tried} leads resolvidos no Google e prontos pra disparo.
        </div>
      )}
      {preparar.isError && (
        <div className="search-status err" style={{ marginTop: 6 }}>
          <AlertCircle size={14} /> {(preparar.error as Error).message}
        </div>
      )}
    </div>
  )
}
