import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
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

// Estado da varredura em massa (grade) LEVANTADO pra um provider montado no
// AppShell — uma rota de layout do React Router que NÃO desmonta ao trocar de
// página. Antes o loop e o progresso viviam no BuscaMassaPanel; ao navegar pra
// outra aba o painel desmontava, a UI resetava e o usuário perdia a visão/controle
// da varredura. Aqui o loop continua e o progresso sobrevive à navegação (o painel
// vira um consumidor que re-renderiza o estado vivo ao voltar pra /prospectar).
// Limite real: um reload completo da aba ainda zera (é client-side) — pra isso
// existe a "Varredura em massa (background)" via fila + worker.

const CELL_KM = 2
const MAX_TERMOS = 2
const MAX_PAGINAS = 2

export type EstadoMassa = 'idle' | 'planejando' | 'preview' | 'rodando' | 'feito' | 'erro'

interface BuscaMassaCtx {
  estado: EstadoMassa
  erro: string
  plano: PlanoMassa | null
  prog: ProgressoMassa | null
  /** Local da varredura em andamento (display estável mesmo se o form mudar). */
  localRodando: string | null
  cellKm: number
  estimar: (local: string) => Promise<void>
  varrer: (setor: string) => Promise<void>
  cancelar: () => void
  reset: () => void
}

const Ctx = createContext<BuscaMassaCtx | null>(null)

export function BuscaMassaProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [estado, setEstado] = useState<EstadoMassa>('idle')
  const [erro, setErro] = useState('')
  const [plano, setPlano] = useState<PlanoMassa | null>(null)
  const [prog, setProg] = useState<ProgressoMassa | null>(null)
  const [localRodando, setLocalRodando] = useState<string | null>(null)
  const localPlano = useRef('')
  const cancelRef = useRef<{ cancelado: boolean }>({ cancelado: false })

  async function estimar(local: string) {
    setErro('')
    setEstado('planejando')
    try {
      const geo = await geocodarLocal(local.trim())
      const p = planejarMassa(geo, { cellKm: CELL_KM, maxTermos: MAX_TERMOS, maxPaginas: MAX_PAGINAS })
      localPlano.current = local.trim()
      setPlano(p)
      setEstado('preview')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao localizar a região.')
      setEstado('erro')
    }
  }

  async function varrer(setor: string) {
    if (!plano) return
    setErro('')
    setEstado('rodando')
    setLocalRodando(localPlano.current)
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

  function reset() {
    setEstado('idle')
    setProg(null)
    setPlano(null)
    setErro('')
    setLocalRodando(null)
  }

  return (
    <Ctx.Provider
      value={{ estado, erro, plano, prog, localRodando, cellKm: CELL_KM, estimar, varrer, cancelar, reset }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useBuscaMassa(): BuscaMassaCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useBuscaMassa precisa do BuscaMassaProvider (AppShell)')
  return c
}

// Pílula global (qualquer página): mostra que a varredura segue rodando e leva
// de volta pro painel. Some quando não há varredura em andamento.
export function BuscaMassaIndicator() {
  const { estado, prog } = useBuscaMassa()
  if (estado !== 'rodando' || !prog) return null
  const pct = prog.totalTiles > 0 ? Math.round((prog.tilesDone / prog.totalTiles) * 100) : 0
  return (
    <Link
      to="/prospectar"
      className="busca-massa-indicator"
      title="Varredura em massa em andamento — clique para ver"
    >
      <Loader2 size={13} className="spin" />
      <span>
        Varredura {prog.tilesDone}/{prog.totalTiles} ({pct}%) · {prog.insertedTotal} leads
      </span>
    </Link>
  )
}
