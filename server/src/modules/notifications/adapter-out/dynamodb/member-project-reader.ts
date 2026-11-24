import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { ExpiringMemberProject } from '../../application/member-access-expiry-notices'

/** Default Project Directory query page size. */
const defaultPageSize = 100
/** Default safety bound on Project Directory pages read for one Workspace. */
const defaultMaxPages = 100

/** Options for the DynamoDB member Project reader. */
export type DynamoDbMemberProjectReaderOptions = {
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
 * Creates a reader of the active Projects a member belongs to, with each Project's managers.
 *
 * @param options - DocumentClient, table name, and paging bounds.
 * @returns A function that reads one member's Projects from the Workspace directory partition.
 * @throws Error from the reader when a Workspace exceeds the page bound or a row is malformed.
 */
export function createDynamoDbMemberProjectReader(
  options: DynamoDbMemberProjectReaderOptions,
): (workspaceId: string, memberKey: string) => Promise<ExpiringMemberProject[]> {
  const tableName = options.tableName.trim()
  if (!tableName) throw new Error('Project Directory table name is required.')
  const pageSize = options.pageSize ?? defaultPageSize
  const maxPages = options.maxPages ?? defaultMaxPages
  return async (workspaceId, memberKey) => {
    const normalizedMemberKey = memberKey.trim().toLowerCase()
    // A Project ID names one Project of the Workspace; its Team comes from the Project row.
    const activeProjectTeams = new Map<string, string>()
    const memberProjectIds = new Set<string>()
    const managers = new Map<string, Set<string>>()
    let exclusiveStartKey: Record<string, unknown> | undefined
    let pages = 0
    do {
      if (pages >= maxPages) {
        throw new Error(`Member Project lookup exceeded the configured ${maxPages} page limit.`)
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
          activeProjectTeams.set(
            requireText(item.projectId, 'Project directory project ID'),
            requireText(item.teamId, 'Project directory Team ID'),
          )
        }
        if (item.entryType !== 'project-member' || item.archivedAt !== undefined) continue
        const projectId = requireText(item.projectId, 'Project member project ID')
        const rowMemberKey = requireText(item.memberKey, 'Project member key').toLowerCase()
        if (rowMemberKey === normalizedMemberKey) memberProjectIds.add(projectId)
        if (item.role === 'manager') {
          const projectManagers = managers.get(projectId) ?? new Set<string>()
          projectManagers.add(rowMemberKey)
          managers.set(projectId, projectManagers)
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return [...memberProjectIds]
      .flatMap((projectId): ExpiringMemberProject[] => {
        const teamId = activeProjectTeams.get(projectId)
        return teamId === undefined
          ? []
          : [{ teamId, projectId, managerMemberKeys: [...(managers.get(projectId) ?? [])].sort() }]
      })
      .sort((left, right) =>
        left.teamId.localeCompare(right.teamId) || left.projectId.localeCompare(right.projectId)
      )
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
