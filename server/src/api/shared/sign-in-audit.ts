import { createHash, randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  getConfiguredAuditRetentionDays,
  type MutationAuditContext,
} from '../../modules/audit'
import { resolveTrustedRequestSource } from '../../infrastructure/http/trusted-request-source'
import { workspaceDependencies } from './app-dependencies'
import { createRequestMutationContext } from './http'
import { getEnv } from './runtime-config'

/** Length of the window in which repeated failures for one address and client count once. */
const SIGN_IN_FAILURE_WINDOW_MS = 10 * 60 * 1_000

/** Failure keys remembered by one server instance, so a repeated failure costs no write. */
const SIGN_IN_FAILURE_MEMORY_LIMIT = 1_000

/** Failure keys already recorded in the current or previous window by this server instance. */
const recordedFailureKeys = new Set<string>()

/** Why a sign-in attempt failed, as recorded in the audit log. */
export type SignInFailureReason = 'invalid-credentials' | 'invalid-mfa-code'

/**
 * Records a completed sign-in in the Workspace audit log.
 *
 * The event is written after the session is issued and never blocks the sign-in; a failed write
 * is logged. Token refreshes are not sign-ins and are not recorded.
 *
 * @param c - Hono request context.
 * @param principal - Signed-in principal.
 * @param principal.directoryId - Workspace the session belongs to.
 * @param principal.actorId - Cognito subject of the member.
 * @param principal.userKey - Member key, recorded as the actor display name.
 * @param authenticationMethods - Authentication methods verified for the session, such as `pwd` or `mfa`.
 * @returns A promise that settles after the event is written or the failure is logged.
 */
export async function recordSignInSucceeded(
  c: Context,
  principal: { directoryId: string; actorId: string; userKey: string },
  authenticationMethods: readonly string[],
): Promise<void> {
  try {
    const context = createRequestMutationContext(
      c,
      principal.directoryId,
      principal.actorId,
      principal.userKey,
      { authenticationMethods },
      `sign-in:${randomUUID()}`,
    )
    await writeSignInEvent(context, 'auth.signed-in', principal.actorId, {
      authenticationMethods: [...authenticationMethods],
    })
  } catch (error) {
    console.error('Failed to record the sign-in audit event:', error)
  }
}

/**
 * Records a rejected sign-in attempt in the configured Workspace's audit log.
 *
 * The address is unauthenticated, so the event names it only by a digest and its domain, and the
 * actor is the sign-in service. Repeated failures for one address from one client count once per
 * ten-minute window: the event ID is deterministic for that window and this server instance skips
 * keys it already wrote, so a password-guessing burst costs at most one audit write per window.
 * Without `MUKUROJI_WORKSPACE_DIRECTORY_ID` the Workspace of an unknown address cannot be known,
 * and nothing is recorded.
 *
 * @param c - Hono request context.
 * @param email - Address the attempt used.
 * @param reason - Why the attempt failed.
 * @param now - Current time in milliseconds, for tests.
 * @returns A promise that settles after the event is written, skipped, or its failure is logged.
 */
export async function recordSignInFailed(
  c: Context,
  email: string,
  reason: SignInFailureReason,
  now = Date.now(),
): Promise<void> {
  const workspaceId = getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID')?.trim()
  if (!workspaceId) return
  const normalizedEmail = email.trim().toLowerCase()
  const subject = createHash('sha256').update(`sign-in-subject\0${workspaceId}\0${normalizedEmail}`).digest('hex').slice(0, 32)
  const window = Math.floor(now / SIGN_IN_FAILURE_WINDOW_MS)
  const client = createHash('sha256').update(resolveTrustedRequestSource(c)).digest('hex').slice(0, 16)
  const key = `sign-in-failed:${reason}:${subject}:${client}:${window}`
  if (recordedFailureKeys.has(key)) return
  try {
    const domain = normalizedEmail.includes('@') ? normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1) : undefined
    const context = createRequestMutationContext(
      c,
      workspaceId,
      'system:sign-in',
      'Sign-in',
      { reason, subject, window },
      key,
      'system',
    )
    await writeSignInEvent(context, 'auth.sign-in-failed', `email:${subject}`, {
      reason,
      ...(domain ? { emailDomain: domain } : {}),
    })
    rememberFailureKey(key)
  } catch (error) {
    console.error('Failed to record the failed sign-in audit event:', error)
  }
}

/**
 * Appends one sign-in audit event.
 *
 * @param context - Audit context of the request.
 * @param eventType - `auth.signed-in` or `auth.sign-in-failed`.
 * @param entityId - Member subject or address digest the event is about.
 * @param metadata - Event metadata.
 * @returns A promise that settles after the write.
 */
async function writeSignInEvent(
  context: MutationAuditContext,
  eventType: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const putEvent = workspaceDependencies.auditEvents.putEvent
  if (!putEvent) return
  await putEvent.call(workspaceDependencies.auditEvents, createAuditEvent({
    context,
    eventType,
    entity: { type: 'sign-in', id: entityId },
    action: eventType === 'auth.signed-in' ? 'signed-in' : 'sign-in-failed',
    metadata,
    expiresAt: calculateAuditExpiresAt(context.occurredAt, getConfiguredAuditRetentionDays()),
  }))
}

/**
 * Remembers a recorded failure key, dropping the oldest once the memory limit is reached.
 *
 * @param key - Recorded failure key.
 */
function rememberFailureKey(key: string): void {
  if (recordedFailureKeys.size >= SIGN_IN_FAILURE_MEMORY_LIMIT) {
    const oldest = recordedFailureKeys.values().next().value
    if (oldest !== undefined) recordedFailureKeys.delete(oldest)
  }
  recordedFailureKeys.add(key)
}
