import { Hono, type Context } from 'hono'
import type {
  TimeEntry,
  TimeEntryStatus,
  TimeTrackingGroupBy,
} from '@mukuroji/contracts'
import {
  TimeTrackingError,
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
  /** Returns whether the principal can read, write, or manage a Team. */
  requireTeamPermission(principal: Principal, teamId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Returns whether the principal may view confidential rates and costs. */
  canManageRates(principal: Principal, teamId: string): Promise<boolean>
  /** Returns the Project allowlist visible inside the selected Team. */
  getAccessibleProjectIds(principal: Principal, teamId: string): Promise<ReadonlySet<string> | undefined>
  /** Verifies Project-level access for a Team operation. */
  verifyProject(principal: Principal, teamId: string, projectId: string, minimum: 'viewer' | 'member' | 'manager'): Promise<void>
  /** Verifies that a referenced Work Item belongs to the selected Team. */
  verifyWorkItem(principal: Principal, teamId: string, workItemId: string): Promise<void>
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
      const workItemId = readRequiredString(body.workItemId, 'Work Item ID')
      await dependencies.verifyWorkItem(principal, teamId, workItemId)
      if (readOptionalString(body.projectId)) {
        await dependencies.verifyProject(principal, teamId, readRequiredString(body.projectId, 'Project ID'), 'member')
      }
      const entry = await dependencies.getTimeTracking().createEntry({
        workspaceId: principal.directoryId,
        teamId,
        workItemId,
        userId: principal.userKey,
        ...(readOptionalString(body.projectId) ? { projectId: readOptionalString(body.projectId) } : {}),
        startAt: readRequiredString(body.startAt, 'Start time'),
        endAt: readRequiredString(body.endAt, 'End time'),
        ...(readOptionalString(body.description) ? { description: readOptionalString(body.description) } : {}),
        billable: readRequiredBoolean(body.billable, 'Billable'),
        currency: readOptionalString(body.currency) ?? 'USD',
        ...(body.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: readRequiredNumber(body.hourlyRateMinor, 'Hourly rate') }),
        source: 'manual',
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      }, canManage)
      return context.json({ entry: redactEntry(entry, canManage) }, 201)
    })
  })

  router.get('/api/teams/:teamId/time-entries', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const requestedUserId = context.req.query('userId')?.trim() || undefined
      const userId = canManage ? requestedUserId : principal.userKey
      const projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      const entries = await dependencies.getTimeTracking().listEntries({
        workspaceId: principal.directoryId,
        teamId,
        userId,
        ...(context.req.query('from') ? { from: context.req.query('from') } : {}),
        ...(context.req.query('to') ? { to: context.req.query('to') } : {}),
        ...(context.req.query('status') ? { status: readStatus(context.req.query('status')) } : {}),
        ...(context.req.query('limit') ? { limit: Number(context.req.query('limit')) } : {}),
        ...(projectIds ? { projectIds } : {}),
      })
      return context.json({ entries: entries.map((entry) => redactEntry(entry, canManage)) })
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
      await dependencies.verifyWorkItem(principal, teamId, current.workItemId)
      if (current.projectId) await dependencies.verifyProject(principal, teamId, current.projectId, 'member')
      if (body.workItemId !== undefined) {
        await dependencies.verifyWorkItem(principal, teamId, readRequiredString(body.workItemId, 'Work Item ID'))
      }
      if (body.projectId !== undefined && body.projectId !== null) {
        await dependencies.verifyProject(principal, teamId, readRequiredString(body.projectId, 'Project ID'), 'member')
      }
      const entry = await dependencies.getTimeTracking().updateEntry({
        workspaceId: principal.directoryId,
        teamId,
        entryId: readRequiredString(context.req.param('entryId'), 'Time entry ID'),
        actorUserId: principal.userKey,
        canManageRates: canManage,
        expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
        ...(body.startAt === undefined ? {} : { startAt: readRequiredString(body.startAt, 'Start time') }),
        ...(body.endAt === undefined ? {} : { endAt: readRequiredString(body.endAt, 'End time') }),
        ...(body.workItemId === undefined ? {} : { workItemId: readRequiredString(body.workItemId, 'Work Item ID') }),
        ...(body.projectId === null ? { projectId: null } : body.projectId === undefined ? {} : { projectId: readRequiredString(body.projectId, 'Project ID') }),
        ...(body.description === null ? { description: null } : body.description === undefined ? {} : { description: readRequiredString(body.description, 'Description') }),
        ...(body.billable === undefined ? {} : { billable: readRequiredBoolean(body.billable, 'Billable') }),
        ...(body.currency === undefined ? {} : { currency: readRequiredString(body.currency, 'Currency') }),
        ...(body.hourlyRateMinor === null ? { hourlyRateMinor: null } : body.hourlyRateMinor === undefined ? {} : { hourlyRateMinor: readRequiredNumber(body.hourlyRateMinor, 'Hourly rate') }),
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ entry: redactEntry(entry, canManage) })
    })
  })

  for (const action of ['submit', 'approve', 'reject', 'lock'] as const) {
    router.post(`/api/teams/:teamId/time-entries/:entryId/${action}`, async (context) => {
      const minimum = action === 'submit' ? 'member' : 'manager'
      return await withTeam(context, dependencies, minimum, async (principal, teamId, canManage) => {
        const body = asRecord(await dependencies.readJson(context.req))
        const current = await dependencies.getTimeTracking().getEntry(
          principal.directoryId,
          teamId,
          readRequiredString(context.req.param('entryId'), 'Time entry ID'),
        )
        await dependencies.verifyWorkItem(principal, teamId, current.workItemId)
        if (current.projectId) await dependencies.verifyProject(principal, teamId, current.projectId, minimum)
        const entry = await dependencies.getTimeTracking().transitionEntry({
          workspaceId: principal.directoryId,
          teamId,
          entryId: readRequiredString(context.req.param('entryId'), 'Time entry ID'),
          actorUserId: principal.userKey,
          canApprove: canManage,
          expectedRevision: readRequiredNumber(body.expectedRevision, 'Expected revision'),
          action,
          ...(body.reason === undefined ? {} : { reason: readRequiredString(body.reason, 'Reason') }),
          ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
        })
        return context.json({ entry: redactEntry(entry, canManage) })
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
        const projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
        const entries = await dependencies.getTimeTracking().listEntries({
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
        const updated = []
        for (const entry of eligible) {
          if (entry.projectId) await dependencies.verifyProject(principal, teamId, entry.projectId, minimum)
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
        }
        return context.json({
          count: updated.length,
          entries: updated.map((entry) => redactEntry(entry, canManage)),
        })
      })
    })
  }

  router.get('/api/teams/:teamId/time-entries/:entryId/history', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const entry = await dependencies.getTimeTracking().getEntry(
        principal.directoryId,
        teamId,
        readRequiredString(context.req.param('entryId'), 'Time entry ID'),
      )
      await dependencies.verifyWorkItem(principal, teamId, entry.workItemId)
      if (entry.projectId) await dependencies.verifyProject(principal, teamId, entry.projectId, 'viewer')
      if (!canManage && entry.userId !== principal.userKey) {
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
      await dependencies.verifyWorkItem(principal, teamId, workItemId)
      const projectId = readOptionalString(body.projectId)
      if (projectId) await dependencies.verifyProject(principal, teamId, projectId, 'member')
      const timer = await dependencies.getTimeTracking().startTimer({
        workspaceId: principal.directoryId,
        teamId,
        workItemId,
        ...(projectId ? { projectId } : {}),
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
      return context.json({ entry: redactEntry(entry, canManage) })
    })
  })

  router.get('/api/teams/:teamId/time-tracking/summary', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      return context.json(await dependencies.getTimeTracking().createSummary(input))
    })
  })

  router.get('/api/teams/:teamId/timesheet', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
      return context.json(await dependencies.getTimeTracking().createTimesheet(input))
    })
  })

  router.get('/api/teams/:teamId/time-tracking/export', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId, canManage) => {
      const input = readReportInput(context, principal.directoryId, teamId, canManage)
      input.projectIds = await dependencies.getAccessibleProjectIds(principal, teamId)
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

  router.put('/api/teams/:teamId/work-items/:workItemId/time-estimate', async (context) => {
    return await withTeam(context, dependencies, 'manager', async (principal, teamId) => {
      const workItemId = readRequiredString(context.req.param('workItemId'), 'Work Item ID')
      await dependencies.verifyWorkItem(principal, teamId, workItemId)
      const body = asRecord(await dependencies.readJson(context.req))
      const estimate = await dependencies.getTimeTracking().saveEstimate({
        workspaceId: principal.directoryId,
        teamId,
        workItemId,
        estimateMinutes: readRequiredNumber(body.estimateMinutes, 'Estimate minutes'),
        updatedBy: principal.userKey,
        ...(readOptionalIdempotencyKey(context) ? { idempotencyKey: readOptionalIdempotencyKey(context) } : {}),
      })
      return context.json({ estimate })
    })
  })

  router.get('/api/teams/:teamId/work-items/:workItemId/time-estimate', async (context) => {
    return await withTeam(context, dependencies, 'viewer', async (principal, teamId) => {
      const workItemId = readRequiredString(context.req.param('workItemId'), 'Work Item ID')
      await dependencies.verifyWorkItem(principal, teamId, workItemId)
      const estimate = await dependencies.getTimeTracking().getEstimate(
        principal.directoryId,
        teamId,
        workItemId,
      )
      return context.json({ estimate: estimate ?? null })
    })
  })

  return router
}

/** Runs an operation after bearer authentication. */
async function withAuthenticated<Principal extends TimeTrackingPrincipal>(
  context: Context,
  dependencies: TimeTrackingRouterDependencies<Principal>,
  operation: (principal: Principal) => Promise<Response>,
): Promise<Response> {
  const accessToken = dependencies.readBearerAccessToken(context)
  if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
  try {
    return await operation(await dependencies.authenticate(accessToken, context))
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
  const groupBy: string = context.req.query('groupBy') ?? 'day'
  if (groupBy !== 'day' && groupBy !== 'week' && groupBy !== 'user' && groupBy !== 'project' && groupBy !== 'work-item') {
    throw new TimeTrackingError(400, 'InvalidGroupBy', 'groupBy must be day, week, project, user, or work-item.')
  }
  return {
    workspaceId,
    teamId,
    from,
    to,
    timeZone,
    groupBy: readGroupBy(groupBy),
    includeCosts,
  }
}

/** Removes confidential money fields for general Workspace members. */
function redactEntry(entry: TimeEntry, includeCosts: boolean): TimeEntry {
  if (includeCosts) return entry
  const { hourlyRateMinor: _hourlyRateMinor, actualCostMinor: _actualCostMinor, ...visible } = entry
  return visible
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
  if (value === 'day' || value === 'week' || value === 'user' || value === 'project' || value === 'work-item') return value
  throw new TimeTrackingError(400, 'InvalidGroupBy', 'groupBy must be day, week, project, user, or work-item.')
}
