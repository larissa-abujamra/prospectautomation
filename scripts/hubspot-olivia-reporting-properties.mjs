#!/usr/bin/env node
// Idempotently creates/updates Olivia reporting properties on HubSpot contacts
// and deals. Safe to rerun; it does not touch records, workflows, or sends.
//
// Usage:
//   HUBSPOT_PRIVATE_APP_TOKEN=pat-... node scripts/hubspot-olivia-reporting-properties.mjs
//   node scripts/hubspot-olivia-reporting-properties.mjs --dry-run

const HUBSPOT_BASE = 'https://api.hubapi.com'
const dryRun = process.argv.includes('--dry-run')
const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN ?? process.env.HUBSPOT_TOKEN

const objectTypes = [
  { type: 'contacts', groupName: 'contactinformation' },
  { type: 'deals', groupName: 'dealinformation' },
]

const enumOption = (label, value, displayOrder) => ({
  label,
  value,
  displayOrder,
  hidden: false,
})

const properties = [
  {
    name: 'olivia_disparo_status',
    label: 'Olivia - status do disparo',
    description: 'Estado reportavel do disparo WhatsApp da Olivia. whatsapp_outreach continua sendo o campo de workflow.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      enumOption('Ready no workflow', 'ready', 0),
      enumOption('Acionado', 'triggered', 1),
      enumOption('Follow-up acionado', 'followup', 2),
      enumOption('Enviado', 'sent', 3),
      enumOption('Entregue', 'delivered', 4),
      enumOption('Lido', 'read', 5),
      enumOption('Respondeu', 'replied', 6),
      enumOption('Falhou', 'failed', 7),
      enumOption('Numero invalido', 'invalid', 8),
    ],
  },
  {
    name: 'olivia_disparado_em',
    label: 'Olivia - disparado em',
    description: 'Quando o workflow/envio WhatsApp da Olivia foi acionado.',
    type: 'datetime',
    fieldType: 'date',
  },
  {
    name: 'olivia_resposta_em',
    label: 'Olivia - resposta em',
    description: 'Quando o lead respondeu no WhatsApp.',
    type: 'datetime',
    fieldType: 'date',
  },
  {
    name: 'olivia_reuniao_status',
    label: 'Olivia - status da reuniao',
    description: 'Estado reportavel do agendamento conduzido pela Olivia.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      enumOption('Sem reuniao', 'none', 0),
      enumOption('Aguardando email', 'pending_email', 1),
      enumOption('Agendada', 'scheduled', 2),
      enumOption('Falhou', 'failed', 3),
    ],
  },
  {
    name: 'olivia_reuniao_em',
    label: 'Olivia - reuniao em',
    description: 'Horario confirmado da reuniao.',
    type: 'datetime',
    fieldType: 'date',
  },
  {
    name: 'olivia_reuniao_link',
    label: 'Olivia - link da reuniao',
    description: 'Link do Meet ou do evento de calendario criado pela Olivia.',
    type: 'string',
    fieldType: 'text',
  },
  {
    name: 'olivia_reuniao_titulo',
    label: 'Olivia - titulo da reuniao',
    description: 'Titulo do evento de calendario criado pela Olivia.',
    type: 'string',
    fieldType: 'text',
  },
  {
    name: 'olivia_inner_responsavel_nome',
    label: 'Olivia - responsavel Inner',
    description: 'Nome do membro Inner escolhido para a reuniao.',
    type: 'string',
    fieldType: 'text',
  },
  {
    name: 'olivia_inner_responsavel_email',
    label: 'Olivia - email responsavel Inner',
    description: 'Email do membro Inner escolhido para a reuniao.',
    type: 'string',
    fieldType: 'text',
  },
  {
    name: 'olivia_prospect_email',
    label: 'Olivia - email do prospect',
    description: 'Email do prospect usado para convite de calendario.',
    type: 'string',
    fieldType: 'text',
  },
]

function propertyBody(property, groupName) {
  const body = {
    name: property.name,
    label: property.label,
    description: property.description,
    groupName,
    type: property.type,
    fieldType: property.fieldType,
    hidden: false,
    formField: false,
  }
  if (property.options) body.options = property.options
  return body
}

async function hubspot(path, init = {}) {
  const resp = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const data = await resp.json().catch(() => null)
  if (!resp.ok && resp.status !== 404) {
    throw new Error(data?.message ?? `HubSpot ${path} failed with HTTP ${resp.status}`)
  }
  return { status: resp.status, data }
}

async function ensureProperty(objectType, groupName, property) {
  const body = propertyBody(property, groupName)
  if (dryRun) {
    console.log(`[dry-run] would ensure ${objectType}.${property.name}`)
    return
  }

  const get = await hubspot(`/crm/v3/properties/${objectType}/${property.name}`)
  if (get.status === 404) {
    await hubspot(`/crm/v3/properties/${objectType}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    console.log(`created ${objectType}.${property.name}`)
    return
  }

  const { type, fieldType, name, formField, ...mutableBody } = body
  await hubspot(`/crm/v3/properties/${objectType}/${property.name}`, {
    method: 'PATCH',
    body: JSON.stringify(mutableBody),
  })
  console.log(`updated ${objectType}.${property.name}`)
}

if (!dryRun && !token) {
  console.error('Missing HUBSPOT_PRIVATE_APP_TOKEN or HUBSPOT_TOKEN.')
  console.error('Required scopes: crm.schemas.contacts.read/write and crm.schemas.deals.read/write.')
  process.exit(1)
}

for (const objectType of objectTypes) {
  for (const property of properties) {
    await ensureProperty(objectType.type, objectType.groupName, property)
  }
}

console.log('Done. No records, workflows, or sends were triggered.')
