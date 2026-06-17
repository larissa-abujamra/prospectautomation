export type OliviaMessagingProvider = 'hubspot' | 'meta'

function normalizeProvider(value: string | null | undefined): OliviaMessagingProvider | null {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'meta' || normalized === 'whatsapp' || normalized === 'cloud_api') return 'meta'
  if (normalized === 'hubspot') return 'hubspot'
  return null
}

/**
 * Runtime switch for Olivia's WhatsApp transport.
 *
 * `OLIVIA_MESSAGING_PROVIDER=meta` is the new Meta-native path. `OLIVIA_CHANNEL`
 * is accepted as a short alias for operations. Default remains HubSpot so the
 * current production setup has an explicit rollback path.
 */
export function resolveOliviaMessagingProvider(
  provider: string | null | undefined,
  channel: string | null | undefined,
): OliviaMessagingProvider {
  return normalizeProvider(provider) ?? normalizeProvider(channel) ?? 'hubspot'
}
