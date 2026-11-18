import { createHash } from 'node:crypto'
import type { TeamNotificationReminderDays } from '@mukuroji/contracts'
import type { AuditTransactWriteItem } from '../../audit'
import { NotificationError } from '../domain/notification-error'
import type {
  TeamReminderSettingsMutation,
  TeamReminderSettingsRecord,
  TeamReminderSettingsStore,
} from './ports/reminder-settings-reader'

/** Input of {@link updateTeamReminderSettings}. */
export type UpdateTeamReminderSettingsInput = {
  /** Canonical Workspace ID of the authorized Team manager. */
  workspaceId: string
  /** Team ID. */
  teamId: string
  /** Revision the caller read. */
  expectedRevision: number
  /** Validated replacement overrides. */
  days: TeamNotificationReminderDays
  /** Client `Idempotency-Key`, when sent. */
  idempotencyKey?: string
  /** Save time. */
  now: Date
  /**
   * Builds the audit put written with the save.
   *
   * @param before - Settings the update replaces.
   * @returns The transactional audit put, or undefined when auditing is not configured.
   */
  createAuditPut(before: TeamReminderSettingsRecord): AuditTransactWriteItem | undefined
}

/**
 * Replaces a Team's reminder overrides for an already authorized Team manager.
 *
 * The save is conditional on the expected revision. A retry of a request that already committed
 * (same idempotency key and body) returns the saved settings instead of a revision conflict; the
 * same key with a different body is rejected.
 *
 * @param store - Team reminder settings store.
 * @param input - Validated update.
 * @returns The saved settings.
 * @throws NotificationError (409) for a stale revision or a reused idempotency key.
 */
export async function updateTeamReminderSettings(
  store: TeamReminderSettingsStore,
  input: UpdateTeamReminderSettingsInput,
): Promise<TeamReminderSettingsRecord> {
  const mutation = input.idempotencyKey
    ? { idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprintUpdate(input) }
    : undefined
  const before = await store.getTeamSettings(input.workspaceId, input.teamId)
  if (isReplay(before, mutation)) return before
  if (before.revision !== input.expectedRevision) {
    throw new NotificationError(
      409,
      'NotificationReminderSettingsConflict',
      'Team reminder settings changed before this update was saved.',
    )
  }
  try {
    return await store.saveTeamSettings({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      days: input.days,
      expectedRevision: input.expectedRevision,
      now: input.now,
      auditPut: input.createAuditPut(before),
      ...(mutation ? { mutation } : {}),
    })
  } catch (error) {
    // A concurrent retry of the same request may have committed first.
    if (!(error instanceof NotificationError) || error.status !== 409 || !mutation) throw error
    const current = await store.getTeamSettings(input.workspaceId, input.teamId)
    if (!isReplay(current, mutation)) throw error
    return current
  }
}

/**
 * Hashes the expected revision and overrides so a reused key with a new body is detected.
 *
 * @param input - Validated update.
 * @returns Hex SHA-256 fingerprint.
 */
function fingerprintUpdate(input: Pick<UpdateTeamReminderSettingsInput, 'expectedRevision' | 'days'>) {
  const days = Object.entries(input.days).sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256')
    .update(JSON.stringify({ expectedRevision: input.expectedRevision, days }))
    .digest('hex')
}

/**
 * Reports whether the stored revision was written by this same request.
 *
 * @param record - Stored settings.
 * @param mutation - Identity of the incoming request.
 * @returns Whether the request already succeeded.
 * @throws NotificationError (409) when the key was used for a different body.
 */
function isReplay(record: TeamReminderSettingsRecord, mutation: TeamReminderSettingsMutation | undefined) {
  if (!mutation || record.lastMutation?.idempotencyKey !== mutation.idempotencyKey) return false
  if (record.lastMutation.requestFingerprint !== mutation.requestFingerprint) {
    throw new NotificationError(
      409,
      'IdempotencyKeyReused',
      'The idempotency key was already used for a different Team reminder update.',
    )
  }
  return true
}
