import { randomUUID } from 'node:crypto'
import type { NotificationChannelDestination, PersonalSlackDestination } from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import { createMutationAuditEventPut, getConfiguredAuditTableName, type AuditTransactWriteItem } from '../../modules/audit/audit'
import { ProjectDataError } from '../../modules/directory'
import {
  NotificationError,
  deleteChannelDestination,
  deletePersonalSlackDestination,
  readChannelDestinationSaveBody,
  readExpectedRevision,
  readPersonalSlackWebhookUrl,
  saveChannelDestination,
  savePersonalSlackDestination,
  slackChannelDestinationSecretId,
  slackNotificationSecretId,
  testNotificationDestination,
  toPublicChannelDestination,
  type ChannelDestinationTarget,
} from '../../modules/notifications'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import { toNotificationErrorResponse } from '../shared/notification-access'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canAccessAssignedProject,
  canWorkspaceBusinessWrite,
  createApiMutationContext,
  hasEnterprisePermissionAtResource,
  requireProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

/** Path of the caller's own Slack destination. */
const PERSONAL_PATH = '/api/notification-preferences/slack-destination'
/** Path of a Team's channel destination. */
const TEAM_PATH = '/api/teams/:teamId/notification-channel'
/** Path of a Project's channel destination. */
const PROJECT_PATH = '/api/teams/:teamId/projects/:projectId/notification-channel'

/**
 * Registers the routes that register, test, and delete Slack destinations: the caller's own, a
 * Team's channel, and a Project's channel. Webhook URLs go to Secrets Manager and never come back
 * in a response, a log, or an audit event.
 *
 * A Team channel is read by the Team's viewers and changed by its managers. A Project channel is
 * read by the Project's viewers and changed by its managers or the Team's managers. Every change
 * needs Workspace write access.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerNotificationDestinationRoutes(routeApp: Hono): void {
  routeApp.get(PERSONAL_PATH, async (c) => await withPersonal(c, async (principal) => {
    const configured = await workItemDependencies.notificationDestinationSecrets.exists(personalSecretId(principal))
    return c.json({ configured } satisfies PersonalSlackDestination)
  }))

  routeApp.put(PERSONAL_PATH, async (c) => await withPersonal(c, async (principal) => {
    const webhookUrl = readPersonalSlackWebhookUrl(await readJson<unknown>(c.req))
    const auditPut = createPersonalAuditPut(c, principal, 'saved')
    await savePersonalSlackDestination(
      workItemDependencies.notificationDestinationSecrets,
      workItemDependencies.channelDestinations,
      { secretId: personalSecretId(principal), webhookUrl, ...(auditPut ? { auditPut } : {}) },
    )
    return c.json({ configured: true } satisfies PersonalSlackDestination)
  }))

  routeApp.delete(PERSONAL_PATH, async (c) => await withPersonal(c, async (principal) => {
    const auditPut = createPersonalAuditPut(c, principal, 'deleted')
    await deletePersonalSlackDestination(
      workItemDependencies.notificationDestinationSecrets,
      workItemDependencies.channelDestinations,
      { secretId: personalSecretId(principal), ...(auditPut ? { auditPut } : {}) },
    )
    return c.json({ configured: false } satisfies PersonalSlackDestination)
  }))

  routeApp.post(`${PERSONAL_PATH}/test`, async (c) => await withPersonal(c, async (principal) => {
    const body = await readJson<unknown>(c.req)
    const locale = typeof body === 'object' && body !== null && Reflect.get(body, 'locale') === 'en' ? 'en' : 'ja'
    return c.json(await testNotificationDestination(
      workItemDependencies.notificationDestinationSecrets, personalSecretId(principal), locale, workItemDependencies.notificationDestinationTestSender,
    ))
  }))

  for (const path of [TEAM_PATH, PROJECT_PATH]) {
    routeApp.get(path, async (c) => await withTarget(c, 'read', async (principal, target, canManage) => {
      const { record, revision } = await workItemDependencies.channelDestinations.getState(principal.directoryId, target)
      return c.json(toPublicChannelDestination(target, record, canManage, revision) satisfies NotificationChannelDestination)
    }))

    routeApp.put(path, async (c) => await withTarget(c, 'manage', async (principal, target) => {
      const body = readChannelDestinationSaveBody(await readJson<unknown>(c.req))
      const before = await workItemDependencies.channelDestinations.get(principal.directoryId, target)
      const record = await saveChannelDestination(
        workItemDependencies.channelDestinations,
        workItemDependencies.notificationDestinationSecrets,
        {
          workspaceId: principal.directoryId,
          target,
          secretIdOf: (version) => slackChannelDestinationSecretId(principal.directoryId, target, version),
          newSecretVersion: randomUUID(),
          body,
          memberKey: principal.userKey,
          now: new Date(),
          authorizationConditionChecks: await createAuthorizationChecks(principal, target),
          auditPut: createChannelAuditPut(c, principal, target, 'saved', {
            webhookReplaced: Boolean(body.webhookUrl),
            locale: body.locale,
            labelChanged: (before?.label ?? '') !== (body.label ?? ''),
            beforeRevision: body.expectedRevision,
          }),
        },
      )
      return c.json(toPublicChannelDestination(target, record, true) satisfies NotificationChannelDestination)
    }))

    routeApp.delete(path, async (c) => await withTarget(c, 'manage', async (principal, target) => {
      const expectedRevision = readExpectedRevision(c.req.query('expectedRevision'))
      await deleteChannelDestination(
        workItemDependencies.channelDestinations,
        workItemDependencies.notificationDestinationSecrets,
        {
          workspaceId: principal.directoryId,
          target,
          secretIdOf: (version) => slackChannelDestinationSecretId(principal.directoryId, target, version),
          expectedRevision,
          now: new Date(),
          authorizationConditionChecks: await createAuthorizationChecks(principal, target),
          auditPut: createChannelAuditPut(c, principal, target, 'deleted', { beforeRevision: expectedRevision }),
        },
      )
      return c.json(toPublicChannelDestination(target, undefined, true, expectedRevision + 1) satisfies NotificationChannelDestination)
    }))

    routeApp.post(`${path}/test`, async (c) => await withTarget(c, 'manage', async (principal, target) => {
      const record = await workItemDependencies.channelDestinations.get(principal.directoryId, target)
      if (!record) return c.json({ delivered: false, code: 'DestinationNotConfigured' })
      return c.json(await testNotificationDestination(
        workItemDependencies.notificationDestinationSecrets,
        slackChannelDestinationSecretId(principal.directoryId, target, record.secretVersion),
        record.locale,
        workItemDependencies.notificationDestinationTestSender,
      ))
    }))
  }
}

/**
 * Authenticates the caller of a personal destination route and maps errors.
 * @param c - Request context.
 * @param run - Route body.
 * @returns The route response.
 */
async function withPersonal(c: Context, run: (principal: WorkspacePrincipal) => Promise<Response>): Promise<Response> {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
  try {
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    if (principal.principalKind === 'service-account') {
      throw new NotificationError(403, 'NotificationDestinationForbidden', 'Service accounts have no personal notification destination.')
    }
    return await run(principal)
  } catch (error) {
    return toNotificationErrorResponse(c, error)
  }
}

/**
 * Authenticates and authorizes the caller of a Team or Project destination route.
 * @param c - Request context.
 * @param access - `read` for the settings view, `manage` for a change or a test.
 * @param run - Route body, given the target and whether the caller may manage it.
 * @returns The route response.
 */
async function withTarget(
  c: Context,
  access: 'read' | 'manage',
  run: (principal: WorkspacePrincipal, target: ChannelDestinationTarget, canManage: boolean) => Promise<Response>,
): Promise<Response> {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
  try {
    const target = readTarget(c)
    const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
    if (access === 'manage') requireWorkspaceBusinessWrite(principal)
    else requireWorkspaceBusinessRead(principal)
    await requireTargetRead(principal, target)
    const canManage = await canManageTarget(principal, target)
    if (access === 'manage' && !canManage) {
      throw new NotificationError(403, 'NotificationDestinationForbidden', target.scope === 'team'
        ? 'Only a Team manager can change the Team channel.'
        : 'Only a Project or Team manager can change the Project channel.')
    }
    return await run(principal, target, canManage)
  } catch (error) {
    return toNotificationErrorResponse(c, error)
  }
}

/**
 * Reads the Team or Project of the route.
 * @param c - Request context.
 * @returns The target.
 * @throws NotificationError (400) when an ID is missing.
 */
function readTarget(c: Context): ChannelDestinationTarget {
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || (c.req.routePath.includes(':projectId') && !projectId)) {
    throw new NotificationError(400, 'InvalidNotificationDestination', 'Team ID and Project ID are required.')
  }
  return projectId ? { scope: 'project', teamId, projectId } : { scope: 'team', teamId }
}

/**
 * Requires the caller to see the Team, and for a Project, to see the Project in that Team. A
 * Project outside the Team and a hidden Project both answer 404.
 * @param principal - Authenticated principal.
 * @param target - Team or Project.
 */
async function requireTargetRead(principal: WorkspacePrincipal, target: ChannelDestinationTarget) {
  const context = await requireTeamPermission(principal, target.teamId, 'viewer')
  if (target.scope === 'team') return
  const inTeam = context.team.projects.some((project) => project.id === target.projectId)
  if (!inTeam || !canAccessAssignedProject(principal, context, target.projectId, 'viewer')) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${target.projectId}" was not found.`)
  }
}

/**
 * Reports whether the caller may change the destination: a Team manager for either kind, or a
 * Project manager for a Project, with Workspace write access.
 * @param principal - Authenticated principal.
 * @param target - Team or Project.
 * @returns True when the caller may change it.
 */
async function canManageTarget(principal: WorkspacePrincipal, target: ChannelDestinationTarget): Promise<boolean> {
  if (!canWorkspaceBusinessWrite(principal)) return false
  // An Enterprise GET is authorized with read access, so its derived role cannot show management.
  if (principal.enterprisePermissions !== undefined) {
    return target.scope === 'team'
      ? hasEnterprisePermissionAtResource(principal, 'teams.manage', {
          workspaceId: principal.directoryId, kind: 'team', targetId: target.teamId,
        })
      : hasEnterprisePermissionAtResource(principal, 'projects.manage', {
          workspaceId: principal.directoryId, kind: 'project', targetId: target.projectId, parentTeamId: target.teamId,
        })
  }
  if (await succeeds(() => requireTeamPermission(principal, target.teamId, 'manager'))) return true
  return target.scope === 'project' &&
    await succeeds(() => requireProjectPermission(principal, target.projectId, 'manager', target.teamId))
}

/**
 * Runs an authorization check without throwing.
 * @param check - Check that throws when access is denied.
 * @returns True when it passed.
 */
async function succeeds(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check()
    return true
  } catch {
    return false
  }
}

/**
 * Builds the commit-time fences of a change: the caller's membership and Enterprise revision,
 * and for a Project, that the Team and Project are still active.
 * @param principal - Authenticated manager.
 * @param target - Team or Project.
 * @returns Transaction condition checks.
 */
async function createAuthorizationChecks(
  principal: WorkspacePrincipal,
  target: ChannelDestinationTarget,
): Promise<AuditTransactWriteItem[]> {
  const checks: AuditTransactWriteItem[] = [
    ...createPlanningCallerAuthorizationConditionChecks(principal, [], principal.principalKind !== 'service-account'),
  ]
  const { projectDirectory } = workspaceDependencies
  if (target.scope === 'project' && projectDirectory.createActiveReferenceConditionChecks) {
    checks.push(...await projectDirectory.createActiveReferenceConditionChecks(principal.directoryId, target.teamId, target.projectId))
  }
  return checks
}

/**
 * Builds the audit event of a channel destination change. The webhook URL is left out of both the
 * event and its request digest.
 * @param c - Request context.
 * @param principal - Authenticated manager.
 * @param target - Team or Project.
 * @param action - `saved` or `deleted`.
 * @param metadata - Safe facts about the change.
 * @returns The transactional audit put, or undefined when auditing is not configured.
 */
function createChannelAuditPut(
  c: Context,
  principal: WorkspacePrincipal,
  target: ChannelDestinationTarget,
  action: 'saved' | 'deleted',
  metadata: Record<string, string | number | boolean>,
): AuditTransactWriteItem | undefined {
  const entityId = target.scope === 'team'
    ? `team/${target.teamId}/notification-channel`
    : `team/${target.teamId}/project/${target.projectId}/notification-channel`
  return createMutationAuditEventPut(
    getConfiguredAuditTableName(),
    createApiMutationContext(c, principal, { action, ...metadata }),
    {
      directoryId: principal.directoryId,
      eventType: `notification-channel.${action}`,
      entityType: 'notification-channel',
      entityId,
      action,
      summary: action === 'saved' ? 'Notification channel was saved.' : 'Notification channel was deleted.',
      changes: [],
      metadata: {
        adapter: 'notification-channel',
        scope: target.scope,
        teamId: target.teamId,
        ...(target.scope === 'project' ? { projectId: target.projectId } : {}),
        ...metadata,
      },
    },
  )
}

/**
 * Builds the audit event of a change to the caller's own Slack destination, without the URL.
 * @param c - Request context.
 * @param principal - Caller.
 * @param action - `saved` or `deleted`.
 * @returns The audit put, or undefined when auditing is not configured.
 */
function createPersonalAuditPut(
  c: Context,
  principal: WorkspacePrincipal,
  action: 'saved' | 'deleted',
): AuditTransactWriteItem | undefined {
  const auditTableName = getConfiguredAuditTableName()
  if (!auditTableName) return undefined
  return createMutationAuditEventPut(
    auditTableName,
    createApiMutationContext(c, principal, { action }),
    {
      directoryId: principal.directoryId,
      eventType: `notification-slack-destination.${action}`,
      entityType: 'notification-slack-destination',
      entityId: workItemDependencies.channelDestinations.personalAuditEntityId(principal.directoryId, principal.userKey),
      action,
      summary: action === 'saved' ? 'Personal Slack destination was saved.' : 'Personal Slack destination was deleted.',
      changes: [],
      metadata: { adapter: 'notification-slack-destination' },
    },
  )
}

/**
 * Names the caller's own Slack secret.
 * @param principal - Caller.
 * @returns Server-derived secret name.
 */
function personalSecretId(principal: WorkspacePrincipal): string {
  return slackNotificationSecretId(principal.directoryId, principal.userKey)
}
