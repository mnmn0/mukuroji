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
  describeHoldingRun,
  finishAgentRun,
  toAgentRun,
  type StoredAgentRun,
} from '../../modules/agent-runs'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import type { PublicAgentRunService } from '../../modules/developer-platform/public-api'
import { ProjectDataError } from '../../modules/directory'
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
 * @returns The run.
 */
async function requireOwnRun(
  principal: WorkspacePrincipal,
  teamId: string,
  runId: string,
  instanceIdHash: string,
): Promise<StoredAgentRun> {
  const run = await requireRun(principal, teamId, runId)
  if (run.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
  await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
  if (run.instanceIdHash !== instanceIdHash) {
    // Another instance of the same user must not keep alive or close a run it did not start.
    if (run.state !== 'active') throw createAgentRunNotActiveError()
    throw createAgentRunConflictError(describeHoldingRun(run, new Date()))
  }
  return run
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
                transactItems: [...store.createStartItems(run), ...(auditPut ? [auditPut] : [])],
                createReceipt: (workItem) => ({ status: 201, body: { run: toAgentRun(run, now), workItem } }),
                async classifyFailure(error) {
                  if (!isAgentRunFenceConflict(error)) return error
                  const latest = await store.getClaim(principal.directoryId, teamId, workItemId)
                  if (latest) return createHolderConflict(principal, teamId, latest.runId, new Date())
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
      const page = filters.state === 'active'
        ? await store.listActiveRuns(principal.directoryId, teamId, continuation, limit)
        : await store.listFinishedRuns(principal.directoryId, teamId, continuation, limit)
      const now = new Date()
      const items: AgentRun[] = []
      for (const run of page.runs) {
        if (filters.instanceIdHash !== undefined && run.instanceIdHash !== filters.instanceIdHash) continue
        if (filters.assigneeUserId !== undefined && run.assigneeUserId !== filters.assigneeUserId) continue
        let assignedProjectId: string | undefined
        try {
          const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
            principal.directoryId,
            teamId,
            run.workItemId,
            { consistentIssueRead: false, includeEvents: false },
          )
          assignedProjectId = detail.issue.assignedProjectId
        } catch (error) {
          // A deleted Work Item's runs are no longer visible to anyone.
          if (error instanceof ProjectDataError && error.status === 404) continue
          throw error
        }
        if (!canAccessAssignedProject(principal, permission, assignedProjectId, 'viewer')) continue
        items.push(toAgentRun(run, now))
      }
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
      const run = await requireOwnRun(principal, teamId, runId, instanceIdHash)
      if (run.state !== 'active') throw createAgentRunNotActiveError()
      const now = new Date()
      return toAgentRun(await workItemDependencies.agentRuns.heartbeat(run, instanceIdHash, now), now)
    },

    /** Rechecks ownership before a finish receipt replays. */
    async authorizeFinish(credential, teamId, runId, instanceIdHash) {
      const principal = await resolveWriter(credential, teamId)
      await requireOwnRun(principal, teamId, runId, instanceIdHash)
    },

    /** Closes the caller's own run and removes its claim. */
    async finish(credential, teamId, runId, { outcome, instanceIdHash }, context, idempotency) {
      const principal = await resolveWriter(credential, teamId)
      const run = await requireOwnRun(principal, teamId, runId, instanceIdHash)
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
        ...(auditPut ? [auditPut] : []),
        ...(receipt ? [receipt.transactWriteItem] : []),
      ], closeItems.length)
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
