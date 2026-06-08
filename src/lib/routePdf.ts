import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import type { LeadComCoord } from './route'
import { fmtInt } from './format'

const COMBINING = /[̀-ͯ]/g

function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(COMBINING, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'sao-paulo'
  )
}

// Captura o mapa Leaflet como imagem (keyless). Pode falhar (tiles cross-origin,
// etc.) — nesse caso devolve null e o PDF sai só com a lista (nunca deixa a
// pessoa sem documento de campo).
async function capturarMapa(elementId: string): Promise<string | null> {
  const el = document.getElementById(elementId)
  if (!el) return null
  try {
    const canvas = await html2canvas(el, {
      useCORS: true,
      backgroundColor: '#ffffff',
      scale: 2,
      logging: false,
    })
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export async function gerarRotaPdf(opts: {
  area: string
  stops: LeadComCoord[]
  mapElementId: string
}): Promise<void> {
  const { area, stops, mapElementId } = opts
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 14
  const contentW = pageW - margin * 2
  let y = margin

  const hoje = new Date()
  const dataLonga = hoje.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
  const dataArquivo = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`

  // Header
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(17, 24, 39)
  doc.text('Rota de prospecção', margin, y + 4)
  y += 10
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(107, 114, 128)
  doc.text(`${area} · ${dataLonga}`, margin, y)
  y += 8

  // Imagem do mapa (com fallback)
  const img = await capturarMapa(mapElementId)
  if (img) {
    const props = doc.getImageProperties(img)
    let w = contentW
    let h = (props.height / props.width) * w
    const maxH = 95
    if (h > maxH) {
      h = maxH
      w = (props.width / props.height) * h
    }
    const x = margin + (contentW - w) / 2
    doc.addImage(img, 'PNG', x, y, w, h)
    y += h + 8
  }

  // Lista numerada
  doc.setDrawColor(229, 231, 235)
  doc.line(margin, y, pageW - margin, y)
  y += 7

  const ensureSpace = (need: number) => {
    if (y + need > pageH - margin) {
      doc.addPage()
      y = margin
    }
  }

  stops.forEach((s, i) => {
    ensureSpace(26)
    // Nome
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(17, 24, 39)
    doc.text(`${i + 1}. ${s.nome}`, margin, y)
    y += 5.5

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9.5)
    doc.setTextColor(75, 85, 99)
    const endereco = s.endereco ?? '—'
    doc.text(doc.splitTextToSize(endereco, contentW), margin, y)
    y += 5

    const contato = [
      s.telefone ?? '—',
      s.instagram_handle ? `@${s.instagram_handle}` : '—',
      s.instagram_followers != null ? `${fmtInt(s.instagram_followers)} seg.` : '— seg.',
    ].join('   ·   ')
    doc.text(contato, margin, y)
    y += 6

    // Checkbox impresso + notas
    doc.setDrawColor(120, 120, 120)
    doc.rect(margin, y - 3.2, 3.6, 3.6) // ▢
    doc.setTextColor(107, 114, 128)
    doc.text('visitado', margin + 5.5, y)
    doc.text('notas: ______________________________________', margin + 28, y)
    y += 8
  })

  // Rodapé
  ensureSpace(10)
  doc.setFontSize(9)
  doc.setTextColor(156, 163, 175)
  doc.text(
    `${stops.length} ${stops.length === 1 ? 'parada' : 'paradas'}`,
    margin,
    pageH - 8,
  )

  doc.save(`rota-${slug(area)}-${dataArquivo}.pdf`)
}
