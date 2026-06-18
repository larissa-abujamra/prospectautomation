// Envio de email via Gmail API, reusando o access token do Google (mesmo OAuth
// do Calendar, agora com o escopo gmail.send). Envia COMO a conta que autorizou
// o refresh token. Mensagem em HTML, UTF-8. Lança em erro (quem chama decide
// não derrubar o fluxo — o agendamento é prioridade).

const te = new TextEncoder()

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// base64url (sem padding) — formato do campo `raw` da Gmail API.
function b64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Assunto com acento → RFC 2047 (=?UTF-8?B?...?=). ASCII puro passa direto.
function encodeSubject(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s
  return `=?UTF-8?B?${bytesToB64(te.encode(s))}?=`
}

export interface EmailGmail {
  to: string
  subject: string
  html: string
}

export async function enviarEmailGmail(accessToken: string, msg: EmailGmail): Promise<void> {
  const raw = b64url(
    te.encode(
      [
        `To: ${msg.to}`,
        `Subject: ${encodeSubject(msg.subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        msg.html,
      ].join('\r\n'),
    ),
  )

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })

  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '')
    throw new Error(`Gmail send HTTP ${resp.status}: ${detalhe.slice(0, 300)}`)
  }
}
