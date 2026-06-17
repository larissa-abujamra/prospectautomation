import { shouldAdvanceSendStatus } from './whatsapp_webhook.ts'

export type HubspotWorkflowWritebackStatus = 'sent' | 'delivered' | 'read'

export interface HubspotWorkflowWritebackEvent {
  contactId: string
  status: HubspotWorkflowWritebackStatus
  occurredAt?: string
}

export type HubspotWorkflowWritebackParseResult =
  | ({ ok: true } & HubspotWorkflowWritebackEvent)
  | { ok: false; error: string }

export interface HubspotWorkflowWritebackLeadSnapshot {
  whatsapp_send_status: string | null
  whatsapp_sent_at: string | null
}

export interface HubspotWorkflowWritebackPatchResult {
  shouldUpdate: boolean
  patch: {
    whatsapp_send_status?: HubspotWorkflowWritebackStatus
    whatsapp_sent_at?: string
  }
}

const ACCEPTED_STATUSES = new Set<HubspotWorkflowWritebackStatus>([
  'sent',
  'delivered',
  'read',
])

const ADVANCEABLE_CURRENT_STATUSES: Record<HubspotWorkflowWritebackStatus, Array<string | null>> = {
  sent: [null, 'failed', 'invalid'],
  delivered: [null, 'failed', 'invalid', 'sent'],
  read: [null, 'failed', 'invalid', 'sent', 'delivered'],
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (value == null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return null
}

function normalizeStatus(value: unknown): HubspotWorkflowWritebackStatus | null {
  const status = firstText(value)?.toLowerCase()
  if (!status || !ACCEPTED_STATUSES.has(status as HubspotWorkflowWritebackStatus)) {
    return null
  }
  return status as HubspotWorkflowWritebackStatus
}

function normalizeTimestamp(value: unknown): string | undefined {
  const text = firstText(value)
  if (!text) return undefined

  const numeric = Number(text)
  const ms = Number.isFinite(numeric)
    ? numeric > 1_000_000_000_000
      ? numeric
      : numeric * 1000
    : Date.parse(text)

  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toISOString()
}

function validHubspotContactId(value: string): boolean {
  return /^[0-9]{1,32}$/.test(value)
}

export function workflowSecretAttempt(headers: Headers): boolean {
  return !!(
    firstText(headers.get('x-olivia-secret')) ||
    firstText(headers.get('authorization'))?.toLowerCase().startsWith('bearer ')
  )
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) return false

  let diff = 0
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i]
  }
  return diff === 0
}

export function verifyWorkflowSecret(headers: Headers, expectedSecret: string | null | undefined): boolean {
  const expected = firstText(expectedSecret)
  if (!expected) return false

  const bearer = firstText(headers.get('authorization'))?.match(/^Bearer\s+(.+)$/i)?.[1]
  const provided = firstText(headers.get('x-olivia-secret'), bearer)
  return !!provided && timingSafeEqual(provided, expected)
}

export function parseHubspotWorkflowWritebackPayload(
  body: unknown,
): HubspotWorkflowWritebackParseResult {
  const root = asObject(body)
  const inputFields = asObject(root.inputFields)
  const object = asObject(root.object)

  const contactId = firstText(
    root.hubspot_contact_id,
    root.hubspotContactId,
    root.contactId,
    root.objectId,
    root.hs_object_id,
    inputFields.hubspot_contact_id,
    inputFields.hubspotContactId,
    inputFields.contactId,
    inputFields.hs_object_id,
    object.objectId,
  )
  if (!contactId) return { ok: false, error: 'hubspot_contact_id ausente.' }
  if (!validHubspotContactId(contactId)) return { ok: false, error: 'hubspot_contact_id inválido.' }

  const status = normalizeStatus(
    firstText(
      root.status,
      root.whatsapp_send_status,
      root.whatsapp_outreach,
      inputFields.status,
      inputFields.whatsapp_send_status,
      inputFields.whatsapp_outreach,
    ),
  )
  if (!status) return { ok: false, error: 'status ausente ou não suportado.' }

  const occurredAt = normalizeTimestamp(
    firstText(
      root.occurred_at,
      root.occurredAt,
      root.timestamp,
      root.updated_at,
      inputFields.occurred_at,
      inputFields.occurredAt,
      inputFields.timestamp,
      inputFields.updated_at,
      inputFields.hs_lastmodifieddate,
    ),
  )

  return { ok: true, contactId, status, ...(occurredAt ? { occurredAt } : {}) }
}

export function advanceableWorkflowCurrentStatuses(
  status: HubspotWorkflowWritebackStatus,
): Array<string | null> {
  return [...ADVANCEABLE_CURRENT_STATUSES[status]]
}

export function buildHubspotWorkflowWritebackPatch(
  lead: HubspotWorkflowWritebackLeadSnapshot,
  event: Pick<HubspotWorkflowWritebackEvent, 'status' | 'occurredAt'>,
  nowIso = new Date().toISOString(),
): HubspotWorkflowWritebackPatchResult {
  const patch: HubspotWorkflowWritebackPatchResult['patch'] = {}

  if (shouldAdvanceSendStatus(lead.whatsapp_send_status, event.status)) {
    patch.whatsapp_send_status = event.status
  }

  if (!lead.whatsapp_sent_at) {
    patch.whatsapp_sent_at = event.occurredAt ?? nowIso
  }

  return { shouldUpdate: Object.keys(patch).length > 0, patch }
}
