import type { AuditTransactWriteItem } from '../../../audit'
import type {
  PersonalNotificationReminderDays,
  TeamNotificationReminderDays,
} from '@mukuroji/contracts'

/** Reads the saved reminder day overrides the notification schedule applies. */
export type ScheduledReminderSettingsReader = {
  /**
   * Reads a Team's overrides.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param teamId - Team ID.
   * @returns The saved overrides, or undefined when the Team saved none.
   */
  readTeamReminderDays(
    workspaceId: string,
    teamId: string,
  ): Promise<TeamNotificationReminderDays | undefined>
  /**
   * Reads a member's own overrides from their notification preferences.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param memberKey - Lower-case Workspace member key.
   * @returns The saved overrides, or undefined when the member saved none.
   */
  readPersonalReminderDays(
    workspaceId: string,
    memberKey: string,
  ): Promise<PersonalNotificationReminderDays | undefined>
}

/** Saved Team reminder overrides. */
export type TeamReminderSettingsRecord = {
  /** Thresholds the Team overrides. */
  days: TeamNotificationReminderDays
  /** Optimistic concurrency revision; 0 when nothing is saved. */
  revision: number
  /** When the overrides were last saved. */
  updatedAt?: string
  /** Request that wrote this revision, so a retry after a lost response can be replayed. */
  lastMutation?: TeamReminderSettingsMutation
}

/** Identity of one settings update request. */
export type TeamReminderSettingsMutation = {
  /** `Idempotency-Key` the client sent. */
  idempotencyKey: string
  /** Hash of the expected revision and overrides, so a reused key with a new body is detected. */
  requestFingerprint: string
}

/** Input for replacing a Team's overrides. */
export type SaveTeamReminderSettingsInput = {
  /** Canonical Workspace ID. */
  workspaceId: string
  /** Team ID. */
  teamId: string
  /** Validated replacement overrides. */
  days: TeamNotificationReminderDays
  /** Revision the caller read. */
  expectedRevision: number
  /** Save time. */
  now: Date
  /** Audit event put written in the same transaction, when auditing is configured. */
  auditPut?: AuditTransactWriteItem
  /** Request identity stored with the revision, when the client sent an idempotency key. */
  mutation?: TeamReminderSettingsMutation
}

/** Store of Team reminder overrides used by the settings API. */
export type TeamReminderSettingsStore = {
  /**
   * Reads a Team's saved overrides.
   *
   * @param workspaceId - Canonical Workspace ID.
   * @param teamId - Team ID.
   * @returns The saved overrides, or an empty revision-0 record when none are saved.
   */
  getTeamSettings(workspaceId: string, teamId: string): Promise<TeamReminderSettingsRecord>
  /**
   * Replaces a Team's overrides when the stored revision still matches.
   *
   * @param input - Workspace, Team, overrides, expected revision, time, and audit put.
   * @returns The saved record.
   */
  saveTeamSettings(input: SaveTeamReminderSettingsInput): Promise<TeamReminderSettingsRecord>
}
