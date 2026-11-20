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
  TeamReminderSettingsRecord,
  TeamReminderSettingsStore,
} from '../../application/ports/reminder-settings-reader'
import { updateTeamReminderSettings } from '../../application/team-reminder-settings'

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
  /**
   * Builds read-only checks on the caller's authorization rows, committed with the save.
   *
   * @param principal - Team manager the route authorized.
   * @returns Transaction condition checks; empty when the deployment has none to fence.
   */
  createAuthorizationConditionChecks(principal: Principal): readonly AuditTransactWriteItem[]
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
      const idempotencyKey = context.req.header('Idempotency-Key')?.trim()
      const saved = await updateTeamReminderSettings(dependencies.getStore(), {
        workspaceId: principal.directoryId,
        teamId,
        expectedRevision: request.expectedRevision,
        days: request.days,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        now: dependencies.now(),
        authorizationConditionChecks: dependencies.createAuthorizationConditionChecks(principal),
        createAuditPut: (before) => dependencies.createAuditPut(context, principal, {
          teamId,
          before: before.days,
          after: request.days,
          beforeRevision: before.revision,
          body,
        }),
      })
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
