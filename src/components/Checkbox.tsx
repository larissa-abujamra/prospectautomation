import { Check } from 'lucide-react'

// Checkbox quadrado (20px) com check branco sobre fundo --ink quando marcado.
export function Checkbox({
  checked,
  onChange,
  title,
  ariaLabel,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  title?: string
  ariaLabel?: string
}) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel ?? title}
      tabIndex={0}
      title={title}
      className={`checkbox${checked ? ' checked' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onChange(!checked)
        }
      }}
    >
      {checked && <Check size={14} strokeWidth={3} />}
    </span>
  )
}
