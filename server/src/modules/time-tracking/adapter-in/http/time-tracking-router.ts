import { Hono, type Context } from 'hono'
import {
  TIME_ENTRY_CATEGORIES,
  type TimeEntry,
  type TimeEntryCategory,
  type TimeEntryStatus,
  type TimeTrackingGroupBy,
} from '@mukuroji/contracts'
import {
  TimeTrackingError,
  type CreateTimeEntryInput,
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
  /** Returns the Project allowlist visible inside the selected Team. */
  getAccessibleProjectIds(principal: Principal, teamId: string): Promise<ReadonlySet<string> | undefined>
  /**
   * Returns whether the principal manages every Project of a Team: a system administrator or a
   * direct Team grant with manage permission, not a manager of only some Projects.
   */
  canManageWholeTeam(principal: Principal, teamId: string): Promise<boolean>
  /** Returns the Project IDs for which the principal may view confidential costs. */
  getManagedProjectIds(principal: Principal, teamId: string): Promise<ReadonlySet<string> | undefined>
  /** Verifies Project-level access for a Team operation. */
  verifyProject(principal: Principal, teamId: string, projectId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Verifies that a referenced Work Item belongs to the selected Team. */
  verifyWorkItem(principal: Principal, teamId: string, workItemId: string, minimum?: 'viewer' | 'member' | 'manager'): Promise<string | undefined>
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
      const entry = await dependencies.getTimeTracking().createEntry({
        workspaceId: principal.directoryId,
        teamId,
        ...(workItemId ? { workItemId } : {}),
        userId: principal.userKey,
        ...(projectId ? { projectId } : {}),
        ...readCreateInterval(body),
        ...(body.category === undefined ? {} : { category: readCategory(body.category) }),
        ...(readOptionalString(body.description) ? { description: readOptionalString(body.description) } : {}),
        billable: readRequiredBoolean(body.billable, 'Billable'),
        currency: readOptionalString(body.currency) ?? 'USD',
        ...(body.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: readRequiredNumber(body.hourlyRateMinor, 'Hourly rate') }),
        source: 'manual',
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      }, canManage)
      const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      return context.json({ entry: redactEntry(entry, canManage, managedProjectIds) }, 201)
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
        ...(projectIds ? { projectIds } : {}),
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
      const entry = await dependencies.getTimeTracking().updateEntry({
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
      return context.json({ entry: redactEntry(entry, canManage, managedProjectIds) })
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
        const from = readRequiredString(body.from, 'Period start')
        const to = readRequiredString(body.to, 'Period end')
        const accessibleProjectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
        const managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
        const projectIds = action === 'submit'
          ? accessibleProjectIds
          : intersectProjectIds(accessibleProjectIds, managedProjectIds)
        const entries = await dependencies.getTimeTracking().listAllEntries({
          workspaceId: principal.directoryId,
          teamId,
          from,
          to,
          userId: action === 'submit' ? principal.userKey : undefined,
          ...(projectIds ? { projectIds } : {}),
        })
        const eligible = entries.filter((entry) => action === 'submit'
          ? entry.status === 'draft' || entry.status === 'rejected'
          : action === 'lock'
            ? entry.status === 'approved'
            : entry.status === 'submitted')
        const projectIdsToVerify = [...new Set(eligible.flatMap((entry) => entry.projectId ? [entry.projectId] : []))]
        for (const projectId of projectIdsToVerify) await dependencies.verifyProject(principal, teamId, projectId, minimum)
        const updated: TimeEntry[] = []
        const failedEntryIds: string[] = []
        for (const entry of eligible) {
          try {
            updated.push(await dependencies.getTimeTracking().transitionEntry({
              workspaceId: principal.directoryId,
              teamId,
              entryId: entry.id,
              actorUserId: principal.userKey,
              canApprove: canManage,
              expectedRevision: entry.revision,
              action,
              ...(body.reason === undefined ? {} : { reason: readRequiredString(body.reason, 'Reason') }),
            }))
          } catch {
            failedEntryIds.push(entry.id)
          }
        }
        return context.json({
          count: updated.length,
          failedEntryIds,
          partialFailure: failedEntryIds.length > 0,
          entries: updated.map((entry) => redactEntry(entry, canManage, managedProjectIds)),
        })
      })
    })
  }

  router.get('/api/teams/:teamId/time-periods', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId) => {
      const closedPeriods = await dependencies.getTimeTracking().listClosedPeriods(principal.directoryId, teamId)
      return context.json({ closedPeriods })
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
        currency: readOptionalString(body.currency) ?? 'USD',
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

  router.get('/api/teams/:teamId/time-tracking/summary', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      input.managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      if (input.budgetScope === 'project' && input.budgetScopeId) await dependencies.verifyProject(principal, teamId, input.budgetScopeId, 'viewer')
      return context.json(await dependencies.getTimeTracking().createSummary(input))
    })
  })

  router.get('/api/teams/:teamId/timesheet', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      input.managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
      return context.json(await dependencies.getTimeTracking().createTimesheet(input))
    })
  })

  router.get('/api/teams/:teamId/time-tracking/export', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      input.managedProjectIds = await dependencies.getManagedProjectIds(principal, teamId)
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

  router.put('/api/teams/:teamId/time-budget', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const body = asRecord(await dependencies.readJson(context.req))
      const budget = await dependencies.getTimeTracking().saveBudget({
        workspaceId: principal.directoryId,
        teamId,
        scopeType: 'team',
        scopeId: teamId,
        amountMinor: readRequiredNumber(body.amountMinor, 'Budget amount'),
        currency: readOptionalString(body.currency) ?? 'USD',
        ...(body.periodFrom === undefined ? {} : { periodFrom: readRequiredString(body.periodFrom, 'Budget period start') }),
        ...(body.periodTo === undefined ? {} : { periodTo: readRequiredString(body.periodTo, 'Budget period end') }),
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
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
        currency: readOptionalString(body.currency) ?? 'USD',
        ...(body.periodFrom === undefined ? {} : { periodFrom: readRequiredString(body.periodFrom, 'Budget period start') }),
        ...(body.periodTo === undefined ? {} : { periodTo: readRequiredString(body.periodTo, 'Budget period end') }),
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
        updatedBy: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ budget })
    })
  })

  return router
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
 * Returns whether the principal manages the Project that owns a time entry.
 *
 * @param managedProjectIds - Managed Project IDs, or `undefined` for a principal who manages every Project.
 * @param projectId - Project of the entry; entries without a Project are managed only by unrestricted principals.
 * @returns `true` when the principal may manage time recorded on the Project.
 */
function canManageProject(managedProjectIds: ReadonlySet<string> | undefined, projectId: string | undefined): boolean {
  return managedProjectIds === undefined || (projectId !== undefined && managedProjectIds.has(projectId))
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
 * Other users' entries are listed only from the Projects the principal manages,
 * so managing one Project does not expose time recorded on another.
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
  if (includeCosts && (managedProjectIds === undefined || (entry.projectId !== undefined && managedProjectIds.has(entry.projectId)))) return entry
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
  const category = TIME_ENTRY_CATEGORIES.find((candidate) => candidate === value)
  if (category === undefined) {
    throw new TimeTrackingError(400, 'InvalidTimeEntryCategory', `category must be one of ${TIME_ENTRY_CATEGORIES.join(', ')}.`)
  }
  return category
}
