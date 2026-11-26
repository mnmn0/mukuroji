import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

/** Default Project Directory query page size. */
const defaultPageSize = 100
/** Default safety bound on Project Directory pages read for one Workspace. */
const defaultMaxPages = 100

/** An active Project with the people a budget threshold alert may reach (ADR 0105). */
export type BudgetAlertProject = {
  /** Team that owns the Project. */
  teamId: string
  /** Project ID. */
  projectId: string
  /** Lower-case member key of the charter owner, when the charter names one. */
  ownerMemberKey?: string
  /** Lower-case member keys of the unarchived managers, sorted. */
  managerMemberKeys: string[]
}

/** Options for the DynamoDB budget alert Project reader. */
export type DynamoDbBudgetAlertProjectReaderOptions = {
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
 * Creates a reader that lists a Workspace's active Projects with their charter owner and managers
 * from the Project Directory partition.
 *
 * A Project ID that more than one Team uses is left out, because a membership row names only the
 * Project and could belong to either Team. Archived Teams, Projects, and memberships are left out.
 *
 * @param options - DocumentClient, table name, and paging bounds.
 * @returns Function that reads one Workspace's Projects, ordered by Team and Project.
 * @throws Error from the function when a Workspace exceeds the page bound or a row is malformed.
 */
export function createDynamoDbBudgetAlertProjectReader(
  options: DynamoDbBudgetAlertProjectReaderOptions,
): (workspaceId: string) => Promise<BudgetAlertProject[]> {
  const tableName = options.tableName.trim()
  if (!tableName) throw new Error('Project Directory table name is required.')
  const pageSize = options.pageSize ?? defaultPageSize
  const maxPages = options.maxPages ?? defaultMaxPages
  return async (workspaceId) => {
    const activeTeamIds = new Set<string>()
    const projectTeams = new Map<string, Set<string>>()
    const archivedProjectIds = new Set<string>()
    const owners = new Map<string, string>()
    const managers = new Map<string, Set<string>>()
    let exclusiveStartKey: Record<string, unknown> | undefined
    let pages = 0
    do {
      if (pages >= maxPages) {
        throw new Error(`Budget alert Project lookup exceeded the configured ${maxPages} page limit.`)
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
        if (item.entryType === 'team' && item.archivedAt === undefined) {
          activeTeamIds.add(requireText(item.teamId, 'Team directory team ID'))
        }
        if (item.entryType === 'project') {
          const projectId = requireText(item.projectId, 'Project directory project ID')
          const teams = projectTeams.get(projectId) ?? new Set<string>()
          teams.add(requireText(item.teamId, 'Project directory team ID'))
          projectTeams.set(projectId, teams)
          if (item.archivedAt !== undefined) archivedProjectIds.add(projectId)
          const ownerMemberKey = readCharterOwner(item.charter)
          if (ownerMemberKey) owners.set(projectId, ownerMemberKey)
        }
        if (item.entryType === 'project-member' && item.archivedAt === undefined && item.role === 'manager') {
          const projectId = requireText(item.projectId, 'Project member project ID')
          const set = managers.get(projectId) ?? new Set<string>()
          set.add(requireText(item.memberKey, 'Project member key').toLowerCase())
          managers.set(projectId, set)
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    const projects: BudgetAlertProject[] = []
    for (const [projectId, teams] of projectTeams) {
      const [teamId] = [...teams]
      if (teams.size !== 1 || teamId === undefined || archivedProjectIds.has(projectId) || !activeTeamIds.has(teamId)) continue
      const ownerMemberKey = owners.get(projectId)
      projects.push({
        teamId,
        projectId,
        ...(ownerMemberKey ? { ownerMemberKey } : {}),
        managerMemberKeys: [...(managers.get(projectId) ?? [])].sort(),
      })
    }
    return projects.sort((left, right) =>
      left.teamId.localeCompare(right.teamId) || left.projectId.localeCompare(right.projectId))
  }
}

/**
 * Reads the charter owner's member key from a stored charter.
 *
 * @param charter - Untrusted charter attribute of a Project row.
 * @returns The lower-case member key, or undefined when the charter names no owner.
 */
function readCharterOwner(charter: unknown): string | undefined {
  if (typeof charter !== 'object' || charter === null || !('owner' in charter)) return undefined
  const owner: unknown = charter.owner
  if (typeof owner !== 'object' || owner === null || !('userId' in owner)) return undefined
  const userId: unknown = owner.userId
  return typeof userId === 'string' && userId.trim() ? userId.trim().toLowerCase() : undefined
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
