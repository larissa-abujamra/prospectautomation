// Normalização/validação de telefone BR para E.164 — usada na entrada MANUAL de
// número WhatsApp. Anti-invenção: número que não casa volta null (não salvamos
// lixo com status 'found', o que fingiria um WhatsApp válido inexistente).
//
// Aceita: já em E.164 (+55 + DDD + 8/9 dígitos) OU local com DDD (10/11 dígitos).
// Recusa: curto demais, longo demais, ou país != 55.

// E.164 BR = +55 + DDD(2) + assinante(8 fixo | 9 móvel) = 12 ou 13 dígitos.
export function toE164Br(raw: string): string | null {
  const s = (raw ?? '').trim()
  const d = s.replace(/\D/g, '')
  // '+' explícito = país declarado: aceitamos SÓ +55 (um +1 dos EUA tem 11
  // dígitos e colidiria com um móvel BR local; o '+' desfaz a ambiguidade).
  if (s.startsWith('+')) {
    return (d.length === 12 || d.length === 13) && d.startsWith('55') ? '+' + d : null
  }
  // Sem '+': pode vir já com 55 na frente (12 fixo/13 móvel) …
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return '+' + d
  // … ou local com DDD (10 fixo, 11 móvel) — assumimos BR (ferramenta é SP).
  if (d.length === 10 || d.length === 11) return '+55' + d
  return null
}

export function ehTelefoneBrValido(raw: string): boolean {
  return toE164Br(raw) !== null
}
