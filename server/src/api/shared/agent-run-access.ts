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
   * Builds the replay receipt from the public Work Item receipt.
   * @param workItem - Allowlisted public Work Item receipt.
   * @returns Exact status and body to replay.
   */
  createReceipt?(workItem: Record<string, unknown>): {
    /** Replayed HTTP status. */
    status: 200 | 201
    /** Replayed body. */
    body: unknown
  }
  /** Runs after the update committed; must not fail the committed update. */
  afterCommit?(): Promise<void>
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
    // An instance ID identifies an agent only together with the member it acts for.
    if (claim && (claim.instanceIdHash !== fence.instanceIdHash || claim.assigneeUserId !== principal.userKey)) {
      const holder = await store.getRun(principal.directoryId, teamId, claim.runId)
      if (!holder || holder.state !== 'active') throw createAgentRunIntegrityError()
      throw createAgentRunConflictError(describeHoldingRun(holder, now))
    }
    if (claim) {
      // The caller holds the claim without naming its run, so the claimed run is fenced like a named one.
      const held = await store.getRun(principal.directoryId, teamId, claim.runId)
      if (
        !held || held.state !== 'active' || held.workItemId !== workItemId ||
        held.instanceIdHash !== claim.instanceIdHash || held.assigneeUserId !== claim.assigneeUserId
      ) {
        throw createAgentRunIntegrityError()
      }
      return { run: held }
    }
    // An agent whose run a person released must stop even when it no longer sends the run ID. The
    // revocation is read consistently, and the transaction checks it again.
    if (await store.isInstanceRevoked(principal.directoryId, teamId, {
      workItemId,
      assigneeUserId: principal.userKey,
      instanceIdHash: fence.instanceIdHash ?? '',
    })) {
      throw createAgentRunNotActiveError()
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
 * Extends a run lease after a fenced mutation committed, never failing that mutation.
 *
 * @param run - Run that fenced the mutation, if the caller held one.
 * @param now - Time the mutation committed.
 */
async function extendLeaseBestEffort(run: StoredAgentRun | undefined, now: Date): Promise<void> {
  if (!run) return
  try {
    await workItemDependencies.agentRuns.extendLeaseAfterMutation(run, now)
  } catch (error) {
    console.error('Failed to extend an Agent Run lease after a fenced mutation.', {
      errorType: error instanceof Error ? error.name : 'unknown',
    })
  }
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
      const store = workItemDependencies.agentRuns
      const { run } = await resolveAgentRunFence(principal, teamId, workItemId, fence, now)
      return {
        // Lease state is only checked here; extending it after the commit with a newer-time
        // condition keeps a slow update from overwriting a later heartbeat.
        transactItems: store.createMutationFenceConditionChecks({
          directoryId: principal.directoryId,
          teamId,
          workItemId,
          instanceIdHash: fence.instanceIdHash ?? '',
          assigneeUserId: principal.userKey,
          ...(run ? { run } : {}),
          now,
        }),
        classifyFailure: (error) =>
          classifyAgentRunFenceFailure(principal, teamId, workItemId, fence, error, now),
        afterCommit: () => extendLeaseBestEffort(run, new Date()),
      }
    },
  }
}

/**
 * Audit sequence slot of an Agent Run event committed with a Work Item update or deletion.
 * Audit event IDs derive from the idempotency key and the slot, and the Work Item event uses slot 0.
 */
export const AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM = 1

/**
 * Builds an immutable audit event for an Agent Run lifecycle change.
 *
 * @param auditContext - Audit context of the logical mutation.
 * @param run - Run after the change.
 * @param action - Lifecycle action.
 * @param summary - Human-readable summary.
 * @param sequence - Audit sequence slot; pass {@link AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM} when another event shares the transaction.
 * @returns Audit put, or undefined when auditing is not configured.
 */
export function createAgentRunAuditPut(
  auditContext: MutationAuditContext,
  run: StoredAgentRun,
  action: 'started' | 'finished' | 'released',
  summary: string,
  sequence?: number,
): AgentRunTransactItem | undefined {
  return createMutationAuditEventPut(getConfiguredAuditTableName(), auditContext, {
    directoryId: run.directoryId,
    eventType: `agent-run.${action}`,
    entityType: 'agent-run',
    entityId: `team/${run.teamId}/agent-run/${run.runId}`,
    action,
    ...(sequence === undefined ? {} : { sequence }),
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
    assigneeUserId: principal.userKey,
    ...(run ? { run } : {}),
    now,
  }).flatMap((item) => item.ConditionCheck ? [{ ConditionCheck: item.ConditionCheck }] : [])
  return {
    conditionChecks,
    afterCommit: () => extendLeaseBestEffort(run, new Date()),
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
 * Builds the writes that release a Work Item's active run when the Work Item leaves active use, or
 * prove that no run holds it, for the same transaction as that Work Item write.
 *
 * @param principal - Authorized principal removing the Work Item.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item being deleted or archived.
 * @param auditContext - Audit context of the Work Item write.
 * @param now - Write time.
 * @param summary - Audit summary of the release.
 * @returns Writes committed with the Work Item write.
 */
export async function createAgentRunReleaseOnRemovalItems(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
  auditContext: MutationAuditContext,
  now: Date,
  summary: string,
): Promise<AgentRunTransactItem[]> {
  const store = workItemDependencies.agentRuns
  const claim = await store.getClaim(principal.directoryId, teamId, workItemId)
  if (!claim) return [store.createClaimAbsentCheck(principal.directoryId, teamId, workItemId)]
  const run = await store.getRun(principal.directoryId, teamId, claim.runId)
  if (!run || run.state !== 'active' || run.workItemId !== workItemId) throw createAgentRunIntegrityError()
  const released = finishAgentRun(run, 'released', principal.userKey, now)
  const auditPut = createAgentRunAuditPut(auditContext, released, 'released', summary, AGENT_RUN_AUDIT_SEQUENCE_WITH_WORK_ITEM)
  return [...store.createCloseItems(released), ...(auditPut ? [auditPut] : [])]
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
  const items = await createAgentRunReleaseOnRemovalItems(
    principal,
    teamId,
    workItemId,
    auditContext,
    now,
    'Agent Run was released because its Work Item was deleted.',
  )
  return items.map((transactWriteItem): NamedWorkItemDeletionFence => ({ kind: 'agent-runs', transactWriteItem }))
}
