import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import {
  DEFAULT_WORKSPACE_CURRENCY,
  type MyTimesheetSubmitEntry,
  readTeamTimeEntryPolicy,
  readTimeEntryCategoryKey,
  type TimeEntryPolicyWarning,
  type TimeEntry,
  type TimeEntryCategory,
  type TimeEntryStatus,
  type TimeRateCardResponse,
  type TimeTrackingGroupBy,
  type TimeTrackingTeamSettingsResponse,
} from '@mukuroji/contracts'
import { submitMyTimesheet } from '../../application/use-cases/submit-my-timesheet'
import {
  TimeTrackingError,
  type CreateTimeEntryInput,
  type TimeTrackingAuthorizationConditionCheck,
  type TimeTrackingReportInput,
  type TimeTrackingService,
} from '../../time-tracking'

/** Minimum authenticated identity used by the time tracking HTTP adapter. */
export type TimeTrackingPrincipal = {
  /** Canonical Workspace identifier. */
  directoryId: string
  /** Canonical Workspace member key. */
  userKey: string
}

/** A Team covered by a Workspace-wide month close. */
export type WorkspacePeriodTeam = {
  /** Team identifier. */
  teamId: string
  /** Team name shown to the administrator. */
  name: string
}

/** Dependencies injected into the time tracking HTTP adapter. */
export type TimeTrackingRouterDependencies<Principal extends TimeTrackingPrincipal> = {
  /** Reads the bearer token from a request. */
  readBearerAccessToken(context: Context): string | undefined
  /** Resolves a bearer token to an authenticated Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Rejects principals, such as Workspace guests, that may not change business data. */
  requireWrite(principal: Principal): void | Promise<void>
  /** Returns whether the principal can read, write, or manage a Team. */
  requireTeamPermission(principal: Principal, teamId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Returns whether the principal may view confidential rates and costs. */
  canManageRates(principal: Principal, teamId: string): Promise<boolean>
  /**
   * Lists the Teams in which the principal holds at least the given role, for the personal
   * timesheet across Teams. Teams without that access are left out.
   */
  listTimeTrackingTeams(principal: Principal, minimum: 'viewer' | 'member'): Promise<Array<{ teamId: string; name: string }>>
  /** Returns the Project allowlist visible inside the selected Team. */
  getAccessibleProjectIds(principal: Principal, teamId: string): Promise<ReadonlySet<string> | undefined>
  /**
   * Returns whether the principal manages every Project of a Team: a system administrator or a
   * direct Team grant with manage permission, not a manager of only some Projects.
   */
  canManageWholeTeam(principal: Principal, teamId: string): Promise<boolean>
  /**
   * Returns whether the principal may close and reopen months for every Team of the Workspace:
   * a system administrator, an Enterprise assignment with `workspace.manage`, or otherwise a
   * Workspace owner or administrator.
   */
  canManageWorkspacePeriods(principal: Principal): Promise<boolean>
  /** Lists every Team of the principal's Workspace that a Workspace-wide month close covers. */
  listWorkspaceTeams(principal: Principal): Promise<readonly WorkspacePeriodTeam[]>
  /** Returns the Project IDs for which the principal may view confidential costs. */
  getManagedProjectIds(principal: Principal, teamId: string): Promise<ReadonlySet<string> | undefined>
  /**
   * Reads the Workspace currency used when a request names none; absent means
   * `DEFAULT_WORKSPACE_CURRENCY`.
   */
  readDefaultCurrency?(principal: Principal): Promise<string>
  /** Verifies Project-level access for a Team operation. */
  verifyProject(principal: Principal, teamId: string, projectId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Verifies that a referenced Work Item belongs to the selected Team. */
  verifyWorkItem(principal: Principal, teamId: string, workItemId: string, minimum?: 'viewer' | 'member' | 'manager'): Promise<string | undefined>
  /**
   * Builds read-only checks on the caller's authorization rows, committed with a delete so a
   * member whose access was removed after the route's check cannot delete.
   *
   * @param principal - Entry owner the route authorized.
   * @returns Transaction condition checks; empty when the deployment has none to fence.
   */
  createAuthorizationConditionChecks(principal: Principal): readonly TimeTrackingAuthorizationConditionCheck[]
  /** Returns the application service bound to the current app. */
  getTimeTracking(): TimeTrackingService
  /** Safely parses a JSON request body. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Maps authentication, authorization, validation, and persistence failures to HTTP. */
  mapError(context: Context, error: unknown): Response
}

/** Creates authenticated time entry, timer, timesheet, budget, and report routes. */
export function createTimeTrackingRouter<Principal extends TimeTrackingPrincipal>(
  dependencies: TimeTrackingRouterDependencies<Principal>,
): Hono {
  const router = new Hono()

  router.post('/api/teams/:teamId/time-entries', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId, canManage) => {
      const body = asRecord(await dependencies.readJson(context.req))
      // Indirect work, such as a meeting, has no Work Item; its Project, when given, is checked directly.
      const workItemId = body.workItemId === undefined ? undefined : readRequiredString(body.workItemId, 'Work Item ID')
      const requestedProjectId = readOptionalString(body.projectId)
      const projectId = workItemId === undefined
        ? requestedProjectId
        : await dependencies.verifyWorkItem(principal, teamId, workItemId, 'member')
      if (workItemId !== undefined && requestedProjectId !== undefined && requestedProjectId !== projectId) {
        throw new TimeTrackingError(400, 'WorkItemProjectMismatch', 'The Project must match the Work Item assignment.')
      }
      if (projectId) {
        await dependencies.verifyProject(
          principal,
          teamId,
          projectId,
          body.hourlyRateMinor === undefined ? 'member' : 'manager',
        )
      }
      const { entry, warnings } = await dependencies.getTimeTracking().createEntryWithWarnings({
        workspaceId: principal.directoryId,
        teamId,
        ...(workItemId ? { workItemId } : {}),
        userId: principal.userKey,
        ...(projectId ? { projectId } : {}),
        ...readCreateInterval(body),
        ...(body.category === undefined ? {} : { category: readCategory(body.category) }),
        ...(readOptionalString(body.description) ? { description: readOptionalString(body.description) } : {}),
        billable: readRequiredBoolean(body.billable, 'Billable'),
        ...await readRequestCurrency(dependencies, principal, body.currency),
        ...(body.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: readRequiredNumber(body.hourlyRateMinor, 'Hourly rate') }),
        source: 'manual',
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      }, canManage)
      const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      return context.json({ entry: redactEntry(entry, canManage, managedProjectIds), ...withWarnings(warnings) }, 201)
    })
  })

  router.get('/api/teams/:teamId/time-entries', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const requestedUserId = context.req.query('userId')?.trim() || undefined
      const accessibleProjectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      const scope = resolveEntryListScope(
        principal.userKey,
        requestedUserId,
        canManage,
        accessibleProjectIds,
        managedProjectIds,
      )
      const projectIds = scope.projectIds
      const entries = await dependencies.getTimeTracking().listEntries({
        workspaceId: principal.directoryId,
        teamId,
        userId: scope.userId,
        ...(context.req.query('from') ? { from: context.req.query('from') } : {}),
        ...(context.req.query('to') ? { to: context.req.query('to') } : {}),
        ...(context.req.query('status') ? { status: readStatus(context.req.query('status')) } : {}),
        ...(context.req.query('limit') === undefined ? {} : { limit: readEntryLimit(context.req.query('limit')) }),
        ...(projectIds ? { projectIds, includeUnassigned: true } : {}),
      })
      return context.json({ entries: entries.map((entry) => redactEntry(entry, canManage, managedProjectIds)) })
    })
  })

  router.patch('/api/teams/:teamId/time-entries/:entryId', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId, canManage) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const current = await dependencies.getTimeTracking().getEntry(
        principal.directoryId,
        teamId,
        readRequiredString(context.req.param('entryId'), 'Time entry ID'),
      )
      const currentProjectId = current.workItemId === undefined
        ? current.projectId
        : await dependencies.verifyWorkItem(principal, teamId, current.workItemId, 'member')
      if (current.workItemId === undefined && current.projectId) {
        await dependencies.verifyProject(principal, teamId, current.projectId, 'member')
      }
      const nextWorkItemId = body.workItemId === undefined
        ? current.workItemId
        : body.workItemId === null
          ? undefined
          : readRequiredString(body.workItemId, 'Work Item ID')
      const requestedProjectId = body.projectId === undefined || body.projectId === null
        ? body.projectId
        : readRequiredString(body.projectId, 'Project ID')
      // A Work Item entry takes the Work Item's Project; indirect work keeps or names its own.
      const nextProjectId = nextWorkItemId === undefined
        ? requestedProjectId === undefined ? current.projectId : requestedProjectId ?? undefined
        : body.workItemId === undefined
          ? currentProjectId
          : await dependencies.verifyWorkItem(principal, teamId, nextWorkItemId, 'member')
      if (nextWorkItemId !== undefined && typeof requestedProjectId === 'string' && requestedProjectId !== nextProjectId) {
        throw new TimeTrackingError(400, 'WorkItemProjectMismatch', 'The Project must match the Work Item assignment.')
      }
      if (nextProjectId) {
        await dependencies.verifyProject(
          principal,
          teamId,
          nextProjectId,
          body.hourlyRateMinor === undefined ? 'member' : 'manager',
        )
      }
      const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      const canManageEntry = canManage &&
        canManageProject(managedProjectIds, current.projectId) &&
        canManageProject(managedProjectIds, nextProjectId)
      const { entry, warnings } = await dependencies.getTimeTracking().updateEntryWithWarnings({
        workspaceId: principal.directoryId,
        teamId,
        entryId: readRequiredString(context.req.param('entryId'), 'Time entry ID'),
        actorUserId: principal.userKey,
        canManageRates: canManageEntry,
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
        authorizedRevision: current.revision,
        ...readUpdateInterval(body),
        ...(body.workItemId === undefined ? {} : { workItemId: nextWorkItemId ?? null }),
        projectId: nextProjectId ?? null,
        ...(body.category === null ? { category: null } : body.category === undefined ? {} : { category: readCategory(body.category) }),
        ...(body.description === null ? { description: null } : body.description === undefined ? {} : { description: readRequiredString(body.description, 'Description') }),
        ...(body.billable === undefined ? {} : { billable: readRequiredBoolean(body.billable, 'Billable') }),
        ...(body.currency === undefined ? {} : { currency: readRequiredString(body.currency, 'Currency') }),
        ...(body.hourlyRateMinor === null ? { hourlyRateMinor: null } : body.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: readRequiredNumber(body.hourlyRateMinor, 'Hourly rate') }),
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      // Warnings compare the entry with all of its owner's time in the Team, which a manager of only
      // some Projects may not see, so only the owner editing their own time receives them.
      return context.json({
        entry: redactEntry(entry, canManage, managedProjectIds),
        ...(current.userId === principal.userKey ? withWarnings(warnings) : {}),
      })
    })
  })

  router.delete('/api/teams/:teamId/time-entries/:entryId', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId) => {
      const entryId = readRequiredString(context.req.param('entryId'), 'Time entry ID')
      const expectedRevision = readExpectedRevisionQuery(context.req.query('expectedRevision'))
      const idempotencyKey = readOptionalIdempotencyKey(context)
      const current = await readEntryUnlessReplayable(dependencies.getTimeTracking(), principal.directoryId, teamId, entryId, idempotencyKey)
      if (current) {
        // Only the owner may delete, and still needs write access to the Project the time is stored on.
        // The Work Item is not checked, so a draft on a Work Item that was removed can still be deleted.
        if (current.userId !== principal.userKey) {
          throw new TimeTrackingError(403, 'TimeEntryAccessDenied', 'Only the entry owner may delete this entry.')
        }
        if (current.projectId) await dependencies.verifyProject(principal, teamId, current.projectId, 'member')
      }
      await dependencies.getTimeTracking().deleteEntry({
        workspaceId: principal.directoryId,
        teamId,
        entryId,
        actorUserId: principal.userKey,
        expectedRevision,
        ...(current ? { authorizedRevision: current.revision } : {}),
        authorizationConditionChecks: dependencies.createAuthorizationConditionChecks(principal),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      })
      return context.body(null, 204)
    })
  })

  for (const action of ['submit', 'approve', 'reject', 'lock', 'return'] as const) {
    router.post(`/api/teams/:teamId/time-entries/:entryId/${action}`, async (context) => {
      const minimum = action === 'submit' ? 'member' : 'manager'
      return await withTeam(context, dependencies, minimum, async (principal, teamId, canManage) => {
        const body = asRecord(await dependencies.readJson(context.req))
        const current = await dependencies.getTimeTracking().getEntry(
          principal.directoryId,
          teamId,
          readRequiredString(context.req.param('entryId'), 'Time entry ID'),
        )
        if (current.workItemId) await dependencies.verifyWorkItem(principal, teamId, current.workItemId, minimum)
        if (current.projectId) await dependencies.verifyProject(principal, teamId, current.projectId, minimum)
        const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
        const entry = await dependencies.getTimeTracking().transitionEntry({
          workspaceId: principal.directoryId,
          teamId,
          entryId: readRequiredString(context.req.param('entryId'), 'Time entry ID'),
          actorUserId: principal.userKey,
          canApprove: canManage && canManageProject(managedProjectIds, current.projectId),
          expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
          authorizedRevision: current.revision,
          action,
          ...(body.reason === undefined ? {} : { reason: readRequiredString(body.reason, 'Reason') }),
          ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
        })
        return context.json({ entry: redactEntry(entry, canManage, managedProjectIds) })
      })
    })
  }

  for (const action of ['submit', 'approve', 'reject', 'lock'] as const) {
    router.post(`/api/teams/:teamId/timesheet/${action}`, async (context) => {
      const minimum = action === 'submit' ? 'member' : 'manager'
      return await withTeam(context, dependencies, minimum, async (principal, teamId, canManage) => {
        const body = asRecord(await dependencies.readJson(context.req))
        const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
        const { updated, failedEntryIds } = await runTimesheetAction(dependencies, principal, teamId, canManage, {
          action,
          from: readRequiredString(body.from, 'Period start'),
          to: readRequiredString(body.to, 'Period end'),
          ...(body.reason === undefined ? {} : { reason: readRequiredString(body.reason, 'Reason') }),
        })
        return context.json({
          count: updated.length,
          failedEntryIds,
          partialFailure: failedEntryIds.length > 0,
          entries: updated.map((entry) => redactEntry(entry, canManage, managedProjectIds)),
        })
      })
    })
  }

  router.get('/api/teams/:teamId/time-entry-policy', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const policy = await dependencies.getTimeTracking().getEntryPolicy(principal.directoryId, teamId)
      const canEdit = canManage && await dependencies.canManageWholeTeam(principal, teamId)
      return context.json({ policy, canEdit })
    })
  })

  router.put('/api/teams/:teamId/time-entry-policy', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, canManage) => {
      // The policy applies to every Project of the Team, so a manager of only some Projects cannot change it.
      if (!canManage || !await dependencies.canManageWholeTeam(principal, teamId)) {
        throw new TimeTrackingError(403, 'TimeEntryPolicyDenied', 'Only a manager of the whole Team may change its time entry checks.')
      }
      const body = asRecord(await dependencies.readJson(context.req))
      const policy = readTeamTimeEntryPolicy(body)
      if (!policy) {
        throw new TimeTrackingError(400, 'InvalidTimeEntryPolicy', 'overlap and dailyLimit must be off, warn, or reject, and dailyLimitMinutes 1 to 1440.')
      }
      const saved = await dependencies.getTimeTracking().saveEntryPolicy({
        workspaceId: principal.directoryId,
        teamId,
        policy,
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
        actorUserId: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ policy: saved, canEdit: true })
    })
  })

  router.get('/api/teams/:teamId/time-periods', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const closedPeriods = await dependencies.getTimeTracking().listClosedPeriods(principal.directoryId, teamId)
      return context.json({
        closedPeriods,
        canManagePeriods: canManage && await dependencies.canManageWholeTeam(principal, teamId),
      })
    })
  })

  router.get('/api/time-periods/:month', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      await requireWorkspacePeriodManager(dependencies, principal)
      const month = readRequiredString(context.req.param('month'), 'Month')
      const workspaceTeams = await dependencies.listWorkspaceTeams(principal)
      const names = new Map(workspaceTeams.map((team) => [team.teamId, team.name]))
      const teams = await dependencies.getTimeTracking().listWorkspacePeriodCloses(
        principal.directoryId,
        workspaceTeams.map((team) => team.teamId),
        month,
      )
      // Names come from the Workspace directory, because an administrator may not read every Team.
      return context.json({
        month,
        teams: teams.map((team) => {
          const name = names.get(team.teamId)
          return name === undefined ? team : { ...team, name }
        }),
      })
    })
  })

  router.post('/api/time-periods/:month/close', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      await requireWorkspacePeriodManager(dependencies, principal)
      const body = asRecord(await dependencies.readJson(context.req))
      const result = await dependencies.getTimeTracking().closeWorkspacePeriod({
        workspaceId: principal.directoryId,
        teamIds: (await dependencies.listWorkspaceTeams(principal)).map((team) => team.teamId),
        month: readRequiredString(context.req.param('month'), 'Month'),
        timeZone: body.timeZone === undefined ? 'UTC' : readRequiredString(body.timeZone, 'Time zone'),
        actorUserId: principal.userKey,
        authorizationConditionChecks: dependencies.createAuthorizationConditionChecks(principal),
        ...readCorrelationId(context.req.header('X-Correlation-Id')),
      })
      return context.json(result)
    })
  })

  router.post('/api/time-periods/:month/reopen', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      await requireWorkspacePeriodManager(dependencies, principal)
      const body = asRecord(await dependencies.readJson(context.req))
      const result = await dependencies.getTimeTracking().reopenWorkspacePeriod({
        workspaceId: principal.directoryId,
        teamIds: (await dependencies.listWorkspaceTeams(principal)).map((team) => team.teamId),
        month: readRequiredString(context.req.param('month'), 'Month'),
        actorUserId: principal.userKey,
        reason: typeof body.reason === 'string' ? body.reason : '',
        authorizationConditionChecks: dependencies.createAuthorizationConditionChecks(principal),
        ...readCorrelationId(context.req.header('X-Correlation-Id')),
      })
      return context.json(result)
    })
  })

  router.post('/api/teams/:teamId/time-periods/:month/close', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, canManage) => {
      await requireWholeTeamManager(dependencies, principal, teamId, canManage)
      const body = asRecord(await dependencies.readJson(context.req))
      const period = await dependencies.getTimeTracking().closePeriod({
        workspaceId: principal.directoryId,
        teamId,
        month: readRequiredString(context.req.param('month'), 'Month'),
        timeZone: body.timeZone === undefined ? 'UTC' : readRequiredString(body.timeZone, 'Time zone'),
        actorUserId: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ period }, 201)
    })
  })

  router.post('/api/teams/:teamId/time-periods/:month/reopen', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, canManage) => {
      await requireWholeTeamManager(dependencies, principal, teamId, canManage)
      const body = asRecord(await dependencies.readJson(context.req))
      const period = await dependencies.getTimeTracking().reopenPeriod({
        workspaceId: principal.directoryId,
        teamId,
        month: readRequiredString(context.req.param('month'), 'Month'),
        actorUserId: principal.userKey,
        reason: typeof body.reason === 'string' ? body.reason : '',
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ period })
    })
  })

  router.get('/api/teams/:teamId/time-entries/:entryId/history', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const entry = await dependencies.getTimeTracking().getEntry(
        principal.directoryId,
        teamId,
        readRequiredString(context.req.param('entryId'), 'Time entry ID'),
      )
      if (entry.workItemId) await dependencies.verifyWorkItem(principal, teamId, entry.workItemId, 'viewer')
      if (entry.projectId) await dependencies.verifyProject(principal, teamId, entry.projectId, 'viewer')
      const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      if (entry.userId !== principal.userKey && !(canManage && canManageProject(managedProjectIds, entry.projectId))) {
        throw new TimeTrackingError(403, 'TimeEntryAccessDenied', 'Only the entry owner or a manager may view its history.')
      }
      const history = await dependencies.getTimeTracking().listHistory(principal.directoryId, teamId, entry.id)
      return context.json({ history })
    })
  })

  router.post('/api/teams/:teamId/timers', async (context) => {
    return await withTeam(context, dependencies, 'member', async (principal, teamId) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const workItemId = readRequiredString(body.workItemId, 'Work Item ID')
      const canonicalProjectId = await dependencies.verifyWorkItem(principal, teamId, workItemId, 'member')
      const requestedProjectId = readOptionalString(body.projectId)
      if (requestedProjectId !== undefined && requestedProjectId !== canonicalProjectId) {
        throw new TimeTrackingError(400, 'WorkItemProjectMismatch', 'The Project must match the Work Item assignment.')
      }
      if (canonicalProjectId) await dependencies.verifyProject(principal, teamId, canonicalProjectId, 'member')
      const timer = await dependencies.getTimeTracking().startTimer({
        workspaceId: principal.directoryId,
        teamId,
        workItemId,
        ...(canonicalProjectId ? { projectId: canonicalProjectId } : {}),
        userId: principal.userKey,
        ...(readOptionalString(body.description) ? { description: readOptionalString(body.description) } : {}),
        billable: readRequiredBoolean(body.billable, 'Billable'),
        ...(body.startedAt === undefined ? {} : { startedAt: readRequiredString(body.startedAt, 'Start time') }),
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ timer }, 201)
    })
  })

  router.get('/api/time-tracking/timers/active', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      const timer = await dependencies.getTimeTracking().getActiveTimer(principal.directoryId, principal.userKey)
      return context.json({ timer: timer ?? null })
    })
  })

  router.post('/api/time-tracking/timers/:timerId/stop', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      const timer = await dependencies.getTimeTracking().getActiveTimer(principal.directoryId, principal.userKey)
      if (!timer || timer.id !== context.req.param('timerId')) {
        throw new TimeTrackingError(404, 'RunningTimerNotFound', 'The running timer was not found or has already been stopped.')
      }
      await dependencies.requireTeamPermission(principal, timer.teamId, 'member')
      if (timer.projectId) await dependencies.verifyProject(principal, timer.teamId, timer.projectId, 'member')
      const canManage = await dependencies.canManageRates(principal, timer.teamId)
      const body = asRecord(await dependencies.readJson(context.req))
      if (timer.projectId && body.hourlyRateMinor !== undefined) {
        await dependencies.verifyProject(principal, timer.teamId, timer.projectId, 'manager')
      }
      const entry = await dependencies.getTimeTracking().stopTimer({
        workspaceId: principal.directoryId,
        timerId: timer.id,
        userId: principal.userKey,
        ...(body.endedAt === undefined ? {} : { endedAt: readRequiredString(body.endedAt, 'End time') }),
        ...await readRequestCurrency(dependencies, principal, body.currency),
        ...(body.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: readRequiredNumber(body.hourlyRateMinor, 'Hourly rate') }),
        canManageRates: canManage,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      const managedProjectIds = await dependencies.getManagedProjectIds(principal, timer.teamId)
      return context.json({ entry: redactEntry(entry, canManage, managedProjectIds) })
    })
  })

  router.delete('/api/time-tracking/timers/:timerId', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      const timer = await dependencies.getTimeTracking().getActiveTimer(principal.directoryId, principal.userKey)
      if (!timer || timer.id !== context.req.param('timerId')) {
        throw new TimeTrackingError(404, 'RunningTimerNotFound', 'The running timer was not found or has already been stopped.')
      }
      await dependencies.requireTeamPermission(principal, timer.teamId, 'member')
      await dependencies.getTimeTracking().cancelTimer({
        workspaceId: principal.directoryId,
        timerId: timer.id,
        userId: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.body(null, 204)
    })
  })

  router.get('/api/time-tracking/my-timesheet', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      const teams = await dependencies.listTimeTrackingTeams(principal, 'viewer')
      const results = await Promise.all(teams.map(async (team) => {
        const input = readReportInput(context, principal.directoryId, team.teamId, false)
        input.projectIds = await dependencies.getAccessibleProjectIds(principal, team.teamId)
        // Only the caller's own time, whatever the caller manages in the Team.
        input.viewer = { userId: principal.userKey, canManage: false }
        // Entries are listed over the normalized period, so date-only bounds follow the time zone.
        const timesheet = await dependencies.getTimeTracking().createTimesheet(input)
        const entries = await dependencies.getTimeTracking().listAllEntries({
          workspaceId: principal.directoryId,
          teamId: team.teamId,
          from: timesheet.from,
          to: timesheet.to,
          userId: principal.userKey,
          ...(input.projectIds ? { projectIds: input.projectIds, includeUnassigned: true } : {}),
        })
        return {
          teamId: team.teamId,
          name: team.name,
          timesheet: { ...timesheet, canManageTeam: false },
          entries: entries.map((entry) => redactEntry(entry, false)),
        }
      }))
      const timeZone = context.req.query('timeZone') ?? 'UTC'
      return context.json({ timeZone, teams: results })
    })
  })

  router.post('/api/time-tracking/my-timesheet/submit', async (context) => {
    return await withAuthenticated(context, dependencies, async (principal) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const from = readRequiredString(body.from, 'Period start')
      const to = readRequiredString(body.to, 'Period end')
      const requested = readMyTimesheetSubmitEntries(body.entries)
      const idempotencyKey = readOptionalIdempotencyKey(context)
      const teams = await dependencies.listTimeTrackingTeams(principal, 'member')
      const result = await submitMyTimesheet({
        submitTeamEntries: async (teamId, entries) => {
          const { updated, failedEntryIds } = await runTimesheetAction(dependencies, principal, teamId, false, {
            action: 'submit',
            from,
            to,
            entries,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          })
          return { count: updated.length, failedEntryIds }
        },
      }, { entries: requested, permittedTeamIds: new Set(teams.map((team) => team.teamId)) })
      return context.json(result)
    })
  })

  router.get('/api/teams/:teamId/time-tracking/summary', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      input.managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      input.viewer = { userId: principal.userKey, canManage, includeAllMembers: input.groupBy === 'work-item' }
      if (input.budgetScope === 'project' && input.budgetScopeId) await dependencies.verifyProject(principal, teamId, input.budgetScopeId, 'viewer')
      return context.json(await dependencies.getTimeTracking().createSummary(input))
    })
  })

  router.get('/api/teams/:teamId/timesheet', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      input.managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      input.viewer = { userId: principal.userKey, canManage }
      return context.json(await dependencies.getTimeTracking().createTimesheet(input))
    })
  })

  router.get('/api/teams/:teamId/time-tracking/export', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      input.managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      input.viewer = { userId: principal.userKey, canManage, includeAllMembers: input.groupBy === 'work-item' }
      const csv = await dependencies.getTimeTracking().createCsv(input)
      return new Response(csv, {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': 'attachment; filename="mukuroji-time-tracking.csv"',
          'Content-Type': 'text/csv; charset=utf-8',
        },
      })
    })
  })

  router.get('/api/teams/:teamId/time-tracking/settings', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const response: TimeTrackingTeamSettingsResponse = {
        defaultCurrency: await readDefaultCurrency(dependencies, principal),
        canManageRateCard: canManage && await dependencies.canManageWholeTeam(principal, teamId),
      }
      return context.json(response)
    })
  })

  router.get('/api/teams/:teamId/time-rate-card', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, canManage) => {
      await requireRateCardManager(dependencies, principal, teamId, canManage)
      const rateCard = await dependencies.getTimeTracking().getRateCard(
        principal.directoryId,
        teamId,
        await readDefaultCurrency(dependencies, principal),
      )
      const response: TimeRateCardResponse = { rateCard }
      return context.json(response)
    })
  })

  router.put('/api/teams/:teamId/time-rate-card', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId, canManage) => {
      await requireRateCardManager(dependencies, principal, teamId, canManage)
      const body = asRecord(await dependencies.readJson(context.req))
      const rateCard = await dependencies.getTimeTracking().saveRateCard({
        workspaceId: principal.directoryId,
        teamId,
        currency: readRequiredString(body.currency, 'Currency'),
        memberRates: readRateCardRows(body.memberRates, 'Member rates'),
        jobRoleRates: readRateCardRows(body.jobRoleRates, 'Job role rates'),
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
        updatedBy: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      const response: TimeRateCardResponse = { rateCard }
      return context.json(response)
    })
  })

  router.put('/api/teams/:teamId/time-budget', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const budget = await dependencies.getTimeTracking().saveBudget({
        workspaceId: principal.directoryId,
        teamId,
        scopeType: 'team',
        scopeId: teamId,
        amountMinor: readRequiredNumber(body.amountMinor, 'Budget amount'),
        ...await readRequestCurrency(dependencies, principal, body.currency),
        ...(body.periodFrom === undefined ? {} : { periodFrom: readRequiredString(body.periodFrom, 'Budget period start') }),
        ...(body.periodTo === undefined ? {} : { periodTo: readRequiredString(body.periodTo, 'Budget period end') }),
        ...(body.periodBudget === undefined ? {} : { periodBudget: readRequiredBoolean(body.periodBudget, 'Period budget') }),
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
        ...(body.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: readRequiredString(body.expectedUpdatedAt, 'Expected update time') }),
        updatedBy: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ budget })
    })
  })

  router.put('/api/teams/:teamId/projects/:projectId/time-budget', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, _teamId) => {
      await dependencies.verifyProject(
        principal,
        readRequiredString(context.req.param('teamId'), 'Team ID'),
        readRequiredString(context.req.param('projectId'), 'Project ID'),
        'manager',
      )
      const body = asRecord(await dependencies.readJson(context.req))
      const budget = await dependencies.getTimeTracking().saveBudget({
        workspaceId: principal.directoryId,
        teamId: _teamId,
        scopeType: 'project',
        scopeId: readRequiredString(context.req.param('projectId'), 'Project ID'),
        amountMinor: readRequiredNumber(body.amountMinor, 'Budget amount'),
        ...await readRequestCurrency(dependencies, principal, body.currency),
        ...(body.periodFrom === undefined ? {} : { periodFrom: readRequiredString(body.periodFrom, 'Budget period start') }),
        ...(body.periodTo === undefined ? {} : { periodTo: readRequiredString(body.periodTo, 'Budget period end') }),
        ...(body.periodBudget === undefined ? {} : { periodBudget: readRequiredBoolean(body.periodBudget, 'Period budget') }),
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
        ...(body.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: readRequiredString(body.expectedUpdatedAt, 'Expected update time') }),
        updatedBy: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ budget })
    })
  })

  router.delete('/api/teams/:teamId/time-budget/periods/:periodFrom/:periodTo', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      await dependencies.getTimeTracking().deleteBudgetPeriod({
        workspaceId: principal.directoryId,
        teamId,
        scopeType: 'team',
        scopeId: teamId,
        ...readBudgetPeriodParams(context),
        deletedBy: principal.userKey,
      })
      return context.body(null, 204)
    })
  })

  router.delete('/api/teams/:teamId/projects/:projectId/time-budget/periods/:periodFrom/:periodTo', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const projectId = readRequiredString(context.req.param('projectId'), 'Project ID')
      await dependencies.verifyProject(principal, teamId, projectId, 'manager')
      await dependencies.getTimeTracking().deleteBudgetPeriod({
        workspaceId: principal.directoryId,
        teamId,
        scopeType: 'project',
        scopeId: projectId,
        ...readBudgetPeriodParams(context),
        deletedBy: principal.userKey,
      })
      return context.body(null, 204)
    })
  })

  return router
}

/**
 * Reads the period and expected revision of a budget per period from a delete request.
 *
 * @param context - Request whose path names the period and whose query names `expectedRevision`.
 * @returns Period dates and revision.
 */
function readBudgetPeriodParams(context: Context): {
  periodFrom: string
  periodTo: string
  expectedRevision: number
  expectedUpdatedAt?: string
} {
  const revision = Number(context.req.query('expectedRevision'))
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TimeTrackingError(400, 'InvalidRevision', 'expectedRevision must be a positive integer.')
  }
  const expectedUpdatedAt = context.req.query('expectedUpdatedAt')
  return {
    periodFrom: readRequiredString(context.req.param('periodFrom'), 'Budget period start'),
    periodTo: readRequiredString(context.req.param('periodTo'), 'Budget period end'),
    expectedRevision: revision,
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
  }
}

/** A week-wide timesheet lifecycle operation over one period. */
type TimesheetActionInput = {
  /** Lifecycle operation applied to every eligible entry. */
  action: 'submit' | 'approve' | 'reject' | 'lock'
  /** Period start. */
  from: string
  /** Period end. */
  to: string
  /** Rejection reason, when given. */
  reason?: string
  /**
   * Entries the caller saw and asked to change, with the revision they saw. When given, only
   * these entries are changed, each at that revision, instead of every eligible entry of the period.
   */
  entries?: readonly TimesheetActionEntry[]
  /** Request key; each listed entry derives its own key from it so a retry replays the first result. */
  idempotencyKey?: string
}

/** One entry a bulk timesheet request names. */
type TimesheetActionEntry = {
  /** Entry identifier. */
  entryId: string
  /** Revision of the entry the caller saw. */
  expectedRevision: number
}


/**
 * Applies a lifecycle operation to every eligible entry of a Team in a period.
 *
 * Submit takes the caller's own draft and rejected entries in visible Projects and outside any
 * Project; the other operations take entries in the Projects the caller manages. Each entry is
 * attempted, and the ones that fail are returned for a later retry.
 *
 * @param dependencies - Router dependencies.
 * @param principal - Authenticated caller whose Team permission was already checked.
 * @param teamId - Team whose entries change.
 * @param canManage - Whether the caller manages time in the Team.
 * @param input - Operation and period.
 * @returns The updated entries and the IDs of entries that could not be changed.
 */
async function runTimesheetAction<Principal extends TimeTrackingPrincipal>(
  dependencies: TimeTrackingRouterDependencies<Principal>,
  principal: Principal,
  teamId: string,
  canManage: boolean,
  input: TimesheetActionInput,
): Promise<{ updated: TimeEntry[]; failedEntryIds: string[] }> {
  const { action } = input
  const minimum = action === 'submit' ? 'member' : 'manager'
  const accessibleProjectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
  const managedProjectIds = action === 'submit' ? undefined : await dependencies.getManagedProjectIds(principal, teamId)
  const projectIds = action === 'submit'
    ? accessibleProjectIds
    : intersectProjectIds(accessibleProjectIds, managedProjectIds)
  const entries = await dependencies.getTimeTracking().listAllEntries({
    workspaceId: principal.directoryId,
    teamId,
    from: input.from,
    to: input.to,
    userId: action === 'submit' ? principal.userKey : undefined,
    ...(projectIds ? { projectIds, includeUnassigned: true } : {}),
  })
  const requestedRevisions = input.entries
    ? new Map(input.entries.map((entry) => [entry.entryId, entry.expectedRevision]))
    : undefined
  // Named entries are matched by ID whatever their status now, so a retry after a committed
  // request replays each entry's first result instead of picking up drafts created since.
  const eligible = requestedRevisions
    ? entries.filter((entry) => requestedRevisions.has(entry.id))
    : entries.filter((entry) => action === 'submit'
      ? entry.status === 'draft' || entry.status === 'rejected'
      : action === 'lock'
        ? entry.status === 'approved'
        : entry.status === 'submitted')
  const missingEntryIds = requestedRevisions
    ? [...requestedRevisions.keys()].filter((entryId) => !eligible.some((entry) => entry.id === entryId))
    : []
  const projectIdsToVerify = [...new Set(eligible.flatMap((entry) => entry.projectId ? [entry.projectId] : []))]
  for (const projectId of projectIdsToVerify) await dependencies.verifyProject(principal, teamId, projectId, minimum)
  const updated: TimeEntry[] = []
  const failedEntryIds: string[] = [...missingEntryIds]
  for (const entry of eligible) {
    try {
      updated.push(await dependencies.getTimeTracking().transitionEntry({
        workspaceId: principal.directoryId,
        teamId,
        entryId: entry.id,
        actorUserId: principal.userKey,
        canApprove: canManage,
        expectedRevision: requestedRevisions?.get(entry.id) ?? entry.revision,
        // Binds the transition to the revision whose Project was verified above.
        authorizedRevision: entry.revision,
        action,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: deriveEntryIdempotencyKey(input.idempotencyKey, teamId, entry.id) }),
      }))
    } catch {
      failedEntryIds.push(entry.id)
    }
  }
  return { updated, failedEntryIds }
}

/** Runs an operation after bearer authentication and, for mutations, the business write check. */
async function withAuthenticated<Principal extends TimeTrackingPrincipal>(
  context: Context,
  dependencies: TimeTrackingRouterDependencies<Principal>,
  operation: (principal: Principal) => Promise<Response>,
): Promise<Response> {
  const accessToken = dependencies.readBearerAccessToken(context)
  if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
  try {
    const principal = await dependencies.authenticate(accessToken, context)
    if (context.req.method !== 'GET' && context.req.method !== 'HEAD') await dependencies.requireWrite(principal)
    return await operation(principal)
  } catch (error) {
    return dependencies.mapError(context, error)
  }
}

/** Runs an operation after bearer authentication and Team authorization. */
async function withTeam<Principal extends TimeTrackingPrincipal>(
  context: Context,
  dependencies: TimeTrackingRouterDependencies<Principal>,
  minimum: 'viewer' | 'member' | 'manager',
  operation: (principal: Principal, teamId: string, canManage: boolean) => Promise<Response>,
): Promise<Response> {
  return await withAuthenticated(context, dependencies, async (principal) => {
    const teamId = readRequiredString(context.req.param('teamId'), 'Team ID')
    await dependencies.requireTeamPermission(principal, teamId, minimum)
    const canManage = await dependencies.canManageRates(principal, teamId)
    return await operation(principal, teamId, canManage)
  })
}

/**
 * Adds the warnings of a saved entry to its response only when there are any, so responses of
 * Teams without checks keep their shape.
 *
 * @param warnings - Checks the entry broke in a Team that only warns.
 * @returns `{ warnings }` or an empty object.
 */
function withWarnings(warnings: readonly TimeEntryPolicyWarning[]): { warnings?: readonly TimeEntryPolicyWarning[] } {
  return warnings.length > 0 ? { warnings } : {}
}

/**
 * Requires a manager of every Project in the Team, because a month close applies to all of its time.
 *
 * @param dependencies - Router dependencies used to read the Team management scope.
 * @param principal - Authenticated caller.
 * @param teamId - Team whose month is closed or reopened.
 * @param canManage - Whether the caller manages time in the Team at all.
 * @throws TimeTrackingError when the caller manages only some Projects of the Team.
 */
async function requireWholeTeamManager<Principal extends TimeTrackingPrincipal>(
  dependencies: TimeTrackingRouterDependencies<Principal>,
  principal: Principal,
  teamId: string,
  canManage: boolean,
): Promise<void> {
  if (!canManage || !await dependencies.canManageWholeTeam(principal, teamId)) {
    throw new TimeTrackingError(403, 'TimePeriodCloseDenied', 'Only a manager of the whole Team may close or reopen a month.')
  }
}

/**
 * Requires a Workspace administrator, because a Workspace-wide close changes every Team's time.
 *
 * @param dependencies - Router dependencies used to read the Workspace role.
 * @param principal - Authenticated caller.
 * @throws TimeTrackingError with `WorkspaceTimePeriodCloseDenied` for any other caller.
 */
async function requireWorkspacePeriodManager<Principal extends TimeTrackingPrincipal>(
  dependencies: TimeTrackingRouterDependencies<Principal>,
  principal: Principal,
): Promise<void> {
  if (!await dependencies.canManageWorkspacePeriods(principal)) {
    throw new TimeTrackingError(403, 'WorkspaceTimePeriodCloseDenied', 'Only a Workspace administrator may close or reopen a month for every Team.')
  }
}

/**
 * Requires a manager of every Project in the Team, because the rate card holds every member's
 * confidential rate.
 *
 * @param dependencies - Router dependencies used to read the Team management scope.
 * @param principal - Authenticated caller.
 * @param teamId - Team whose rate card is read or changed.
 * @param canManage - Whether the caller manages time in the Team at all.
 * @throws TimeTrackingError with `TimeRateCardDenied` when the caller manages only some Projects.
 */
async function requireRateCardManager<Principal extends TimeTrackingPrincipal>(
  dependencies: TimeTrackingRouterDependencies<Principal>,
  principal: Principal,
  teamId: string,
  canManage: boolean,
): Promise<void> {
  if (!canManage || !await dependencies.canManageWholeTeam(principal, teamId)) {
    throw new TimeTrackingError(403, 'TimeRateCardDenied', 'Only a manager of the whole Team may read or change its rate card.')
  }
}

/**
 * Reads the currency a request names, or the Workspace default with a flag that keeps the default
 * out of the request fingerprint.
 *
 * @param dependencies - Router dependencies.
 * @param principal - Caller.
 * @param value - Currency from the request body.
 * @returns Input fields for the currency.
 */
async function readRequestCurrency<Principal extends TimeTrackingPrincipal>(
  dependencies: TimeTrackingRouterDependencies<Principal>,
  principal: Principal,
  value: unknown,
): Promise<{ currency: string, currencyFromWorkspaceDefault?: true }> {
  const requested = readOptionalString(value)
  return requested === undefined
    ? { currency: await readDefaultCurrency(dependencies, principal), currencyFromWorkspaceDefault: true }
    : { currency: requested }
}

/**
 * Reads the Workspace currency used when a request names none.
 *
 * @param dependencies - Router dependencies that may read the Workspace setting.
 * @param principal - Authenticated caller whose Workspace is read.
 * @returns The Workspace currency, or `DEFAULT_WORKSPACE_CURRENCY`.
 */
async function readDefaultCurrency<Principal extends TimeTrackingPrincipal>(
  dependencies: TimeTrackingRouterDependencies<Principal>,
  principal: Principal,
): Promise<string> {
  return await dependencies.readDefaultCurrency?.(principal) ?? DEFAULT_WORKSPACE_CURRENCY
}

/**
 * Reads the rows of a rate card request; the service validates each row.
 *
 * @param value - Untrusted rows.
 * @param label - Field name used in the error.
 * @returns The rows.
 * @throws TimeTrackingError with `InvalidTimeRateCard` when the value is not an array.
 */
function readRateCardRows(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TimeTrackingError(400, 'InvalidTimeRateCard', `${label} must be an array.`)
  return value
}

/** Reads a report query into an application input. */
function readReportInput(
  context: Context,
  workspaceId: string,
  teamId: string,
  includeCosts: boolean,
): TimeTrackingReportInput {
  const from = context.req.query('from')
  const to = context.req.query('to')
  const timeZone = context.req.query('timeZone') ?? 'UTC'
  if (!from || !to) throw new TimeTrackingError(400, 'InvalidTimeRange', 'from and to are required.')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new TimeTrackingError(400, 'InvalidTimeZone', 'timeZone must be a valid IANA timezone identifier.')
  }
  const groupBy = readGroupBy(context.req.query('groupBy') ?? 'day')
  const budgetScope = context.req.query('budgetScope')
  if (budgetScope !== undefined && budgetScope !== 'team' && budgetScope !== 'project') {
    throw new TimeTrackingError(400, 'InvalidBudgetScope', 'budgetScope must be team or project.')
  }
  const budgetScopeId = context.req.query('projectId')?.trim() || undefined
  if (budgetScope === 'project' && !budgetScopeId) {
    throw new TimeTrackingError(400, 'InvalidBudgetScope', 'projectId is required for a project budget scope.')
  }
  if (budgetScope !== 'project' && budgetScopeId) {
    throw new TimeTrackingError(400, 'InvalidBudgetScope', 'projectId is only valid for a project budget scope.')
  }
  return {
    workspaceId,
    teamId,
    from,
    to,
    timeZone,
    groupBy,
    includeCosts,
    ...(budgetScope ? { budgetScope } : {}),
    ...(budgetScopeId ? { budgetScopeId } : {}),
  }
}

/**
 * Returns whether a Team time manager manages the Project that owns a time entry.
 *
 * Callers combine it with the Team-level manager check: entries without a Project belong to the
 * Team, so every Team time manager manages them.
 *
 * @param managedProjectIds - Managed Project IDs, or `undefined` for a principal who manages every Project.
 * @param projectId - Project of the entry, if any.
 * @returns `true` when the entry has no Project or the principal manages its Project.
 */
function canManageProject(managedProjectIds: ReadonlySet<string> | undefined, projectId: string | undefined): boolean {
  return managedProjectIds === undefined || projectId === undefined || managedProjectIds.has(projectId)
}

/**
 * Narrows the visible Project allowlist to the Projects the principal manages.
 *
 * @param accessibleProjectIds - Visible Project IDs, or `undefined` when every Project is visible.
 * @param managedProjectIds - Managed Project IDs, or `undefined` when every Project is managed.
 * @returns The Projects that are both visible and managed, or `undefined` when neither set restricts.
 */
function intersectProjectIds(
  accessibleProjectIds: ReadonlySet<string> | undefined,
  managedProjectIds: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (managedProjectIds === undefined) return accessibleProjectIds
  if (accessibleProjectIds === undefined) return managedProjectIds
  return new Set([...managedProjectIds].filter((projectId) => accessibleProjectIds.has(projectId)))
}

/** User and Project filters applied to a time entry list request. */
type EntryListScope = {
  /** Owner filter; `undefined` lists every user in the allowed Projects. */
  userId: string | undefined
  /** Project allowlist; `undefined` lists every Project in the Team. */
  projectIds: ReadonlySet<string> | undefined
}

/**
 * Chooses which entries a list request may return.
 *
 * Other users' entries are listed only from the Projects the principal manages
 * and from outside any Project, so managing one Project does not expose time
 * recorded on another. The caller lets entries without a Project through the
 * Project allowlist; the owner filter keeps them to the caller's own for members.
 *
 * @param actorUserId - Member key of the requesting principal.
 * @param requestedUserId - Owner filter from the query, if any.
 * @param canManage - Whether the principal manages any Project of the Team.
 * @param accessibleProjectIds - Visible Project IDs, or `undefined` when every Project is visible.
 * @param managedProjectIds - Managed Project IDs, or `undefined` when every Project is managed.
 * @returns The owner and Project filters for the repository query.
 */
function resolveEntryListScope(
  actorUserId: string,
  requestedUserId: string | undefined,
  canManage: boolean,
  accessibleProjectIds: ReadonlySet<string> | undefined,
  managedProjectIds: ReadonlySet<string> | undefined,
): EntryListScope {
  if (requestedUserId === actorUserId || !canManage) return { userId: actorUserId, projectIds: accessibleProjectIds }
  return { userId: requestedUserId, projectIds: intersectProjectIds(accessibleProjectIds, managedProjectIds) }
}

/** Removes confidential money fields for general Workspace members. */
function redactEntry(entry: TimeEntry, includeCosts: boolean, managedProjectIds?: ReadonlySet<string>): TimeEntry {
  if (includeCosts && canManageProject(managedProjectIds, entry.projectId)) return entry
  const { hourlyRateMinor: _hourlyRateMinor, actualCostMinor: _actualCostMinor, ...visible } = entry
  return visible
}

/** Validates the optional bounded entry-list limit query. */
function readEntryLimit(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) throw new TimeTrackingError(400, 'InvalidLimit', 'limit must be a positive integer.')
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TimeTrackingError(400, 'InvalidLimit', 'limit must be between 1 and 500.')
  return limit
}

/** Converts unknown JSON into a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** Checks whether a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a required string. */
function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TimeTrackingError(400, 'InvalidRequest', `${label} is required.`)
  return value.trim()
}

/** Reads an optional string. */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Most entries one cross-Team submit may name. */
const MAX_MY_TIMESHEET_SUBMIT_ENTRIES = 500

/**
 * Reads the entries a cross-Team submit names.
 *
 * @param value - Request `entries` field.
 * @returns The named entries, each once.
 */
function readMyTimesheetSubmitEntries(value: unknown): MyTimesheetSubmitEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MY_TIMESHEET_SUBMIT_ENTRIES) {
    throw new TimeTrackingError(400, 'InvalidRequest', `Entries must list 1 to ${MAX_MY_TIMESHEET_SUBMIT_ENTRIES} time entries.`)
  }
  const seen = new Set<string>()
  const entries: MyTimesheetSubmitEntry[] = []
  for (const item of value) {
    const record = asRecord(item)
    const teamId = readRequiredString(record.teamId, 'Team ID')
    const entryId = readRequiredString(record.entryId, 'Time entry ID')
    const expectedRevision = record.expectedRevision
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new TimeTrackingError(400, 'InvalidRequest', 'Expected revision must be a positive integer.')
    }
    const key = `${teamId}\0${entryId}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ teamId, entryId, expectedRevision })
  }
  return entries
}

/**
 * Derives the key of one entry's transition from the key of a bulk request.
 *
 * @param idempotencyKey - Key of the bulk request.
 * @param teamId - Team of the entry.
 * @param entryId - Entry identifier.
 * @returns A fixed-length key bound to the request, Team, and entry.
 */
function deriveEntryIdempotencyKey(idempotencyKey: string, teamId: string, entryId: string): string {
  return createHash('sha256').update(`${idempotencyKey}\0${teamId}\0${entryId}`).digest('hex')
}

/** Reads an optional bounded idempotency key from a mutation request. */
function readOptionalIdempotencyKey(context: Context): string | undefined {
  const value = context.req.header('Idempotency-Key')?.trim()
  if (!value) return undefined
  if (value.length > 256) {
    throw new TimeTrackingError(400, 'InvalidRequest', 'Idempotency-Key must be at most 256 characters.')
  }
  return value
}

/** Reads a required number. */
function readRequiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TimeTrackingError(400, 'InvalidRequest', `${label} must be a number.`)
  return value
}

/** Reads a required boolean. */
function readRequiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TimeTrackingError(400, 'InvalidRequest', `${label} must be a boolean.`)
  return value
}

/** Reads a lifecycle status query. */
function readStatus(value: string | undefined): TimeEntryStatus {
  if (value === 'draft' || value === 'submitted' || value === 'approved' || value === 'rejected' || value === 'locked') return value
  throw new TimeTrackingError(400, 'InvalidStatus', 'status is invalid.')
}

/** Converts a validated group-by query into its contract union. */
function readGroupBy(value: string): TimeTrackingGroupBy {
  if (value === 'day' || value === 'week' || value === 'user' || value === 'project' || value === 'work-item' || value === 'category') return value
  throw new TimeTrackingError(400, 'InvalidGroupBy', 'groupBy must be day, week, project, user, work-item, or category.')
}

/**
 * Reads the interval of a create request: `startAt` and `endAt`, or `date` and `minutes`.
 *
 * A `date` and `minutes` request may name the IANA `timeZone` of its date and defaults to UTC.
 *
 * @param body - Parsed JSON request body.
 * @returns Either the interval times or the date-and-minutes input for the service to resolve.
 */
function readCreateInterval(body: Record<string, unknown>): Pick<CreateTimeEntryInput, 'startAt' | 'endAt' | 'duration'> {
  if (body.date === undefined && body.minutes === undefined) {
    return {
      startAt: readRequiredString(body.startAt, 'Start time'),
      endAt: readRequiredString(body.endAt, 'End time'),
    }
  }
  if (body.startAt !== undefined || body.endAt !== undefined) {
    throw new TimeTrackingError(400, 'InvalidRequest', 'Send either startAt and endAt, or date and minutes, not both.')
  }
  return {
    duration: {
      date: readRequiredString(body.date, 'Work date'),
      minutes: readRequiredNumber(body.minutes, 'Minutes'),
      timeZone: body.timeZone === undefined ? 'UTC' : readRequiredString(body.timeZone, 'Time zone'),
    },
  }
}

/**
 * Reads the interval changes of an update request: `startAt` and `endAt`, or `date` and `minutes`.
 *
 * A `date` and `minutes` update keeps or makes the entry a date-and-minutes entry; it needs both
 * values and may name the IANA `timeZone` of its date, which defaults to UTC.
 *
 * @param body - Parsed JSON request body.
 * @returns The new times, the new date and minutes, or nothing when the interval is unchanged.
 */
function readUpdateInterval(body: Record<string, unknown>): Pick<CreateTimeEntryInput, 'startAt' | 'endAt' | 'duration'> {
  if (body.date === undefined && body.minutes === undefined) {
    return {
      ...(body.startAt === undefined ? {} : { startAt: readRequiredString(body.startAt, 'Start time') }),
      ...(body.endAt === undefined ? {} : { endAt: readRequiredString(body.endAt, 'End time') }),
    }
  }
  return readCreateInterval(body)
}

/**
 * Reads the entry a delete request targets.
 *
 * A retried delete whose first attempt committed finds the entry gone. With an idempotency key
 * the service then replays the stored result for the same actor and request, or reports the entry
 * missing when no such result exists, so the missing entry is not an error here.
 *
 * @param service - Time tracking service.
 * @param workspaceId - Workspace of the caller.
 * @param teamId - Team in the route.
 * @param entryId - Entry in the route.
 * @param idempotencyKey - Key of the request, if any.
 * @returns The entry, or `undefined` when it is missing and the request can be replayed.
 */
async function readEntryUnlessReplayable(
  service: TimeTrackingService,
  workspaceId: string,
  teamId: string,
  entryId: string,
  idempotencyKey: string | undefined,
): Promise<TimeEntry | undefined> {
  try {
    return await service.getEntry(workspaceId, teamId, entryId)
  } catch (error) {
    if (idempotencyKey !== undefined && error instanceof TimeTrackingError && error.code === 'TimeEntryNotFound') return undefined
    throw error
  }
}

/**
 * Reads the `expectedRevision` query of a delete request.
 *
 * @param value - Raw query value.
 * @returns The expected entry revision.
 */
function readExpectedRevisionQuery(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new TimeTrackingError(400, 'InvalidRequest', 'expectedRevision must be a positive integer.')
  }
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TimeTrackingError(400, 'InvalidRequest', 'expectedRevision must be a positive integer.')
  }
  return revision
}

/** Reads a work category from a request body. */
function readCategory(value: unknown): TimeEntryCategory {
  const category = readTimeEntryCategoryKey(value)
  if (category === undefined) {
    throw new TimeTrackingError(400, 'InvalidTimeEntryCategory', 'category must be a work category key.')
  }
  return category
}

/**
 * Reads the request's correlation ID, which the common middleware always sets, for failure logs.
 *
 * @param header - `X-Correlation-Id` header value.
 * @returns The correlation ID as an input field, or nothing when the header is empty.
 */
function readCorrelationId(header: string | undefined): { correlationId?: string } {
  const correlationId = header?.trim()
  return correlationId ? { correlationId } : {}
}
