import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { ScheduledProjectManagerReader } from '../../application/ports/project-manager-reader'

/** Default Project Directory query page size. */
const defaultPageSize = 100
/** Default safety bound on Project Directory pages read for one Workspace. */
const defaultMaxPages = 100

/** Options for the DynamoDB Project manager reader. */
export type DynamoDbProjectManagerReaderOptions = {
  /** DocumentClient used for the strongly consistent directory query. */
  documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** Canonical Project Directory table name. */
  tableName: string
  /** Directory query page size. */
  pageSize?: number
  /** Maximum directory pages read for one Workspace. */
  maxPages?: number
}

/**
 * Creates a reader that resolves the unarchived managers of active Projects from the Project
 * Directory partition.
 *
 * @param options - DocumentClient, table name, and paging bounds.
 * @returns Reader for the notification schedule's overdue escalation.
 * @throws Error from the reader when a Workspace exceeds the page bound or a row is malformed.
 */
export function createDynamoDbProjectManagerReader(
  options: DynamoDbProjectManagerReaderOptions,
): ScheduledProjectManagerReader {
  const tableName = options.tableName.trim()
  if (!tableName) throw new Error('Project Directory table name is required.')
  const pageSize = options.pageSize ?? defaultPageSize
  const maxPages = options.maxPages ?? defaultMaxPages
  return {
    async readActiveProjectManagers(workspaceId) {
      const activeProjectIds = new Set<string>()
      const managers = new Map<string, Set<string>>()
      let exclusiveStartKey: Record<string, unknown> | undefined
      let pages = 0
      do {
        if (pages >= maxPages) {
          throw new Error(
            `Work Item escalation Project lookup exceeded the configured ${maxPages} page limit.`,
          )
        }
        const response = await options.documentClient.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'directoryId = :directoryId',
          ExpressionAttributeValues: { ':directoryId': workspaceId },
          ConsistentRead: true,
          Limit: pageSize,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }))
        pages += 1
        for (const item of response.Items ?? []) {
          if (item.entryType === 'project' && item.archivedAt === undefined) {
            activeProjectIds.add(requireText(item.projectId, 'Project directory project ID'))
          }
          // An archived membership confers no access, so a former manager is not escalated to.
          if (
            item.entryType === 'project-member' &&
            item.role === 'manager' &&
            item.archivedAt === undefined
          ) {
            const projectId = requireText(item.projectId, 'Project member project ID')
            const memberKey = requireText(item.memberKey, 'Project member key').toLowerCase()
            const projectManagers = managers.get(projectId) ?? new Set<string>()
            projectManagers.add(memberKey)
            managers.set(projectId, projectManagers)
          }
        }
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)

      return new Map([...managers]
        .filter(([projectId]) => activeProjectIds.has(projectId))
        .map(([projectId, memberKeys]) => [projectId, [...memberKeys].sort()]))
    },
  }
}

/**
 * Reads a required non-blank directory string.
 *
 * @param value - Untrusted directory attribute.
 * @param label - Attribute name used in the error.
 * @returns The trimmed text.
 * @throws TypeError when the attribute is missing or blank.
 */
function requireText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new TypeError(`${label} must be a non-empty string.`)
  return text
}
