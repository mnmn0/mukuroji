import { createDynamoDbClient, createDynamoDbDocumentClient } from '../../infrastructure/aws/dynamodb-client'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import {
  DynamoDbAgentRunStore,
  DynamoDbAgentRunUsageStore,
  runAgentAnalyticsDailyExport,
  type AgentAnalyticsDailyExportResult,
} from '../../modules/agent-runs'
import { DynamoDbTeamIssuesClient, isTeamIssueNotFoundError } from '../../modules/work-items'
import { createAgentTelemetryAnalyticsSink } from './agent-telemetry-analytics'
import { createProductionTenantAvailability } from './tenant-administration'

/**
 * Creates the daily export of run state and Work Item values to the S3 analytics store (ADR 0118).
 * A deployment without the analytics streams exports nothing.
 *
 * @returns Entrypoint of one export.
 */
export function createProductionAgentAnalyticsExportHandler(): () => Promise<AgentAnalyticsDailyExportResult> {
  const environment = loadServerConfig().environment
  const tableName = environment.AGENT_RUNS_TABLE_NAME?.trim()
  if (!tableName) throw new Error('Agent analytics export runtime is not configured.')
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const runs = new DynamoDbAgentRunStore(documentClient, tableName)
  const usage = new DynamoDbAgentRunUsageStore(documentClient, tableName)
  const teamIssues = new DynamoDbTeamIssuesClient()
  const tenant = createProductionTenantAvailability()
  const sink = createAgentTelemetryAnalyticsSink(environment)
  return async () => {
    const result = await runAgentAnalyticsDailyExport({
      usage,
      readRun: (directoryId, teamId, runId) => runs.getRun(directoryId, teamId, runId),
      async readWorkItem(directoryId, teamId, workItemId) {
        try {
          const { issue } = await teamIssues.getTeamIssueDetail(directoryId, teamId, workItemId, {
            consistentIssueRead: false,
            includeEvents: false,
          })
          return issue
        } catch (error) {
          if (isTeamIssueNotFoundError(error)) return undefined
          throw error
        }
      },
      isWorkspaceActive: (workspaceId) => tenant.isActive(workspaceId),
      sink,
      now: new Date(),
    })
    console.info('Agent analytics daily export finished:', result)
    return result
  }
}
