import { useState } from 'react'
import { Rocket, Loader2, AlertCircle } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { termoBusca } from '../lib/setores'
import { enfileirarMassa, listarJobsMassa, type EscopoTipo, type JobMassa } from '../lib/buscaMassa'
import { UFS } from '../../supabase/functions/_shared/ibge'

const JOBS_KEY = ['scrape-jobs'] as const

// Varredura em MASSA em background: escopo (cidade / região metro / estado
// inteiro via IBGE) → fila de municípios drenada por um worker em cron, sem
// precisar manter a aba aberta. Teto de leads novos por job controla o custo.
export function JobMassaPanel({ setor, local }: { setor: string; local: string }) {
  const qc = useQueryClient()
  const [tipo, setTipo] = useState<EscopoTipo>('metro')
  const [metro, setMetro] = useState('grande_sp')
  const [uf, setUf] = useState('SP')
  const [cap, setCap] = useState(500)

  const jobs = useQuery({
    queryKey: JOBS_KEY,
    queryFn: listarJobsMassa,
    refetchInterval: 5000, // progresso ao vivo enquanto o worker drena
  })

  const lancar = useMutation({
    mutationFn: () => {
      const valor = tipo === 'cidade' ? local.trim() : tipo === 'metro' ? metro : uf
      return enfileirarMassa({
        setor: termoBusca(setor.trim()),
        escopo: { tipo, valor },
        maxInserts: cap > 0 ? cap : null,
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: JOBS_KEY }),
  })

  const podeIniciar =
    !!setor.trim() && (tipo !== 'cidade' || !!local.trim()) && !lancar.isPending

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Rocket size={14} /> Varredura em massa (estado/região, em background)
      </div>
      <p className="muted-line" style={{ marginTop: 0 }}>
        Enfileira todos os municípios do escopo e um worker varre em background (não precisa
        deixar a aba aberta). Usa o setor acima. O teto de leads novos controla o custo.
      </p>

      <div className="search-row" style={{ alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div className="field">
          <label className="eyebrow">Escopo</label>
          <select value={tipo} onChange={(e) => setTipo(e.target.value as EscopoTipo)}>
            <option value="metro">Região metropolitana</option>
            <option value="uf">Estado inteiro</option>
            <option value="cidade">Cidade (campo Local acima)</option>
          </select>
        </div>

        {tipo === 'metro' && (
          <div className="field">
            <label className="eyebrow">Região</label>
            <select value={metro} onChange={(e) => setMetro(e.target.value)}>
              <option value="grande_sp">Grande São Paulo (39 cidades)</option>
              <option value="grande_rio">Grande Rio (22 cidades)</option>
            </select>
          </div>
        )}
        {tipo === 'uf' && (
          <div className="field">
            <label className="eyebrow">Estado</label>
            <select value={uf} onChange={(e) => setUf(e.target.value)}>
              {UFS.map((u) => <option key={u.sigla} value={u.sigla}>{u.nome} ({u.sigla})</option>)}
            </select>
          </div>
        )}
        {tipo === 'cidade' && (
          <div className="field" style={{ flex: 1 }}>
            <label className="eyebrow">Cidade</label>
            <input value={local} readOnly placeholder="(use o campo Local acima)" />
          </div>
        )}

        <div className="field narrow">
          <label className="eyebrow">Teto de leads novos</label>
          <input type="number" min={0} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </div>

        <button className="btn" onClick={() => lancar.mutate()} disabled={!podeIniciar}>
          {lancar.isPending ? <><Loader2 size={15} className="spin" /> Lançando…</> : <><Rocket size={15} /> Lançar varredura</>}
        </button>
      </div>

      {lancar.isError && (
        <div className="search-status err" style={{ marginTop: 8 }}>
          <AlertCircle size={14} /> {(lancar.error as Error).message}
        </div>
      )}
      {lancar.isSuccess && (
        <div className="search-status ok" style={{ marginTop: 8 }}>
          Job lançado: {lancar.data.total_tasks} município(s) na fila. Progresso abaixo (atualiza sozinho).
        </div>
      )}

      {(jobs.data?.length ?? 0) > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Jobs recentes</div>
          {jobs.data!.map((j) => <JobRow key={j.id} job={j} />)}
        </div>
      )}
    </div>
  )
}

function JobRow({ job }: { job: JobMassa }) {
  const pct = job.total_tasks > 0 ? Math.round((job.tasks_done / job.total_tasks) * 100) : 0
  const escopo =
    job.escopo_tipo === 'uf' ? `Estado ${job.escopo_valor}` :
    job.escopo_tipo === 'metro' ? (job.escopo_valor === 'grande_rio' ? 'Grande Rio' : 'Grande SP') :
    job.escopo_valor
  return (
    <div className="enrich-row" style={{ alignItems: 'center' }}>
      <span className="er-label" style={{ minWidth: 0, flex: 1 }}>
        <span className="status-dot" data-status={job.status === 'done' ? 'ok' : job.status === 'running' ? 'pending' : undefined} />
        {job.setor} · {escopo}
      </span>
      <span className="er-val" style={{ gap: 10 }}>
        <span className="badge">{job.status}</span>
        {job.tasks_done}/{job.total_tasks} mun. ({pct}%) · <b>{job.inserted_total}</b> novos
      </span>
    </div>
  )
}
