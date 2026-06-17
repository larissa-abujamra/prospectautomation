// Chip do lead score, compartilhado pela Base de Dados e pela Prospecção pra
// não divergirem. Faixas: null→cinza, 0→cinza, 1-3→amarelo, 4-7→verde (max 7).
export function ScoreChip({ score }: { score: number | null }) {
  if (score == null) return <span className="score-chip score-null">—</span>
  if (score === 0) return <span className="score-chip score-zero">{score}</span>
  if (score <= 3) return <span className="score-chip score-mid">{score}</span>
  return <span className="score-chip score-high">{score}</span>
}
