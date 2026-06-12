import { useEffect, useRef, useState } from 'react'
import { MapPin, Loader2 } from 'lucide-react'
import { autocompleteLocal, type LocalSugestao } from '../lib/leads'

// Campo "Local" com autocomplete do Google Places (via Edge Function — a chave
// fica no servidor). Resolve nomes ambíguos: "Alta Floresta" pode ser a cidade
// no MT ou um bairro homônimo em outro estado; escolher a sugestão grava a
// descrição COMPLETA ("Alta Floresta, MT, Brasil"), que desambigua a busca.
// Texto livre continua valendo (quem não escolher sugestão busca o que digitou).

const DEBOUNCE_MS = 300
const MIN_CHARS = 3

export function LocalAutocomplete({
  id,
  value,
  onChange,
  placeholder = 'Ex.: Alta Floresta - MT, ou Pinheiros, São Paulo',
}: {
  id: string
  value: string
  onChange: (texto: string) => void
  placeholder?: string
}) {
  const [sugestoes, setSugestoes] = useState<LocalSugestao[]>([])
  const [aberto, setAberto] = useState(false)
  const [buscando, setBuscando] = useState(false)
  // Última descrição ESCOLHIDA: enquanto o valor for igual a ela, não re-busca
  // (senão o dropdown reabriria logo após a escolha).
  const escolhido = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const texto = value.trim()
    if (texto.length < MIN_CHARS || texto === escolhido.current) {
      setSugestoes([])
      setAberto(false)
      setBuscando(false)
      return
    }
    setBuscando(true)
    timer.current = setTimeout(async () => {
      const seq = ++reqSeq.current
      const r = await autocompleteLocal(texto)
      // Resposta velha (o usuário continuou digitando) é descartada.
      if (seq !== reqSeq.current) return
      setBuscando(false)
      setSugestoes(r)
      setAberto(r.length > 0)
    }, DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [value])

  function escolher(s: LocalSugestao) {
    escolhido.current = s.descricao
    onChange(s.descricao)
    setSugestoes([])
    setAberto(false)
  }

  return (
    <div className="local-ac">
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => sugestoes.length > 0 && setAberto(true)}
        // Timeout no blur: deixa o clique na sugestão registrar antes de fechar.
        onBlur={() => setTimeout(() => setAberto(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setAberto(false)
        }}
      />
      {buscando && <Loader2 size={14} className="spin local-ac-spin" />}
      {aberto && (
        <ul className="local-ac-list" role="listbox">
          {sugestoes.map((s) => (
            <li key={s.place_id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="local-ac-item"
                // onMouseDown (não onClick): dispara ANTES do blur do input.
                onMouseDown={(e) => {
                  e.preventDefault()
                  escolher(s)
                }}
              >
                <MapPin size={13} className="local-ac-pin" />
                <span className="local-ac-main">{s.principal}</span>
                {s.secundario && <span className="local-ac-sub">{s.secundario}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
