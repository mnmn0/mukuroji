import {
  DEFAULT_WORK_ITEM_TYPE_ID,
  type AgentRun,
} from '@mukuroji/contracts'
import {
  AgentRunError,
  createActiveAgentRun,
  createAgentRunConflictError,
  createAgentRunForbiddenError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
  createAgentRunTakeoverDisabledError,
  describeHoldingRun,
  finishAgentRun,
  isAgentRunStalled,
  toAgentRun,
  type StoredAgentRun,
} from '../../modules/agent-runs'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import type { PublicAgentRunService } from '../../modules/developer-platform/public-api'
import { ProjectDataError } from '../../modules/directory'
import { createWorkItemRevisionConditionCheck } from '../../modules/work-items/adapter-out/dynamodb/work-item-client'
import { resolveWorkItemTypeWorkflow } from '../../modules/work-items/work-item-configuration'
import {
  AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
  createAgentRunAuditPut,
  isAgentRunFenceConflict,
} from '../shared/agent-run-access'
import { workItemDependencies } from '../shared/app-dependencies'
import { resolveDeveloperCredentialPrincipal } from '../shared/developer-platform-access'
import {
  canAccessAssignedProject,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import {
  createWorkItemIdempotencyTransaction,
  getTeamIssuesTableName,
  loadAuthorizedTeamIssue,
} from '../shared/work-item-access'
import { createMutationAuditContext } from '../../modules/audit/audit'
import { projectPublicWorkItem, updateCanonicalPublicWorkItem } from './public-api-routes'

/**
 * Resolves the credential owner for an Agent Run read.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team ID.
 * @returns Authorized principal.
 */
async function resolveReader(credential: AuthenticatedDeveloperCredential, teamId: string): Promise<WorkspacePrincipal> {
  return resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.read',
    teamId,
    evaluateProjectScopes: true,
  })
}

/**
 * Resolves the credential owner for an Agent Run write.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team ID.
 * @returns Authorized principal with business write access.
 */
async function resolveWriter(credential: AuthenticatedDeveloperCredential, teamId: string): Promise<WorkspacePrincipal> {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.write',
    teamId,
    evaluateProjectScopes: true,
  })
  requireWorkspaceBusinessWrite(principal)
  return principal
}

/**
 * Loads a run that exists in the Team.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @param runId - Run ID.
 * @returns The run.
 */
async function requireRun(principal: WorkspacePrincipal, teamId: string, runId: string): Promise<StoredAgentRun> {
  const run = await workItemDependencies.agentRuns.getRun(principal.directoryId, teamId, runId)
  if (!run) throw new AgentRunError('not_found', 'Agent Run was not found.')
  return run
}

/**
 * Loads the caller's own run after rechecking access to its Work Item and the instance that started it.
 *
 * @param principal - Authorized writer.
 * @param teamId - Team ID.
 * @param runId - Run ID.
 * @param instanceIdHash - Hash of the instance ID the caller sent.
 * @returns The run and the revision of its Work Item that was read.
 */
async function requireOwnRun(
  principal: WorkspacePrincipal,
  teamId: string,
  runId: string,
  instanceIdHash: string,
): Promise<{
  /** Caller's run. */
  run: StoredAgentRun
  /** Current assignee of the run's Work Item. */
  workItemAssigneeUserId: string
  /** Revision of the run's Work Item that was read. */
  workItemRevision: number
}> {
  const run = await requireRun(principal, teamId, runId)
  if (run.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
  const { detail } = await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
  if (run.instanceIdHash !== instanceIdHash) {
    // Another instance of the same user must not keep alive or close a run it did not start.
    if (run.state !== 'active') throw createAgentRunNotActiveError()
    throw createAgentRunConflictError(describeHoldingRun(run, new Date()))
  }
  return { run, workItemAssigneeUserId: detail.issue.assigneeUserId, workItemRevision: detail.issue.revision }
}

/**
 * Strongly reads the run that claims a Work Item.
 *
 * A finish, release, or take over can commit between the claim read and the run read, so a claim
 * whose run is no longer active is read once more; only a claim that still names it is inconsistent.
 *
 * @param principal - Authorized reader.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The claiming active run, or undefined when no run claims the Work Item.
 */
async function readClaimedRun(principal: WorkspacePrincipal, teamId: string, workItemId: string): Promise<StoredAgentRun | undefined> {
  const store = workItemDependencies.agentRuns
  let previousRunId: string | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
    if (!claim) return undefined
    const run = await store.getRun(principal.directoryId, teamId, claim.runId)
    if (run?.state === 'active' && run.workItemId === workItemId) {
      // An active run must be the holder the claim records; a mismatch is not a race.
      if (run.instanceIdHash !== claim.instanceIdHash || run.assigneeUserId !== claim.assigneeUserId) break
      return run
    }
    if (claim.runId === previousRunId) break
    previousRunId = claim.runId
  }
  throw createAgentRunIntegrityError()
}

/**
 * Reports that another run holds a Work Item, failing closed when the claim is inconsistent.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @param runId - Holding run named by the claim.
 * @param now - Read time.
 * @returns Conflict error.
 */
async function createHolderConflict(principal: WorkspacePrincipal, teamId: string, runId: string, now: Date): Promise<AgentRunError> {
  const holder = await workItemDependencies.agentRuns.getRun(principal.directoryId, teamId, runId)
  if (!holder || holder.state !== 'active') return createAgentRunIntegrityError()
  return createAgentRunConflictError(describeHoldingRun(holder, now))
}

/** Concurrent reads per run listing page. */
const listReadConcurrency = 10

/**
 * Maps values with at most a fixed number of concurrent calls, keeping the input order.
 *
 * @param values - Values to map.
 * @param concurrency - Largest number of calls in flight.
 * @param map - Asynchronous mapping.
 * @returns Mapped values in input order.
 */
async function mapInOrderWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < values.length; index += concurrency) {
    results.push(...await Promise.all(values.slice(index, index + concurrency).map(map)))
  }
  return results
}

/**
 * Reads the Project a Work Item is assigned to from the committed Work Item, so a move to another
 * Project or a deletion takes effect immediately.
 *
 * @param principal - Authorized reader.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @returns The assigned Project, undefined when unassigned, or null when the Work Item was deleted.
 */
async function readAssignedProjectId(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<string | undefined | null> {
  try {
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      principal.directoryId,
      teamId,
      workItemId,
      { consistentIssueRead: true, includeEvents: false },
    )
    return detail.issue.assignedProjectId
  } catch (error) {
    // A deleted Work Item's runs are no longer visible to anyone.
    if (error instanceof ProjectDataError && error.status === 404) return null
    throw error
  }
}

/**
 * Creates the Public API Agent Run service backed by canonical Work Items and the Agent Run store.
 *
 * @returns Agent Run service.
 */
export function createCanonicalPublicAgentRunService(): PublicAgentRunService {
  return {
    /** Rechecks that the caller can still write the Work Item before a start receipt replays. */
    async authorizeStart(credential, teamId, workItemId) {
      const principal = await resolveWriter(credential, teamId)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    },

    /** Moves the Work Item to started and claims it in one transaction. */
    async start(credential, teamId, workItemId, input, context, idempotency) {
      let started: StoredAgentRun | undefined
      let startedAt = new Date()
      const { issue } = await updateCanonicalPublicWorkItem(
        credential,
        teamId,
        workItemId,
        { expectedRevision: input.expectedRevision, workflowStatusId: input.workflowStatusId },
        context,
        idempotency,
        {
          auditRequest: {
            method: 'POST',
            path: `/api/v1/work-items/${encodeURIComponent(workItemId)}/agent-runs`,
            query: { teamId },
            body: {
              expectedRevision: input.expectedRevision,
              workflowStatusId: input.workflowStatusId,
              runtime: input.runtime,
              agentName: input.agentName,
            },
          },
          extension: {
            async prepare({ principal, issue: current, resolvedConfiguration, auditContext, now }) {
              if (current.revision !== input.expectedRevision) {
                throw new ProjectDataError(409, 'WorkItemRevisionConflict', 'Work Item revision does not match the expected revision.')
              }
              if (current.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
              const workflow = resolveWorkItemTypeWorkflow(
                resolvedConfiguration.configuration,
                current.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
              )
              const target = workflow.statuses.find((status) => status.id === input.workflowStatusId)
              if (
                (current.statusCategory !== 'backlog' && current.statusCategory !== 'unstarted') ||
                target?.category !== 'started'
              ) {
                throw new AgentRunError(
                  'conflict',
                  'An Agent Run starts only from a backlog or unstarted status into a started status.',
                  { reason: 'invalid_transition', pointer: '/workflowStatusId' },
                )
              }
              const store = workItemDependencies.agentRuns
              const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
              if (claim) throw await createHolderConflict(principal, teamId, claim.runId, now)
              const settings = await store.getSettings(principal.directoryId, teamId)
              const run = createActiveAgentRun({
                directoryId: principal.directoryId,
                teamId,
                workItemId,
                assigneeUserId: principal.userKey,
                start: input,
                credentialId: credential.credentialId,
                startRevision: current.revision + 1,
                leaseMinutes: settings.leaseMinutes,
                now,
              })
              started = run
              startedAt = now
              const auditPut = createAgentRunAuditPut(
                auditContext, run, 'started', 'Agent Run started.', AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
              )
              return {
                transactItems: [
                  ...store.createStartItems(run),
                  // The lease length is fixed for the run, so settings saved meanwhile must not be missed.
                  store.createSettingsRevisionCheck(principal.directoryId, teamId, settings.revision),
                  ...(auditPut ? [auditPut] : []),
                ],
                createReceipt: (workItem) => ({ status: 201, body: { run: toAgentRun(run, now), workItem } }),
                async classifyFailure(error) {
                  if (!isAgentRunFenceConflict(error)) return error
                  const latest = await store.getClaim(principal.directoryId, teamId, workItemId)
                  if (latest) return createHolderConflict(principal, teamId, latest.runId, new Date())
                  const latestSettings = await store.getSettings(principal.directoryId, teamId)
                  if (latestSettings.revision !== settings.revision) {
                    return new AgentRunError('conflict', 'Agent settings changed during the request. Retry the start.')
                  }
                  return new AgentRunError('conflict', 'The Agent Run claim changed during the request. Reload the task and retry.')
                },
              }
            },
          },
        },
      )
      if (!started) throw new Error('The Agent Run start transaction committed without a run.')
      return { run: toAgentRun(started, startedAt), workItem: projectPublicWorkItem(issue) }
    },

    /** Lists one Work Item's runs after checking that the caller can see it. */
    async listWorkItemRuns(credential, teamId, workItemId, continuation, limit) {
      const principal = await resolveReader(credential, teamId)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      const page = await workItemDependencies.agentRuns.listWorkItemRuns(principal.directoryId, teamId, workItemId, continuation, limit)
      const now = new Date()
      return {
        items: page.runs.map((run) => toAgentRun(run, now)),
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextContinuation: page.nextCursor }),
      }
    },

    /** Lists a Team's runs, keeping only runs whose Work Item the caller can see. */
    async list(credential, teamId, filters, continuation, limit) {
      const principal = await resolveReader(credential, teamId)
      const permission = await requireTeamPermission(principal, teamId, 'viewer')
      const store = workItemDependencies.agentRuns
      const now = new Date()
      if (filters.workItemId !== undefined) {
        // The claim row is read strongly, so a run started moments ago is found before the index has it.
        const assignedProjectId = await readAssignedProjectId(principal, teamId, filters.workItemId)
        if (assignedProjectId === null || !canAccessAssignedProject(principal, permission, assignedProjectId, 'viewer')) {
          return { items: [], hasMore: false }
        }
        const run = await readClaimedRun(principal, teamId, filters.workItemId)
        const matches = run !== undefined &&
          (filters.instanceIdHash === undefined || run.instanceIdHash === filters.instanceIdHash) &&
          (filters.assigneeUserId === undefined || run.assigneeUserId === filters.assigneeUserId)
        return { items: matches ? [toAgentRun(run, now)] : [], hasMore: false }
      }
      const page = filters.state === 'active'
        ? await store.listActiveRuns(principal.directoryId, teamId, continuation, limit)
        : await store.listFinishedRuns(principal.directoryId, teamId, continuation, limit)
      const candidates = page.runs.filter((run) =>
        (filters.instanceIdHash === undefined || run.instanceIdHash === filters.instanceIdHash) &&
        (filters.assigneeUserId === undefined || run.assigneeUserId === filters.assigneeUserId))
      const visible = await mapInOrderWithConcurrency(candidates, listReadConcurrency, async (indexed) => {
        // The indexes can still show a run's state from before it closed, so the run is read again.
        const [run, assignedProjectId] = await Promise.all([
          store.getRun(principal.directoryId, teamId, indexed.runId),
          readAssignedProjectId(principal, teamId, indexed.workItemId),
        ])
        if (!run || run.state !== filters.state || assignedProjectId === null) return undefined
        return canAccessAssignedProject(principal, permission, assignedProjectId, 'viewer') ? run : undefined
      })
      const items: AgentRun[] = visible.flatMap((run) => run ? [toAgentRun(run, now)] : [])
      return {
        items,
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextContinuation: page.nextCursor }),
      }
    },

    /** Reads one run after checking that the caller can see its Work Item. */
    async get(credential, teamId, runId) {
      const principal = await resolveReader(credential, teamId)
      const run = await requireRun(principal, teamId, runId)
      await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'viewer')
      return toAgentRun(run, new Date())
    },

    /** Extends the caller's own lease. */
    async heartbeat(credential, teamId, runId, instanceIdHash) {
      const principal = await resolveWriter(credential, teamId)
      const { run, workItemAssigneeUserId, workItemRevision } = await requireOwnRun(principal, teamId, runId, instanceIdHash)
      if (run.state !== 'active') throw createAgentRunNotActiveError()
      // A member who is no longer responsible for the Work Item cannot keep its claim alive; finishing stays allowed.
      if (workItemAssigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      const now = new Date()
      return toAgentRun(await workItemDependencies.agentRuns.heartbeat(run, instanceIdHash, now, [
        createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, run.workItemId, workItemRevision),
      ]), now)
    },

    /** Rechecks ownership before a finish receipt replays. */
    async authorizeFinish(credential, teamId, runId, instanceIdHash) {
      const principal = await resolveWriter(credential, teamId)
      await requireOwnRun(principal, teamId, runId, instanceIdHash)
    },

    /** Closes the caller's own run and removes its claim. */
    async finish(credential, teamId, runId, { outcome, instanceIdHash }, context, idempotency) {
      const principal = await resolveWriter(credential, teamId)
      const { run, workItemRevision } = await requireOwnRun(principal, teamId, runId, instanceIdHash)
      const now = new Date()
      if (run.state !== 'active') {
        if (run.outcome === outcome && run.finishedBy === 'agent') return toAgentRun(run, now)
        throw createAgentRunNotActiveError()
      }
      const finished = finishAgentRun(run, outcome, 'agent', now)
      const auditContext = createMutationAuditContext({
        workspaceId: principal.directoryId,
        actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
        idempotencyKey: context.idempotencyKey,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        request: {
          method: 'POST',
          path: `/api/v1/agent-runs/${encodeURIComponent(runId)}/finish`,
          // The instance ID is a bearer-like secret of the agent; only the outcome is audited.
          body: { outcome },
        },
        source: {
          kind: 'api',
          requestId: context.requestId,
          method: 'POST',
          route: `/api/v1/agent-runs/${encodeURIComponent(runId)}/finish`,
        },
      })
      const response = toAgentRun(finished, now)
      const auditPut = createAgentRunAuditPut(auditContext, finished, 'finished', `Agent Run finished as ${outcome}.`)
      const receipt = await createWorkItemIdempotencyTransaction(principal.directoryId, idempotency)
        ?.prepare({ status: 200, body: response })
      const store = workItemDependencies.agentRuns
      const closeItems = store.createCloseItems(finished, instanceIdHash)
      await store.commit([
        ...closeItems,
        // The finish was authorized against this Work Item state; a concurrent move out of the
        // credential's scope must win.
        createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, run.workItemId, workItemRevision),
        ...(auditPut ? [auditPut] : []),
        ...(receipt ? [receipt.transactWriteItem] : []),
      ], closeItems.length)
      return response
    },

    /** Rechecks permissions before a take over receipt replays. */
    async authorizeTakeOver(credential, teamId, workItemId) {
      const principal = await resolveWriter(credential, teamId)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    },

    /** Supersedes a stalled run of another instance and claims the Work Item for the caller in one transaction. */
    async takeOver(credential, teamId, workItemId, runId, input, context, idempotency) {
      const principal = await resolveWriter(credential, teamId)
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
      if (detail.issue.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      const store = workItemDependencies.agentRuns
      const settings = await store.getSettings(principal.directoryId, teamId)
      if (!settings.allowTakeoverAfterLeaseExpiry) throw createAgentRunTakeoverDisabledError()
      if (detail.issue.statusCategory !== 'started') {
        throw new AgentRunError('conflict', 'Only a run on a started Work Item can be taken over. Ask a person to release it.', {
          reason: 'invalid_transition',
        })
      }
      const run = await requireRun(principal, teamId, runId)
      if (run.workItemId !== workItemId || run.state !== 'active') throw createAgentRunNotActiveError()
      // Only another instance of the same member may take over; other members' runs need a person to release them.
      if (run.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
      if (run.instanceIdHash === input.instanceIdHash) {
        throw new AgentRunError('conflict', 'This instance already holds the run. Continue it instead of taking it over.', {
          reason: 'agent_run_conflict', pointer: '/instanceId',
        })
      }
      const now = new Date()
      if (!isAgentRunStalled(run, now)) throw createAgentRunConflictError(describeHoldingRun(run, now), '/instanceId')
      const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
      if (claim?.runId !== run.runId) throw createAgentRunIntegrityError()
      const superseded = finishAgentRun(run, 'superseded', principal.userKey, now)
      const successor = createActiveAgentRun({
        directoryId: principal.directoryId,
        teamId,
        workItemId,
        assigneeUserId: principal.userKey,
        start: input,
        credentialId: credential.credentialId,
        startRevision: detail.issue.revision,
        leaseMinutes: settings.leaseMinutes,
        now,
      })
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/agent-runs/${encodeURIComponent(runId)}/take-over`
      const auditContext = createMutationAuditContext({
        workspaceId: principal.directoryId,
        actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
        idempotencyKey: context.idempotencyKey,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        // The instance ID is a bearer-like secret of the agent; only its runtime and name are audited.
        request: { method: 'POST', path, body: { runtime: input.runtime, agentName: input.agentName } },
        source: { kind: 'api', requestId: context.requestId, method: 'POST', route: path },
      })
      const response = { run: toAgentRun(successor, now), supersededRun: toAgentRun(superseded, now) }
      const supersededAudit = createAgentRunAuditPut(auditContext, superseded, 'taken-over', 'Agent Run was taken over by another instance.')
      const startedAudit = createAgentRunAuditPut(
        auditContext, successor, 'started', 'Agent Run took over a stalled run.', AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM,
      )
      const receipt = await createWorkItemIdempotencyTransaction(principal.directoryId, idempotency)
        ?.prepare({ status: 201, body: response })
      const takeOverItems = store.createTakeOverItems(superseded, successor)
      try {
        await store.commit([
          ...takeOverItems,
          // The take over was authorized against this assignment and these settings.
          createWorkItemRevisionConditionCheck(getTeamIssuesTableName(), principal.directoryId, teamId, workItemId, detail.issue.revision),
          store.createSettingsRevisionCheck(principal.directoryId, teamId, settings.revision),
          ...(supersededAudit ? [supersededAudit] : []),
          ...(startedAudit ? [startedAudit] : []),
          ...(receipt ? [receipt.transactWriteItem] : []),
        ], 2)
      } catch (error) {
        if (!(error instanceof AgentRunError) || error.reason !== 'agent_run_not_active') throw error
        // The stalled run changed first: it renewed its lease, or it was finished or taken over.
        const latest = await store.getRun(principal.directoryId, teamId, runId)
        const readAt = new Date()
        if (latest?.state === 'active' && !isAgentRunStalled(latest, readAt)) {
          throw createAgentRunConflictError(describeHoldingRun(latest, readAt), '/instanceId')
        }
        throw createAgentRunNotActiveError()
      }
      return response
    },

    /** Reads Team Agent settings for a Team the caller can see. */
    async getSettings(credential, teamId) {
      const principal = await resolveReader(credential, teamId)
      await requireTeamPermission(principal, teamId, 'viewer')
      return workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId)
    },
  }
}
