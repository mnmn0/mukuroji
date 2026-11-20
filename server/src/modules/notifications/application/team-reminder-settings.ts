import { createHash } from 'node:crypto'
import type { TeamNotificationReminderDays } from '@mukuroji/contracts'
import type { AuditTransactWriteItem } from '../../audit'
import { NotificationError } from '../domain/notification-error'
import type {
  TeamReminderSettingsMutation,
  TeamReminderSettingsRecord,
  TeamReminderSettingsStore,
} from './ports/reminder-settings-reader'

/** Error code of a save that lost to another revision. */
const revisionConflictCode = 'NotificationReminderSettingsConflict'

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
  /** Checks on the caller's authorization rows, committed with the save. */
  authorizationConditionChecks?: readonly AuditTransactWriteItem[]
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
 * The save is conditional on the expected revision and on the caller's authorization rows. Every
 * update sent with an idempotency key leaves a durable receipt, so a retry of a committed request
 * (same key and body) returns the saved settings even after later updates, and the same key with a
 * different body is rejected.
 *
 * @param store - Team reminder settings store.
 * @param input - Validated update.
 * @returns The saved settings.
 * @throws NotificationError (409) for a stale revision, a reused idempotency key, or a caller
 * authorization change after the route checked it.
 */
export async function updateTeamReminderSettings(
  store: TeamReminderSettingsStore,
  input: UpdateTeamReminderSettingsInput,
): Promise<TeamReminderSettingsRecord> {
  const mutation = input.idempotencyKey
    ? { idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprintUpdate(input) }
    : undefined
  if (mutation) {
    const replayed = await readReplay(store, input, mutation)
    if (replayed) return replayed
  }
  const before = await store.getTeamSettings(input.workspaceId, input.teamId)
  if (before.revision !== input.expectedRevision) {
    throw new NotificationError(
      409,
      revisionConflictCode,
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
      ...(input.authorizationConditionChecks
        ? { authorizationConditionChecks: input.authorizationConditionChecks }
        : {}),
      ...(mutation ? { mutation } : {}),
    })
  } catch (error) {
    // A concurrent retry of the same request may have committed first.
    if (!(error instanceof NotificationError) || error.code !== revisionConflictCode || !mutation) {
      throw error
    }
    const replayed = await readReplay(store, input, mutation)
    if (!replayed) throw error
    return replayed
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
 * Returns what a committed request with the same idempotency key saved.
 *
 * @param store - Team reminder settings store.
 * @param input - Workspace and Team of the update.
 * @param mutation - Identity of the incoming request.
 * @returns The settings the earlier request saved, or undefined when the key is unused.
 * @throws NotificationError (409) when the key was used for a different body.
 */
async function readReplay(
  store: TeamReminderSettingsStore,
  input: Pick<UpdateTeamReminderSettingsInput, 'workspaceId' | 'teamId'>,
  mutation: TeamReminderSettingsMutation,
) {
  const receipt = await store.getMutationReceipt(input.workspaceId, input.teamId, mutation.idempotencyKey)
  if (!receipt) return undefined
  if (receipt.requestFingerprint !== mutation.requestFingerprint) {
    throw new NotificationError(
      409,
      'IdempotencyKeyReused',
      'The idempotency key was already used for a different Team reminder update.',
    )
  }
  return receipt.record
}
