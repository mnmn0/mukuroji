import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import {
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from '../../modules/audit/audit'
import {
  CollaborationError,
  type CollaborationAuthorizationConditionCheck,
} from '../../modules/collaboration/collaboration'
import {
  AgentRunError,
  createAgentRunConflictError,
  createAgentRunForbiddenError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
  describeHoldingRun,
  finishAgentRun,
  type AgentRunTransactItem,
  type StoredAgentRun,
  type ValidatedAgentRunFence,
} from '../../modules/agent-runs'
import { ProjectDataError } from '../../modules/directory'
import {
  createTeamIssueAuditEntityId,
  createTeamIssueDeepLink,
  type NamedWorkItemDeletionFence,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import { workItemDependencies } from './app-dependencies'
import type { WorkspacePrincipal } from './project-access'

/** Context passed to an extension after the Work Item update was authorized and validated. */
export type PublicWorkItemUpdateExtensionContext = {
  /** Authorized principal of the credential owner. */
  principal: WorkspacePrincipal
  /** Strongly read Work Item before the update. */
  issue: TeamIssueResponseItem
  /** Team configuration used to validate the update. */
  resolvedConfiguration: ResolvedWorkItemConfiguration
  /** Audit context shared by every event of the logical mutation. */
  auditContext: MutationAuditContext
  /** Mutation time. */
  now: Date
}

/** Writes and hooks an extension contributes to one Work Item update transaction. */
export type PreparedPublicWorkItemUpdateExtension = {
  /** Writes committed atomically with the Work Item update. */
  transactItems: AgentRunTransactItem[]
  /**
   * Builds the replay receipt body from the public Work Item receipt.
   * @param workItem - Allowlisted public Work Item receipt.
   * @returns Exact response body to replay.
   */
  createReceiptBody?(workItem: Record<string, unknown>): unknown
  /**
   * Translates a failed update into the precise error to report.
   * @param error - Error raised by the update.
   * @returns The error to throw.
   */
  classifyFailure(error: unknown): Promise<unknown>
}

/** Agent Run behavior attached to a public Work Item update. */
export type PublicWorkItemUpdateExtension = {
  /**
   * Validates Agent Run state and returns the writes to commit with the update.
   * @param context - Authorized update context.
   * @returns Prepared writes and hooks.
   */
  prepare(context: PublicWorkItemUpdateExtensionContext): Promise<PreparedPublicWorkItemUpdateExtension>
}

/** Fence state read before a mutation, reused to build writes and classify failures. */
export type AgentRunFenceResolution = {
  /** Active run the caller holds, when it sent one. */
  run?: StoredAgentRun
}

/**
 * Checks whether an error is the Work Item adapter's Agent Run fence conflict.
 *
 * @param error - Thrown value.
 * @returns True for an Agent Run fence conflict.
 */
export function isAgentRunFenceConflict(error: unknown): boolean {
  return error instanceof ProjectDataError && error.code === 'AgentRunFenceConflict'
}

/**
 * Verifies the caller's fence against current run and claim rows before a mutation.
 *
 * @param principal - Authorized principal of the credential owner.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Mutated Work Item.
 * @param fence - Validated fence from the request.
 * @param now - Mutation time.
 * @returns The caller's run when it holds one.
 */
export async function resolveAgentRunFence(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  fence: ValidatedAgentRunFence,
  now: Date,
): Promise<AgentRunFenceResolution> {
  const store = workItemDependencies.agentRuns
  const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
  if (fence.agentRunId === undefined) {
    if (claim && claim.instanceIdHash !== fence.instanceIdHash) {
      const holder = await store.getRun(principal.directoryId, teamId, claim.runId)
      if (!holder || holder.state !== 'active') throw createAgentRunIntegrityError()
      throw createAgentRunConflictError(describeHoldingRun(holder, now))
    }
    return {}
  }
  const run = await store.getRun(principal.directoryId, teamId, fence.agentRunId)
  if (!run || run.workItemId !== workItemId || run.state !== 'active') throw createAgentRunNotActiveError()
  if (run.assigneeUserId !== principal.userKey) throw createAgentRunForbiddenError()
  if (run.instanceIdHash !== fence.instanceIdHash) throw createAgentRunNotActiveError()
  if (!claim) throw createAgentRunIntegrityError()
  if (claim.runId !== run.runId) {
    const holder = await store.getRun(principal.directoryId, teamId, claim.runId)
    if (!holder || holder.state !== 'active') throw createAgentRunIntegrityError()
    throw createAgentRunNotActiveError()
  }
  return { run }
}

/**
 * Re-reads run and claim rows after a fenced write failed and reports the precise reason.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Mutated Work Item.
 * @param fence - Validated fence from the request.
 * @param error - Error raised by the write.
 * @param now - Classification time.
 * @returns The error to throw.
 */
export async function classifyAgentRunFenceFailure(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  fence: ValidatedAgentRunFence,
  error: unknown,
  now: Date,
): Promise<unknown> {
  if (!isAgentRunFenceConflict(error)) return error
  try {
    await resolveAgentRunFence(principal, teamId, workItemId, fence, now)
  } catch (classified) {
    return classified
  }
  return new AgentRunError('conflict', 'The Agent Run claim changed during the request. Reload the task and retry.')
}

/**
 * Creates the extension that fences a public Work Item update with the caller's run.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Mutated Work Item.
 * @param fence - Validated fence from the request.
 * @returns Update extension.
 */
export function createAgentRunMutationFenceExtension(
  teamId: string,
  workItemId: string,
  fence: ValidatedAgentRunFence,
): PublicWorkItemUpdateExtension {
  return {
    async prepare({ principal, now }) {
      const { run } = await resolveAgentRunFence(principal, teamId, workItemId, fence, now)
      return {
        transactItems: workItemDependencies.agentRuns.createMutationFenceItems({
          directoryId: principal.directoryId,
          teamId,
          workItemId,
          instanceIdHash: fence.instanceIdHash ?? '',
          ...(run ? { run } : {}),
          now,
        }),
        classifyFailure: (error) =>
          classifyAgentRunFenceFailure(principal, teamId, workItemId, fence, error, now),
      }
    },
  }
}

/**
 * Builds an immutable audit event for an Agent Run lifecycle change.
 *
 * @param auditContext - Audit context of the logical mutation.
 * @param run - Run after the change.
 * @param action - Lifecycle action.
 * @param summary - Human-readable summary.
 * @returns Audit put, or undefined when auditing is not configured.
 */
export function createAgentRunAuditPut(
  auditContext: MutationAuditContext,
  run: StoredAgentRun,
  action: 'started' | 'finished' | 'released',
  summary: string,
): AgentRunTransactItem | undefined {
  return createMutationAuditEventPut(getConfiguredAuditTableName(), auditContext, {
    directoryId: run.directoryId,
    eventType: `agent-run.${action}`,
    entityType: 'agent-run',
    entityId: `team/${run.teamId}/agent-run/${run.runId}`,
    action,
    summary,
    changes: [],
    metadata: {
      adapter: 'agent-run',
      teamId: run.teamId,
      issueId: run.workItemId,
      workItemEntityId: createTeamIssueAuditEntityId(run.teamId, run.workItemId),
      deepLink: createTeamIssueDeepLink(run.teamId, run.workItemId),
      runId: run.runId,
      runtime: run.runtime,
      agentName: run.agentName,
      state: run.state,
      ...(run.outcome ? { outcome: run.outcome } : {}),
    },
  })
}

/** Condition checks and hooks that fence a comment written by an agent. */
export type PreparedAgentRunCommentFence = {
  /** Condition checks committed with the comment. */
  conditionChecks: CollaborationAuthorizationConditionCheck[]
  /** Extends the run lease after the comment committed; never fails the comment. */
  afterCommit(): Promise<void>
  /**
   * Translates a failed comment write into the precise error to report.
   * @param error - Error raised by the comment write.
   * @returns The error to throw.
   */
  classifyFailure(error: unknown): Promise<unknown>
}

/**
 * Prepares the fence for a comment written by an agent.
 *
 * The comment writer accepts only ConditionCheck items, so the lease is extended after the commit.
 *
 * @param principal - Authorized principal of the credential owner.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Commented Work Item.
 * @param fence - Validated fence from the request.
 * @param now - Mutation time.
 * @returns Condition checks and hooks.
 */
export async function prepareAgentRunCommentFence(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  fence: ValidatedAgentRunFence,
  now: Date,
): Promise<PreparedAgentRunCommentFence> {
  const store = workItemDependencies.agentRuns
  const { run } = await resolveAgentRunFence(principal, teamId, workItemId, fence, now)
  const conditionChecks = store.createMutationFenceConditionChecks({
    directoryId: principal.directoryId,
    teamId,
    workItemId,
    instanceIdHash: fence.instanceIdHash ?? '',
    ...(run ? { run } : {}),
    now,
  }).flatMap((item) => item.ConditionCheck ? [{ ConditionCheck: item.ConditionCheck }] : [])
  return {
    conditionChecks,
    async afterCommit() {
      if (!run) return
      try {
        await store.extendLeaseAfterMutation(run, now)
      } catch (error) {
        console.error('Failed to extend an Agent Run lease after a comment.', {
          errorType: error instanceof Error ? error.name : 'unknown',
        })
      }
    },
    async classifyFailure(error) {
      if (!(error instanceof CollaborationError) || error.code !== 'CollaborationAuthorizationChanged') return error
      try {
        await resolveAgentRunFence(principal, teamId, workItemId, fence, new Date())
      } catch (classified) {
        return classified
      }
      return error
    },
  }
}

/**
 * Builds the deletion fences that release a Work Item's active run, or prove that none exists.
 *
 * @param principal - Authorized principal deleting the Work Item.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Deleted Work Item.
 * @param auditContext - Audit context of the deletion.
 * @param now - Deletion time.
 * @returns Named fences committed with the deletion.
 */
export async function createAgentRunDeletionFences(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  auditContext: MutationAuditContext,
  now: Date,
): Promise<NamedWorkItemDeletionFence[]> {
  const store = workItemDependencies.agentRuns
  const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
  if (!claim) {
    return [{
      kind: 'agent-runs',
      transactWriteItem: store.createClaimAbsentCheck(principal.directoryId, teamId, workItemId),
    }]
  }
  const run = await store.getRun(principal.directoryId, teamId, claim.runId)
  if (!run || run.state !== 'active' || run.workItemId !== workItemId) throw createAgentRunIntegrityError()
  const released = finishAgentRun(run, 'released', principal.userKey, now)
  const auditPut = createAgentRunAuditPut(
    auditContext,
    released,
    'released',
    'Agent Run was released because its Work Item was deleted.',
  )
  return [
    ...store.createCloseItems(released),
    ...(auditPut ? [auditPut] : []),
  ].map((transactWriteItem) => ({ kind: 'agent-runs' as const, transactWriteItem }))
}
