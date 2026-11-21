import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  WeeklyReportRosterMember,
  WeeklyReportTeamRoster,
} from '../../application/weekly-report-reminders'

/** Default Project Directory query page size. */
const defaultPageSize = 100
/** Default safety bound on Project Directory pages read for one Workspace. */
const defaultMaxPages = 100

/** Options for the DynamoDB weekly report roster reader. */
export type DynamoDbWeeklyReportRosterReaderOptions = {
  /** DocumentClient used for the strongly consistent directory query. */
  documentClient: Pick<DynamoDBDocumentClient, 'send'>
  /** Canonical Project Directory table name. */
  tableName: string
  /** Directory query page size. */
  pageSize?: number
  /** Maximum directory pages read for one Workspace. */
  maxPages?: number
}

/** Memberships of one Project collected from the directory partition. */
type ProjectMemberships = {
  /** Writers keyed by member key. */
  writers: Map<string, WeeklyReportRosterMember>
  /** Manager member keys. */
  managers: Set<string>
}

/**
 * Creates a reader that lists, per Team, the active Projects with their writing members and
 * managers from the Project Directory partition.
 *
 * A Project ID that more than one Team uses is left out, because a membership row names only the
 * Project and could belong to either Team. Archived Teams, Projects, and memberships are left out.
 *
 * @param options - DocumentClient, table name, and paging bounds.
 * @returns Function that reads one Workspace's rosters.
 * @throws Error from the function when a Workspace exceeds the page bound or a row is malformed.
 */
export function createDynamoDbWeeklyReportRosterReader(
  options: DynamoDbWeeklyReportRosterReaderOptions,
): (workspaceId: string) => Promise<WeeklyReportTeamRoster[]> {
  const tableName = options.tableName.trim()
  if (!tableName) throw new Error('Project Directory table name is required.')
  const pageSize = options.pageSize ?? defaultPageSize
  const maxPages = options.maxPages ?? defaultMaxPages
  return async (workspaceId) => {
    const activeTeamIds = new Set<string>()
    const projectTeams = new Map<string, Set<string>>()
    const archivedProjectIds = new Set<string>()
    const memberships = new Map<string, ProjectMemberships>()
    let exclusiveStartKey: Record<string, unknown> | undefined
    let pages = 0
    do {
      if (pages >= maxPages) {
        throw new Error(`Weekly report roster lookup exceeded the configured ${maxPages} page limit.`)
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
        }
        if (
          item.entryType === 'project-member' &&
          item.archivedAt === undefined &&
          (item.role === 'manager' || item.role === 'member')
        ) {
          const projectId = requireText(item.projectId, 'Project member project ID')
          const memberKey = requireText(item.memberKey, 'Project member key').toLowerCase()
          const project = memberships.get(projectId) ?? { writers: new Map(), managers: new Set() }
          const displayName = typeof item.name === 'string' ? item.name.trim() : ''
          project.writers.set(memberKey, { memberKey, ...(displayName ? { displayName } : {}) })
          if (item.role === 'manager') project.managers.add(memberKey)
          memberships.set(projectId, project)
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    const rosters = new Map<string, WeeklyReportTeamRoster>()
    for (const [projectId, teams] of [...projectTeams].sort(([left], [right]) => left.localeCompare(right))) {
      const [teamId] = [...teams]
      if (teams.size !== 1 || teamId === undefined || archivedProjectIds.has(projectId) || !activeTeamIds.has(teamId)) continue
      const project = memberships.get(projectId)
      if (!project || project.writers.size === 0) continue
      const roster = rosters.get(teamId) ?? { workspaceId, teamId, projects: [] }
      roster.projects.push({
        projectId,
        writers: [...project.writers.values()].sort((left, right) => left.memberKey.localeCompare(right.memberKey)),
        managerMemberKeys: [...project.managers].sort(),
      })
      rosters.set(teamId, roster)
    }
    return [...rosters.values()].sort((left, right) => left.teamId.localeCompare(right.teamId))
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
