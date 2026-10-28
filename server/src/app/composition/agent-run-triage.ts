import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { DynamoDbProjectDirectoryClient } from '../../modules/directory'
import {
  DynamoDbAgentRunStore,
  runAgentRunTriageSweep,
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

/**
 * Creates the scheduled handler that files failed and stalled Agent Runs to Triage. It throws after
 * a sweep that left items for the next run, so the failure reaches the Lambda error alarm.
 *
 * @returns Scheduled handler.
 */
export function createProductionAgentRunTriageHandler(): () => Promise<AgentRunTriageSweepResult> {
  const tableName = loadServerConfig().environment.AGENT_RUNS_TABLE_NAME?.trim()
  if (!tableName) throw new Error('Agent Run triage runtime is not configured.')
  const store = new DynamoDbAgentRunStore(createDynamoDbDocumentClient(createDynamoDbClient()), tableName)
  const workItems = createAgentRunTriageWorkItemReader(new DynamoDbTeamIssuesClient())
  const tenant = createProductionTenantAvailability()
  // The same live Team, Project, and owner checks as entries admitted through the API.
  const triageClient = new DynamoDbTriageClient({
    validateAdmission: createTriageAdmissionValidator(new DynamoDbProjectDirectoryClient(), new DynamoDbWorkspaceAccessClient()),
  })
  const triage = createAgentRunTriageFiler(triageClient, tenant)
  return async () => {
    const result = await runAgentRunTriageSweep({
      store,
      workItems,
      triage,
      now: new Date(),
      onError: (failure) => console.warn('Agent Run triage filing failed:', failure),
    })
    console.info('Agent Run triage sweep finished:', result)
    if (result.errors > 0) throw new Error(`Agent Run triage left ${result.errors} item(s) for the next sweep.`)
    return result
  }
}
