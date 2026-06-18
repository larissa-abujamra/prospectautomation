import { useState } from 'react'
import { Database, Loader2, AlertCircle, Check } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LEADS_KEY } from '../lib/leads'
import { importarCnpjLeads } from '../lib/buscaMassa'
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
    </div>
  )
}
