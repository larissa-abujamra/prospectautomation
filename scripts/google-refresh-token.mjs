#!/usr/bin/env node
// =============================================================================
// Gera um GOOGLE_REFRESH_TOKEN para a olivia-agendar (fluxo OAuth de 1 vez).
//
// POR QUE: o free/busy do Google Calendar só mostra a agenda de quem a conta
// autorizada consegue ver. Para a Olivia checar a disponibilidade do TIME
// (@innerai.com), o refresh token precisa ser de uma conta DENTRO do Workspace
// (ex.: stefano@innerai.com ou growth@innerai.com) — dentro do mesmo domínio o
// free/busy dos colegas é visível por padrão.
//
// USO:
//   node scripts/google-refresh-token.mjs --client-id <ID> --client-secret <SECRET>
//   (ou exporte GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET antes)
//
//   1. Abre a URL de consentimento no navegador — faça login com a conta do
//      Workspace que vai "hospedar" a Olivia (a dona dos eventos).
//   2. O script recebe o code via http://localhost:53682 e troca pelo token.
//   3. Copie o comando `supabase secrets set ...` impresso no final.
//
// REQUISITO no Google Cloud Console (uma vez): OAuth Client (tipo "Web") com
// redirect URI http://localhost:53682 e a Google Calendar API ativada.
// =============================================================================

import http from 'node:http'
import { exec } from 'node:child_process'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const CLIENT_ID = arg('client-id') ?? process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = arg('client-secret') ?? process.env.GOOGLE_CLIENT_SECRET
const PORT = Number(arg('port') ?? 53682)
const REDIRECT = `http://localhost:${PORT}`

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Faltam credenciais. Use --client-id/--client-secret ou env GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.')
  process.exit(1)
}

// calendar.events (criar evento + Meet) + calendar.freebusy (ler agenda do time)
// + gmail.send (enviar o briefing da reunião pro rep). ATENÇÃO: gmail.send envia
// COMO a conta que autorizar aqui — autorize com a conta remetente desejada
// (ex.: uma conta @innerai.com do time/Olivia).
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ')

const consentUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline', // sem isso não vem refresh_token
    prompt: 'consent', // força re-emissão mesmo se já consentiu antes
  }).toString()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT)
  const code = url.searchParams.get('code')
  if (!code) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<h2>Pronto! Pode fechar esta aba e voltar ao terminal.</h2>')
  server.close()

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
    }),
  })
  const data = await tokenResp.json()
  if (!tokenResp.ok || !data.refresh_token) {
    console.error('\nFalha ao trocar o code pelo token:', JSON.stringify(data, null, 2))
    process.exit(1)
  }

  // Mostra qual conta foi autorizada (sanidade: tem que ser a do Workspace).
  let email = '(desconhecido)'
  try {
    const info = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${data.access_token}`,
    ).then((r) => r.json())
    email = info.email ?? email
  } catch { /* tokeninfo é só informativo */ }

  console.log('\n✔ Refresh token emitido para:', email)
  console.log('\nAgora rode:\n')
  console.log(`  npx supabase secrets set GOOGLE_REFRESH_TOKEN=${data.refresh_token}`)
  console.log('\nE configure o time (free/busy lido por e-mail dentro do Workspace):\n')
  console.log(
    '  npx supabase secrets set OLIVIA_REPS=\'[{"nome":"Fulano","email":"fulano@innerai.com"},{"nome":"Ciclana","email":"ciclana@innerai.com"}]\'',
  )
  process.exit(0)
})

server.listen(PORT, () => {
  console.log('Abrindo o consentimento do Google no navegador...')
  console.log('(se não abrir, cole esta URL manualmente)\n')
  console.log(consentUrl + '\n')
  const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  exec(`${opener} "${consentUrl.replaceAll('&', process.platform === 'win32' ? '^&' : '&')}"`)
})
