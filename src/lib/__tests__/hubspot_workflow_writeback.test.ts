import { describe, expect, it } from 'vitest'
import {
  advanceableWorkflowCurrentStatuses,
  buildHubspotWorkflowWritebackPatch,
  parseHubspotWorkflowWritebackPayload,
  verifyWorkflowSecret,
} from '../../../supabase/functions/_shared/hubspot_workflow_writeback'

describe('HubSpot workflow write-back auth', () => {
  it('accepts x-olivia-secret or bearer token and rejects missing/wrong secrets', () => {
    expect(verifyWorkflowSecret(new Headers({ 'x-olivia-secret': 'secret-1' }), 'secret-1')).toBe(true)
    expect(verifyWorkflowSecret(new Headers({ authorization: 'Bearer secret-1' }), 'secret-1')).toBe(true)
    expect(verifyWorkflowSecret(new Headers({ authorization: 'Basic secret-1' }), 'secret-1')).toBe(false)
    expect(verifyWorkflowSecret(new Headers({ 'x-olivia-secret': 'wrong' }), 'secret-1')).toBe(false)
    expect(verifyWorkflowSecret(new Headers({}), 'secret-1')).toBe(false)
    expect(verifyWorkflowSecret(new Headers({ 'x-olivia-secret': 'secret-1' }), '')).toBe(false)
  })
})

describe('HubSpot workflow write-back payload', () => {
  it('parses direct workflow payloads by hubspot_contact_id and sent status', () => {
    expect(
      parseHubspotWorkflowWritebackPayload({
        hubspot_contact_id: '12345',
        status: 'sent',
        occurred_at: '2026-06-15T18:10:00Z',
      }),
    ).toEqual({
      ok: true,
      contactId: '12345',
      status: 'sent',
      occurredAt: '2026-06-15T18:10:00.000Z',
    })
  })

  it('parses HubSpot Custom Code inputFields using hs_object_id and whatsapp_outreach', () => {
    expect(
      parseHubspotWorkflowWritebackPayload({
        inputFields: {
          hs_object_id: '998877',
          whatsapp_outreach: 'read',
          updated_at: '2026-06-15T18:11:00Z',
        },
      }),
    ).toEqual({
      ok: true,
      contactId: '998877',
      status: 'read',
      occurredAt: '2026-06-15T18:11:00.000Z',
    })
  })

  it('rejects missing/invalid contact id and unsupported statuses', () => {
    expect(parseHubspotWorkflowWritebackPayload({ status: 'sent' })).toMatchObject({ ok: false })
    expect(
      parseHubspotWorkflowWritebackPayload({ hubspot_contact_id: '12345', status: 'ready' }),
    ).toMatchObject({ ok: false })
    expect(
      parseHubspotWorkflowWritebackPayload({ hubspot_contact_id: 'abc123', status: 'sent' }),
    ).toMatchObject({ ok: false })
  })

  it('keeps replied owned by the signed inbound conversation webhook', () => {
    expect(
      parseHubspotWorkflowWritebackPayload({ hubspot_contact_id: '12345', status: 'replied' }),
    ).toMatchObject({ ok: false })
  })
})

describe('HubSpot workflow write-back patch', () => {
  it('marks a null status as sent and fills sent_at when missing', () => {
    expect(
      buildHubspotWorkflowWritebackPatch(
        { whatsapp_send_status: null, whatsapp_sent_at: null },
        { status: 'sent', occurredAt: '2026-06-15T18:10:00.000Z' },
      ),
    ).toEqual({
      shouldUpdate: true,
      patch: {
        whatsapp_send_status: 'sent',
        whatsapp_sent_at: '2026-06-15T18:10:00.000Z',
      },
    })
  })

  it('preserves the original app trigger timestamp when status advances', () => {
    expect(
      buildHubspotWorkflowWritebackPatch(
        { whatsapp_send_status: null, whatsapp_sent_at: '2026-06-15T18:00:00Z' },
        { status: 'sent', occurredAt: '2026-06-15T18:10:00.000Z' },
      ),
    ).toEqual({
      shouldUpdate: true,
      patch: { whatsapp_send_status: 'sent' },
    })
  })

  it('does not downgrade delivered, read, or replied to sent', () => {
    for (const current of ['delivered', 'read', 'replied']) {
      expect(
        buildHubspotWorkflowWritebackPatch(
          { whatsapp_send_status: current, whatsapp_sent_at: '2026-06-15T18:00:00Z' },
          { status: 'sent', occurredAt: '2026-06-15T18:10:00.000Z' },
        ),
      ).toEqual({ shouldUpdate: false, patch: {} })
    }
  })

  it('allows delivered and read to advance without touching Olivia state', () => {
    expect(
      buildHubspotWorkflowWritebackPatch(
        { whatsapp_send_status: 'delivered', whatsapp_sent_at: '2026-06-15T18:00:00Z' },
        { status: 'read', occurredAt: '2026-06-15T18:10:00.000Z' },
      ),
    ).toEqual({
      shouldUpdate: true,
      patch: { whatsapp_send_status: 'read' },
    })
  })

  it('exposes DB-side no-downgrade guards for concurrent updates', () => {
    expect(advanceableWorkflowCurrentStatuses('sent')).toEqual([null, 'failed', 'invalid'])
    expect(advanceableWorkflowCurrentStatuses('delivered')).toEqual([null, 'failed', 'invalid', 'sent'])
    expect(advanceableWorkflowCurrentStatuses('read')).toEqual([null, 'failed', 'invalid', 'sent', 'delivered'])
  })
})
