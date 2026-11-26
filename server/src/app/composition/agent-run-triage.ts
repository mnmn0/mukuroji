import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import { createMutationAuditContext, createMutationAuditEventPut, getConfiguredAuditTableName } from '../../modules/audit'
import {
  DynamoDbAgentRunStore,
  createAgentRunNotificationMetadata,
  runAgentRunTriageSweep,
  type AgentRunStallNotifier,
  type AgentRunTriageFiler,
  type AgentRunTriageSweepResult,
  type AgentRunTriageWorkItemReader,
} from '../../modules/agent-runs'
import {
  DynamoDbTriageClient,
  TriageError,
  createTriageInputFingerprint,
  type CreateAgentRunTriageEntryInput,
  type TriageAuthorizationConditionChecks,
  type TriageIdempotency,
} from '../../modules/triage'
import { DynamoDbTeamIssuesClient, createTeamIssueDeepLink, isTeamIssueNotFoundError } from '../../modules/work-items'
import { DynamoDbWorkspaceAccessClient } from '../../modules/workspace-access'
import { createProductionTenantAvailability } from './tenant-administration'
import { createTriageAdmissionValidator } from './triage-admission'

/** Triage statuses that mean the entry input was refused, so filing it again cannot succeed. */
const refusedTriageStatuses = new Set([400, 403, 404, 422])

/**
 * Checks whether Triage refused an entry: its input is invalid, or the Team, Project, or a
 * configured owner it routes to is no longer active, which only an administrator can change.
 *
 * @param error - Error from the Triage client.
 * @returns True when filing again cannot succeed by itself.
 */
function isRefusedTriageEntry(error: unknown): error is TriageError {
  return error instanceof TriageError &&
    (refusedTriageStatuses.has(error.status) || (error.status === 409 && error.code.startsWith('TriageAdmission')))
}

/** Work Item read the sweep needs, which the Work Item client provides. */
export interface AgentRunTriageWorkItemSource {
  /**
   * Strongly reads one Work Item.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @param options - Read options.
   * @returns The Work Item.
   */
  getTeamIssueDetail(
    directoryId: string,
    teamId: string,
    workItemId: string,
    options: {
      /** Whether the Work Item is read with strong consistency. */
      consistentIssueRead: boolean
      /** Whether activity events are read. */
      includeEvents: boolean
    },
  ): Promise<{
    /** Work Item fields the entry shows. */
    issue: {
      /** Work Item title. */
      title: string
      /** Archive time; set for an archived Work Item. */
      archivedAt?: string
      /** Project the Work Item is assigned to, if any. */
      assignedProjectId?: string
    }
  }>
}

/**
 * Creates the Work Item reader of the sweep: archived and deleted Work Items read as missing.
 *
 * @param teamIssues - Work Item client.
 * @returns Reader of title and Web path.
 */
export function createAgentRunTriageWorkItemReader(
  teamIssues: AgentRunTriageWorkItemSource,
): AgentRunTriageWorkItemReader {
  return {
    /** Strongly reads a Work Item's title. */
    async read(directoryId, teamId, workItemId) {
      try {
        const { issue } = await teamIssues.getTeamIssueDetail(directoryId, teamId, workItemId, {
          consistentIssueRead: true,
          includeEvents: false,
        })
        if (issue.archivedAt !== undefined) return undefined
        return {
          title: issue.title,
          path: createTeamIssueDeepLink(teamId, workItemId),
          ...(issue.assignedProjectId === undefined ? {} : { projectId: issue.assignedProjectId }),
        }
      } catch (error) {
        if (isTeamIssueNotFoundError(error)) return undefined
        throw error
      }
    },
  }
}

/** Triage write the sweep needs, which the Triage client provides. */
export interface AgentRunTriageEntryWriter {
  /**
   * Creates or replays the entry of one run.
   * @param workspaceId - Workspace ID.
   * @param teamId - Team ID.
   * @param input - Entry content.
   * @param idempotency - Replay protection.
   * @param authorizationConditionChecks - Checks committed with the entry.
   * @returns Resolves once the entry exists.
   */
  createAgentRunEntry(
    workspaceId: string,
    teamId: string,
    input: CreateAgentRunTriageEntryInput,
    idempotency: TriageIdempotency,
    authorizationConditionChecks: TriageAuthorizationConditionChecks,
  ): Promise<unknown>
}

/** Workspace lifecycle the sweep checks before and while it files an entry. */
export interface AgentRunTriageTenant {
  /**
   * Checks whether the Workspace accepts new writes.
   * @param workspaceId - Workspace ID.
   * @returns True while the Workspace is active.
   */
  isActive(workspaceId: string): Promise<boolean>
  /**
   * Creates the condition that fails the entry's transaction when the Workspace started closing.
   * @param workspaceId - Workspace ID.
   * @returns Transaction condition check.
   */
  createActiveWriteCondition(workspaceId: string): TriageAuthorizationConditionChecks[number]
}

/**
 * Creates the Triage writer of the sweep. One idempotency key and fingerprint per run make every
 * repeat, including a failed finish after a stall was filed, a replay of the first filing. A
 * Workspace that is closing receives no entries, and an entry commits only while its Workspace is
 * still active.
 *
 * @param triage - Triage client.
 * @param tenant - Workspace lifecycle checks.
 * @returns Triage writer.
 */
export function createAgentRunTriageFiler(
  triage: AgentRunTriageEntryWriter,
  tenant: AgentRunTriageTenant,
): AgentRunTriageFiler {
  return {
    /** Files one entry, replaying an earlier filing of the same run. */
    async file(directoryId, teamId, filing) {
      if (!await tenant.isActive(directoryId)) return 'rejected'
      try {
        await triage.createAgentRunEntry(directoryId, teamId, filing, {
          // One entry per run: filing a run again for another reason replays its first entry.
          key: `agent-run:${filing.runId}`,
          fingerprint: createTriageInputFingerprint({ runId: filing.runId }),
        }, [tenant.createActiveWriteCondition(directoryId)])
        return 'filed'
      } catch (error) {
        if (!isRefusedTriageEntry(error)) throw error
        console.warn('Agent Run triage entry was refused:', { directoryId, teamId, runId: filing.runId, code: error.code })
        return 'rejected'
      }
    },
  }
}

/** Transaction write the stall notifier needs, which the DynamoDB document client provides. */
export interface AgentRunStallNotificationWriter {
  /**
   * Sends one transaction.
   * @param command - Transaction of the audit event and its Workspace condition.
   * @returns Resolves once the transaction commits.
   */
  send(command: TransactWriteCommand): Promise<unknown>
}

/** Route recorded as the source of the events the sweep writes. */
const sweepRoute = '/internal/agent-run-triage'

/**
 * Creates the notifier that tells a stalled run's assignee through an `agent-run.stalled` audit
 * event. The event ID derives from the run ID, so a retried sweep replays the first notification.
 * A Workspace that is closing receives none, and the event commits only while it is still active.
 *
 * @param writer - DynamoDB transaction writer.
 * @param tenant - Workspace lifecycle checks.
 * @param auditTableName - Audit table; without one, nothing is notified.
 * @returns Stall notifier.
 */
export function createAgentRunStallNotifier(
  writer: AgentRunStallNotificationWriter,
  tenant: AgentRunTriageTenant,
  auditTableName: string | undefined,
): AgentRunStallNotifier {
  return {
    /** Writes the stall event of one run once. */
    async notifyStalled(run, workItem) {
      if (!await tenant.isActive(run.directoryId)) return
      const context = createMutationAuditContext({
        workspaceId: run.directoryId,
        actor: { id: 'system:agent-run-triage', kind: 'system', displayName: 'Mukuroji Agent Run triage' },
        idempotencyKey: `agent-run-stalled:${run.teamId}:${run.runId}`,
        request: { method: 'SCHEDULE', path: sweepRoute, body: { teamId: run.teamId, runId: run.runId } },
        source: { kind: 'system', method: 'SCHEDULE', route: sweepRoute },
      })
      const auditPut = createMutationAuditEventPut(auditTableName, context, {
        directoryId: run.directoryId,
        eventType: 'agent-run.stalled',
        entityType: 'agent-run',
        entityId: `team/${run.teamId}/agent-run/${run.runId}`,
        action: 'stalled',
        summary: 'Agent Run stalled: its lease expired without a heartbeat.',
        changes: [],
        metadata: {
          adapter: 'agent-run',
          teamId: run.teamId,
          issueId: run.workItemId,
          deepLink: workItem.path,
          runId: run.runId,
          runtime: run.runtime,
          agentName: run.agentName,
          ...createAgentRunNotificationMetadata(run, {
            reason: 'agent-run-stalled',
            ...(workItem.projectId === undefined ? {} : { projectId: workItem.projectId }),
          }),
        },
      })
      if (!auditPut) return
      try {
        await writer.send(new TransactWriteCommand({
          TransactItems: [auditPut, tenant.createActiveWriteCondition(run.directoryId)],
        }))
      } catch (error) {
        const reasons = readCancellationCodes(error)
        // The event exists: an earlier sweep notified this run.
        if (reasons[0] === 'ConditionalCheckFailed') return
        // The Workspace started closing.
        if (reasons[1] === 'ConditionalCheckFailed') return
        throw error
      }
    },
  }
}

/**
 * Reads the cancellation reason codes of a cancelled DynamoDB transaction.
 *
 * @param error - Error from the transaction.
 * @returns One code per transaction item, or an empty list for another error.
 */
function readCancellationCodes(error: unknown): (string | undefined)[] {
  if (typeof error !== 'object' || error === null || !('name' in error) || error.name !== 'TransactionCanceledException') return []
  const reasons = 'CancellationReasons' in error ? error.CancellationReasons : undefined
  if (!Array.isArray(reasons)) return []
  return reasons.map((reason: unknown) =>
    typeof reason === 'object' && reason !== null && 'Code' in reason && typeof reason.Code === 'string' ? reason.Code : undefined)
}

/**
 * Creates the scheduled handler that files failed and stalled Agent Runs to Triage. It throws after
 * a sweep that left items for the next run, so the failure reaches the Lambda error alarm.
 *
 * @returns Scheduled handler.
 */
export function createProductionAgentRunTriageHandler(): () => Promise<AgentRunTriageSweepResult> {
  const tableName = loadServerConfig().environment.AGENT_RUNS_TABLE_NAME?.trim()
  if (!tableName) throw new Error('Agent Run triage runtime is not configured.')
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const store = new DynamoDbAgentRunStore(documentClient, tableName)
  const workItems = createAgentRunTriageWorkItemReader(new DynamoDbTeamIssuesClient())
  const tenant = createProductionTenantAvailability()
  // The same live Team, Project, and owner checks as entries admitted through the API.
  const triageClient = new DynamoDbTriageClient({
    validateAdmission: createTriageAdmissionValidator(new DynamoDbProjectDirectoryClient(), new DynamoDbWorkspaceAccessClient()),
  })
  const triage = createAgentRunTriageFiler(triageClient, tenant)
  const notifier = createAgentRunStallNotifier(documentClient, tenant, getConfiguredAuditTableName())
  return async () => {
    const result = await runAgentRunTriageSweep({
      store,
      workItems,
      triage,
      notifier,
      now: new Date(),
      onError: (failure) => console.warn('Agent Run triage filing failed:', failure),
    })
    console.info('Agent Run triage sweep finished:', result)
    if (result.errors > 0) throw new Error(`Agent Run triage left ${result.errors} item(s) for the next sweep.`)
    return result
  }
}
