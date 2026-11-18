import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type {
  NotificationReminderDays,
  TeamNotificationReminderDays,
  TeamNotificationReminderSettings,
} from '@mukuroji/contracts'
import type { AuditTransactWriteItem } from '../../../audit'
import { NotificationError } from '../../domain/notification-error'
import { normalizeTeamReminderDays } from '../../domain/reminder-days'
import type {
  TeamReminderSettingsMutation,
  TeamReminderSettingsRecord,
  TeamReminderSettingsStore,
} from '../../application/ports/reminder-settings-reader'

/** Path of the Team reminder settings resource. */
export const TEAM_NOTIFICATION_REMINDERS_PATH = '/api/teams/:teamId/notification-reminders'

/** Minimum authenticated principal the Team reminder routes need. */
export type TeamReminderSettingsPrincipal = {
  /** Canonical Workspace ID. */
  directoryId: string
}

/** Ports injected into the Team reminder routes. */
export type TeamReminderSettingsRouterDependencies<
  Principal extends TeamReminderSettingsPrincipal,
> = {
  /** Resolves the bearer token to the current Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /**
   * Requires the principal to read the Team, or to manage it and write Workspace business data.
   *
   * @throws an authorization error the error mapper understands.
   */
  requireTeamAccess(principal: Principal, teamId: string, access: 'read' | 'manage'): Promise<void>
  /** Reports whether the principal may manage the Team, without throwing. */
  canManageTeam(principal: Principal, teamId: string): Promise<boolean>
  /** Returns the store bound to this request. */
  getStore(): TeamReminderSettingsStore
  /** Returns the deployment default thresholds. */
  getDefaults(): NotificationReminderDays
  /**
   * Builds the audit put written with the save, or undefined when auditing is not configured.
   *
   * @param context - Request context.
   * @param principal - Team manager.
   * @param input - Team and the before and after overrides.
   * @returns The transactional audit put.
   */
  createAuditPut(
    context: Context,
    principal: Principal,
    input: {
      teamId: string
      before: TeamNotificationReminderDays
      after: TeamNotificationReminderDays
      beforeRevision: number
      body: unknown
    },
  ): AuditTransactWriteItem | undefined
  /** Maps an application or authorization error to a response. */
  mapError(context: Context, error: unknown): Response
  /** Reads the request JSON, returning undefined when it does not parse. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Current time. */
  now(): Date
}

/**
 * Creates the Team reminder settings routes.
 *
 * Any Team member with read access sees the settings; only a Team manager with Workspace write
 * access changes them. The body is validated only after the caller is authorized.
 *
 * @param dependencies - Authentication, authorization, store, and audit ports.
 * @returns Router with `GET` and `PUT` on {@link TEAM_NOTIFICATION_REMINDERS_PATH}.
 */
export function createTeamReminderSettingsRouter<
  Principal extends TeamReminderSettingsPrincipal,
>(dependencies: TeamReminderSettingsRouterDependencies<Principal>) {
  const router = new Hono()

  router.get(TEAM_NOTIFICATION_REMINDERS_PATH, async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const teamId = readTeamId(context.req.param('teamId'))
      await dependencies.requireTeamAccess(principal, teamId, 'read')
      const [settings, canManage] = await Promise.all([
        dependencies.getStore().getTeamSettings(principal.directoryId, teamId),
        dependencies.canManageTeam(principal, teamId),
      ])
      return context.json(toResponse(teamId, settings, dependencies.getDefaults(), canManage))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put(TEAM_NOTIFICATION_REMINDERS_PATH, async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await dependencies.authenticate(accessToken, context)
      const teamId = readTeamId(context.req.param('teamId'))
      await dependencies.requireTeamAccess(principal, teamId, 'manage')
      const body = await dependencies.readJson(context.req)
      const request = readUpdateRequest(body)
      const mutation = readMutationIdentity(context, request)
      const store = dependencies.getStore()
      const before = await store.getTeamSettings(principal.directoryId, teamId)
      if (isReplay(before, mutation)) {
        return context.json(toResponse(teamId, before, dependencies.getDefaults(), true))
      }
      if (before.revision !== request.expectedRevision) {
        throw new NotificationError(
          409,
          'NotificationReminderSettingsConflict',
          'Team reminder settings changed before this update was saved.',
        )
      }
      let saved: TeamReminderSettingsRecord
      try {
        saved = await store.saveTeamSettings({
          workspaceId: principal.directoryId,
          teamId,
          days: request.days,
          expectedRevision: request.expectedRevision,
          now: dependencies.now(),
          auditPut: dependencies.createAuditPut(context, principal, {
            teamId,
            before: before.days,
            after: request.days,
            beforeRevision: before.revision,
            body,
          }),
          ...(mutation ? { mutation } : {}),
        })
      } catch (error) {
        // A concurrent retry of the same request may have committed first.
        if (!(error instanceof NotificationError) || error.status !== 409 || !mutation) throw error
        const current = await store.getTeamSettings(principal.directoryId, teamId)
        if (!isReplay(current, mutation)) throw error
        saved = current
      }
      return context.json(toResponse(teamId, saved, dependencies.getDefaults(), true))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

/**
 * Builds the public settings response.
 *
 * @param teamId - Team ID.
 * @param settings - Saved record.
 * @param defaults - Deployment defaults.
 * @param canManage - Whether the caller may change the settings.
 * @returns Response body.
 */
function toResponse(
  teamId: string,
  settings: TeamReminderSettingsRecord,
  defaults: NotificationReminderDays,
  canManage: boolean,
): TeamNotificationReminderSettings {
  return {
    teamId,
    days: settings.days,
    defaults,
    revision: settings.revision,
    ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {}),
    canManage,
  }
}

/**
 * Validates the `PUT` body.
 *
 * @param value - Untrusted request body.
 * @returns Expected revision and validated overrides.
 * @throws NotificationError (400) for an invalid body.
 */
function readUpdateRequest(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NotificationError(400, 'InvalidNotificationReminderDays', 'Request body must be an object.')
  }
  const expectedRevision: unknown = Reflect.get(value, 'expectedRevision')
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new NotificationError(
      400,
      'InvalidNotificationReminderDays',
      'Expected revision must be a non-negative integer.',
    )
  }
  return {
    expectedRevision,
    days: normalizeTeamReminderDays(Reflect.get(value, 'days')),
  }
}

/**
 * Reads the request's idempotency identity.
 *
 * @param context - Request context.
 * @param request - Validated update request.
 * @returns The key and request fingerprint, or undefined when the client sent no key.
 */
function readMutationIdentity(
  context: Context,
  request: { expectedRevision: number; days: TeamNotificationReminderDays },
): TeamReminderSettingsMutation | undefined {
  const idempotencyKey = context.req.header('Idempotency-Key')?.trim()
  if (!idempotencyKey) return undefined
  const days = Object.entries(request.days).sort(([left], [right]) => left.localeCompare(right))
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({ expectedRevision: request.expectedRevision, days }))
    .digest('hex')
  return { idempotencyKey, requestFingerprint }
}

/**
 * Reports whether the stored revision was written by this same request, so a retry after a
 * lost response gets the saved settings instead of a revision conflict.
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

/**
 * Validates the Team ID path parameter.
 *
 * @param value - Decoded path parameter.
 * @returns Trimmed Team ID.
 * @throws NotificationError (400) when it is blank.
 */
function readTeamId(value: string | undefined) {
  const teamId = value?.trim()
  if (!teamId) throw new NotificationError(400, 'InvalidTeamId', 'Team ID is required.')
  return teamId
}

/**
 * Reads the bearer token from the `Authorization` header.
 *
 * @param context - Request context.
 * @returns The token, or undefined when the header is missing.
 */
function readBearerAccessToken(context: Context) {
  const authorization = context.req.header('Authorization') ?? ''
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]
}
