import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { LEADS_KEY } from '../../lib/leads'
import type { Lead } from '../../lib/types'

// Importa seguidores do Instagram via CSV (export do Manus, p.ex.).
// Aceita um CSV com header contendo `instagram_followers` e UMA chave de match:
// `instagram_handle` OU `google_place_id`. Faz match com os leads carregados e
// atualiza só o campo instagram_followers. Linhas sem match são ignoradas
// (nunca cria lead novo nem inventa dado). Parser simples — assume CSV bem
// comportado (vírgula como separador, sem vírgula dentro dos campos).
function parseCsv(text: string): { key: 'handle' | 'place'; rows: Map<string, number> } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return null

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const followersIdx = header.indexOf('instagram_followers')
  if (followersIdx === -1) return null

  let keyIdx = header.indexOf('instagram_handle')
  let key: 'handle' | 'place' = 'handle'
  if (keyIdx === -1) {
    keyIdx = header.indexOf('google_place_id')
    key = 'place'
  }
  if (keyIdx === -1) return null

  const rows = new Map<string, number>()
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const rawKey = cols[keyIdx]
    const rawVal = cols[followersIdx]
    if (!rawKey || rawVal == null || rawVal === '') continue
    const followers = Number(rawVal.replace(/\D/g, ''))
    if (!Number.isFinite(followers)) continue
    const normKey = key === 'handle' ? rawKey.replace(/^@/, '').toLowerCase() : rawKey
    rows.set(normKey, followers)
  }
  return { key, rows }
}

export function CsvImport({ leads }: { leads: Lead[] }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)

  const importMut = useMutation({
    mutationFn: async (text: string) => {
      const parsed = parseCsv(text)
      if (!parsed) {
        throw new Error(
          'CSV inválido. Use colunas: instagram_handle,instagram_followers (ou google_place_id,instagram_followers).',
        )
      }

      // Constrói os updates casando com os leads em memória.
      const updates: { id: string; followers: number }[] = []
      for (const lead of leads) {
        const k =
          parsed.key === 'handle'
            ? lead.instagram_handle?.replace(/^@/, '').toLowerCase()
            : lead.google_place_id
        if (!k) continue
        const followers = parsed.rows.get(k)
        if (followers == null) continue
        updates.push({ id: lead.id, followers })
      }

      let updated = 0
      for (const u of updates) {
        const { error } = await supabase
          .from('leads')
          .update({ instagram_followers: u.followers })
          .eq('id', u.id)
        if (error) throw error
        updated++
      }
      return { updated, rows: parsed.rows.size }
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: LEADS_KEY })
      setMsg(`${res.updated} de ${res.rows} linha(s) casadas e atualizadas.`)
    },
    onError: (err) => setMsg((err as Error).message),
  })

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setMsg(null)
    const text = await file.text()
    importMut.mutate(text)
    e.target.value = '' // permite reimportar o mesmo arquivo
  }

  return (
    <>
      <button
        type="button"
        className="btn ghost"
        onClick={() => inputRef.current?.click()}
        disabled={importMut.isPending}
        title="CSV com instagram_handle,instagram_followers ou google_place_id,instagram_followers"
      >
        <Upload size={15} />
        {importMut.isPending ? 'Importando…' : 'Importar seguidores (CSV)'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      {msg && <span className="search-status" style={{ marginTop: 0 }}>{msg}</span>}
    </>
  )
}
