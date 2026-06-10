// Valida um link vindo de fonte externa (resposta do Google Calendar, etc.):
// só devolve a URL se for http(s). Bloqueia javascript:/data:/file: (XSS via href).
// Usado em qualquer <a href={…}> que renderize uma URL não-controlada por nós.
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}
