import { createHash } from 'node:crypto'
import { AutomationError } from '../domain/automation-error'

/** Default Secrets Manager prefix reserved for inbound Automation webhooks. */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX =
  'mukuroji/automation-inbound-webhooks'

/**
 * Derives the canonical inbound-only Secrets Manager resource identifier.
 *
 * @param workspaceId - Workspace that owns the endpoint.
 * @param endpointId - Inbound webhook endpoint identifier.
 * @param prefix - Optional Secrets Manager prefix retained verbatim for compatibility.
 * @returns A deterministic Workspace-scoped secret resource identifier.
 */
export function createAutomationInboundWebhookSecretId(
  workspaceId: string,
  endpointId: string,
  prefix = readInboundWebhookSecretPrefix(),
) {
  const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
  const normalizedEndpointId = readIdentifier(endpointId, 'Inbound webhook endpoint ID')
  return `${prefix}/${hashText(normalizedWorkspaceId)}/${normalizedEndpointId}`
}

/** Reads and normalizes the configured inbound webhook secret prefix. */
function readInboundWebhookSecretPrefix() {
  return normalizeSecretPrefix(
    process.env.AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX ??
      AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX,
  )
}

/**
 * Normalizes a Secrets Manager path prefix.
 *
 * @param value - Candidate prefix.
 * @returns A non-empty prefix without surrounding slashes.
 */
function normalizeSecretPrefix(value: string) {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  return normalized || AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX
}

/**
 * Validates a component used in the canonical secret identifier.
 *
 * @param value - Candidate identifier.
 * @param label - Safe validation label.
 * @returns The normalized identifier.
 */
function readIdentifier(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._:@#+/-]+$/.test(normalized)) {
    throw new AutomationError(
      'invalid-input',
      'InvalidAutomationInput',
      `${label} is invalid.`,
    )
  }
  return normalized
}

/**
 * Hashes a normalized Workspace identifier for path isolation.
 *
 * @param value - Normalized identifier.
 * @returns A lowercase SHA-256 fingerprint.
 */
function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
