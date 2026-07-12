import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_SCHEMA_VERSION,
  type SearchCustomFieldValue,
  type SearchEntityType,
} from '@mukuroji/contracts'
import {
  createWorkspaceSearchDocument,
  createWorkspaceSearchDocumentRecordKey,
  ensureLocalWorkspaceSearchTable,
  type WorkspaceSearchDocument,
} from '../src/workspace-search'

const scanPageSize = 100
const sourceNames = ['project-directory', 'work-items', 'collaboration'] as const

/**
 * Workspace search backfill が読み取る source table 名です。
 */
type SourceName = typeof sourceNames[number]

/**
 * CLI から受け取る Workspace search backfill option です。
 */
type BackfillOptions = {
  /**
   * Source を読み取るだけで target table を変更しない preview mode です。
   */
  dryRun: boolean
  /**
   * Help を表示するかどうかです。
   */
  help: boolean
  /**
   * 一回の実行で scan する source item 数の上限です。
   */
  limit?: number
  /**
   * 一つの source table だけを処理する場合の source 名です。
   */
  source?: SourceName
}

/**
 * Backfill で利用する source と target の DynamoDB table 名です。
 */
type TableNames = {
  /**
   * Team と Project を保存する directory table 名です。
   */
  projectDirectory: string
  /**
   * Canonical Work Item table 名です。
   */
  workItems: string
  /**
   * Work Item comment を保存する collaboration table 名です。
   */
  collaboration: string
  /**
   * Search document の投影先 table 名です。
   */
  workspaceSearch: string
}

/**
 * Source item を target table へ反映する操作です。
 */
export type SearchProjectionOperation =
  | {
      /**
       * Search document を同じ deterministic key へ保存する操作です。
       */
      action: 'put'
      /**
       * 保存する versioned search document です。
       */
      document: WorkspaceSearchDocument
    }
  | {
      /**
       * Soft delete または archive 済み source の投影を削除する操作です。
       */
      action: 'delete'
      /**
       * 削除対象の Workspace partition key です。
       */
      workspaceId: string
      /**
       * 削除対象の deterministic search document sort key です。
       */
      recordKey: string
      /**
       * Dry-run log に表示する entity 種別です。
       */
      entityType: SearchEntityType
      /**
       * Dry-run log に表示する canonical entity ID です。
       */
      entityId: string
    }

/**
 * 一つの source table の scan と mapping 定義です。
 */
type SourceDefinition = {
  /**
   * CLI と summary で使う source 名です。
   */
  name: SourceName
  /**
   * Scan する DynamoDB table 名です。
   */
  tableName: string
  /**
   * Source row を search document の put/delete 操作へ変換します。
   */
  mapItem: (item: Record<string, unknown>) => SearchProjectionOperation | undefined
}

/**
 * 一つの source table の実行結果です。
 */
type BackfillCounters = {
  /**
   * Scan した source item 数です。
   */
  scanned: number
  /**
   * Search document に変換できた source item 数です。
   */
  projected: number
  /**
   * Archive または soft delete により target から削除した item 数です。
   */
  deleted: number
  /**
   * Search 対象外または不正なため skip した item 数です。
   */
  skipped: number
}

/**
 * Comment entity key から復元した canonical Work Item scope です。
 */
export type WorkItemScope = {
  /**
   * Workspace ID です。
   */
  workspaceId: string
  /**
   * Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Team 内の Work Item ID です。
   */
  issueId: string
}

async function main() {
  const options = parseArguments(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  const endpoint = readEnvironment('DYNAMODB_ENDPOINT') ??
    readEnvironment('AWS_ENDPOINT_URL_DYNAMODB') ??
    readEnvironment('AWS_ENDPOINT_URL')
  const region = readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'us-east-1'
  const tables = resolveTableNames(endpoint)
  const dynamoDbClient = createDynamoDbClient(endpoint, region)
  const documentClient = createDocumentClient(dynamoDbClient)
  const definitions = createSourceDefinitions(tables)
    .filter((definition) => options.source === undefined || definition.name === options.source)

  if (!options.dryRun && endpoint && isLocalEndpoint(endpoint)) {
    await ensureLocalWorkspaceSearchTable(tables.workspaceSearch, dynamoDbClient)
  }

  console.info(
    `Workspace search backfill started: target=${tables.workspaceSearch} ` +
    `dryRun=${options.dryRun} limit=${options.limit ?? 'unlimited'}`,
  )

  const counters = await runBackfill(
    documentClient,
    definitions,
    tables.workspaceSearch,
    options,
  )

  for (const definition of definitions) {
    const sourceCounters = counters[definition.name]
    console.info(
      `${definition.name}: scanned=${sourceCounters.scanned} ` +
      `projected=${sourceCounters.projected} deleted=${sourceCounters.deleted} ` +
      `skipped=${sourceCounters.skipped}`,
    )
  }
}

function parseArguments(args: string[]): BackfillOptions {
  const options: BackfillOptions = {
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }

    if (argument === '--limit' || argument.startsWith('--limit=')) {
      const value = readOptionValue(argument, args[index + 1], '--limit')
      options.limit = parsePositiveInteger(value, '--limit')
      index += argument === '--limit' ? 1 : 0
      continue
    }

    if (argument === '--source' || argument.startsWith('--source=')) {
      const value = readOptionValue(argument, args[index + 1], '--source')

      if (!isSourceName(value)) {
        throw new Error(`Unknown --source value: ${value}`)
      }

      options.source = value
      index += argument === '--source' ? 1 : 0
      continue
    }

    throw new Error(`Unknown argument: ${argument}`)
  }

  return options
}

function printHelp() {
  console.info(`Usage: bun run search:backfill -- [options]

Options:
  --dry-run                 Scan and map source rows without changing the search table.
  --limit <count>           Maximum source rows scanned in this run.
  --source <name>           Run only project-directory, work-items, or collaboration.
  --help, -h                Show this help.

Required production environment:
  PROJECT_DIRECTORY_TABLE_NAME, WORK_ITEMS_TABLE_NAME, COLLABORATION_TABLE_NAME,
  WORKSPACE_SEARCH_TABLE_NAME

For a local endpoint, repository-local default table names are used when omitted.
Write runs create the local Workspace search table when it is missing. Re-running
the command is safe because every document uses a deterministic Workspace/entity key.`)
}

function readOptionValue(argument: string, following: string | undefined, optionName: string) {
  const equalsIndex = argument.indexOf('=')
  const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : following

  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`)
  }

  return value
}

function parsePositiveInteger(value: string, optionName: string) {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`)
  }

  return parsed
}

function resolveTableNames(endpoint: string | undefined): TableNames {
  const allowLocalDefaults = endpoint !== undefined && isLocalEndpoint(endpoint)

  return {
    projectDirectory: resolveTableName(
      ['MUKUROJI_PROJECT_DIRECTORY_TABLE', 'PROJECT_DIRECTORY_TABLE_NAME'],
      'mukuroji-project-directory-local',
      allowLocalDefaults,
    ),
    workItems: resolveTableName(
      [
        'MUKUROJI_WORK_ITEMS_TABLE',
        'WORK_ITEMS_TABLE_NAME',
        'MUKUROJI_TEAM_ISSUES_TABLE',
        'TEAM_ISSUES_TABLE_NAME',
      ],
      'mukuroji-team-issues-local',
      allowLocalDefaults,
    ),
    collaboration: resolveTableName(
      ['MUKUROJI_COLLABORATION_TABLE', 'COLLABORATION_TABLE_NAME'],
      'mukuroji-collaboration-local',
      allowLocalDefaults,
    ),
    workspaceSearch: resolveTableName(
      ['WORKSPACE_SEARCH_TABLE_NAME', 'MUKUROJI_WORKSPACE_SEARCH_TABLE'],
      'mukuroji-workspace-search-local',
      allowLocalDefaults,
    ),
  }
}

function resolveTableName(
  environmentNames: readonly string[],
  localDefault: string,
  allowLocalDefault: boolean,
) {
  for (const environmentName of environmentNames) {
    const value = readEnvironment(environmentName)

    if (value) {
      return value
    }
  }

  if (allowLocalDefault) {
    return localDefault
  }

  throw new Error(
    `${environmentNames.join(' or ')} is required when a local DynamoDB endpoint is not configured.`,
  )
}

function createDynamoDbClient(endpoint: string | undefined, region: string) {
  return new DynamoDBClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(endpoint
      ? {
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })
}

function createDocumentClient(baseClient: DynamoDBClient) {
  return DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  })
}

function createSourceDefinitions(tables: TableNames): SourceDefinition[] {
  return [
    {
      name: 'project-directory',
      tableName: tables.projectDirectory,
      mapItem: mapProjectDirectoryItem,
    },
    {
      name: 'work-items',
      tableName: tables.workItems,
      mapItem: mapWorkItem,
    },
    {
      name: 'collaboration',
      tableName: tables.collaboration,
      mapItem: mapCollaborationItem,
    },
  ]
}

/**
 * 選択した source table を page scan し、search projection を dry-run または書き込みで反映します。
 */
export async function runBackfill(
  client: DynamoDBDocumentClient,
  definitions: readonly SourceDefinition[],
  workspaceSearchTableName: string,
  options: BackfillOptions,
) {
  const counters = createCounters()
  let remaining = options.limit

  for (const definition of definitions) {
    let lastEvaluatedKey: Record<string, unknown> | undefined

    do {
      if (remaining === 0) {
        return counters
      }

      const response = await client.send(
        new ScanCommand({
          TableName: definition.tableName,
          ExclusiveStartKey: lastEvaluatedKey,
          Limit: Math.min(scanPageSize, remaining ?? scanPageSize),
          ConsistentRead: true,
        }),
      )
      const items = response.Items ?? []
      const scanned = response.ScannedCount ?? items.length

      counters[definition.name].scanned += scanned

      for (const item of items) {
        const operation = definition.mapItem(item)

        if (!operation) {
          counters[definition.name].skipped += 1
          continue
        }

        if (operation.action === 'put') {
          counters[definition.name].projected += 1
        } else {
          counters[definition.name].deleted += 1
        }

        if (options.dryRun) {
          printDryRunOperation(definition.name, operation)
          continue
        }

        await applyProjectionOperation(client, workspaceSearchTableName, operation)
      }

      lastEvaluatedKey = response.LastEvaluatedKey

      if (remaining !== undefined) {
        remaining = Math.max(0, remaining - scanned)
      }
    } while (lastEvaluatedKey)
  }

  return counters
}

function createCounters(): Record<SourceName, BackfillCounters> {
  return {
    'project-directory': { scanned: 0, projected: 0, deleted: 0, skipped: 0 },
    'work-items': { scanned: 0, projected: 0, deleted: 0, skipped: 0 },
    collaboration: { scanned: 0, projected: 0, deleted: 0, skipped: 0 },
  }
}

function printDryRunOperation(source: SourceName, operation: SearchProjectionOperation) {
  if (operation.action === 'put') {
    console.info(
      `[dry-run] source=${source} action=put ` +
      `entity=${operation.document.entityType}:${operation.document.entityId}`,
    )
    return
  }

  console.info(
    `[dry-run] source=${source} action=delete ` +
    `entity=${operation.entityType}:${operation.entityId}`,
  )
}

async function applyProjectionOperation(
  client: DynamoDBDocumentClient,
  tableName: string,
  operation: SearchProjectionOperation,
) {
  if (operation.action === 'put') {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: operation.document,
      }),
    )
    return
  }

  await client.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        workspaceId: operation.workspaceId,
        recordKey: operation.recordKey,
      },
    }),
  )
}

/**
 * ProjectDirectory row を Team または Project search document 操作へ変換します。
 */
export function mapProjectDirectoryItem(item: Record<string, unknown>) {
  const workspaceId = readRequiredString(item.directoryId)
  const entryType = readRequiredString(item.entryType)

  if (!workspaceId || (entryType !== 'team' && entryType !== 'project')) {
    return undefined
  }

  if (entryType === 'team') {
    if (!isCanonicalTeamDirectoryItem(item, workspaceId)) {
      return undefined
    }
    return mapTeamDirectoryItem(workspaceId, item)
  }

  if (!isCanonicalProjectDirectoryItem(item, workspaceId)) {
    return undefined
  }
  return mapProjectDirectoryItemRow(workspaceId, item)
}

function mapTeamDirectoryItem(
  workspaceId: string,
  item: Record<string, unknown>,
): SearchProjectionOperation | undefined {
  const teamId = readRequiredString(item.teamId)

  if (!teamId) {
    return undefined
  }

  const entityId = createTeamEntityId(teamId)

  if (readOptionalString(item.archivedAt)) {
    return createDeleteOperation(workspaceId, 'team', entityId)
  }

  const { title, subtitle } = readLocalizedTitle(item)

  if (!title) {
    return undefined
  }

  return {
    action: 'put',
    document: createSearchDocument({
      workspaceId,
      entityType: 'team',
      entityId,
      title,
      subtitle,
      url: `/teams/${encodeURIComponent(teamId)}/overview`,
      teamId,
      createdAt: readOptionalString(item.createdAt),
      updatedAt: readOptionalString(item.updatedAt),
    }),
  }
}

function mapProjectDirectoryItemRow(
  workspaceId: string,
  item: Record<string, unknown>,
): SearchProjectionOperation | undefined {
  const teamId = readRequiredString(item.teamId)
  const projectId = readRequiredString(item.projectId)

  if (!teamId || !projectId) {
    return undefined
  }

  const entityId = createProjectEntityId(teamId, projectId)

  if (readOptionalString(item.archivedAt)) {
    return createDeleteOperation(workspaceId, 'project', entityId)
  }

  const { title, subtitle } = readLocalizedTitle(item)

  if (!title) {
    return undefined
  }

  return {
    action: 'put',
    document: createSearchDocument({
      workspaceId,
      entityType: 'project',
      entityId,
      title,
      subtitle,
      url: createProjectUrl(projectId, teamId),
      teamId,
      projectId,
      createdAt: readOptionalString(item.createdAt),
      updatedAt: readOptionalString(item.updatedAt),
    }),
  }
}

/**
 * Canonical Work Item row を Team scope を保持した search document 操作へ変換します。
 */
export function mapWorkItem(item: Record<string, unknown>): SearchProjectionOperation | undefined {
  if (!isCanonicalWorkItem(item)) {
    return undefined
  }

  const workspaceId = readRequiredString(item.directoryId)
  const teamId = readRequiredString(item.teamId)
  const issueId = readRequiredString(item.issueId)

  if (!workspaceId || !teamId || !issueId) {
    return undefined
  }

  const entityId = createWorkItemEntityId(teamId, issueId)

  if (readOptionalString(item.deletedAt) || readOptionalString(item.archivedAt)) {
    return createDeleteOperation(workspaceId, 'work-item', entityId)
  }

  const title = readOptionalString(item.title) ?? readOptionalString(item.titleKey) ?? issueId
  const projectId = readOptionalString(item.assignedProjectId)

  return {
    action: 'put',
    document: createSearchDocument({
      workspaceId,
      entityType: 'work-item',
      entityId,
      title,
      subtitle: issueId,
      body: readOptionalString(item.description),
      url: createWorkItemUrl(teamId, issueId, projectId),
      teamId,
      projectId,
      assigneeUserId: readOptionalString(item.assigneeUserId),
      creatorUserId: readOptionalString(item.creatorMemberKey),
      status: readOptionalString(item.status),
      customFields: readCustomFields(item.customFields),
      relationIds: readStringArray(item.relationIds),
      dueDate: readOptionalString(item.dueDate),
      createdAt: readOptionalString(item.createdAt),
      updatedAt: readOptionalString(item.updatedAt),
    }),
  }
}

/**
 * Collaboration comment row を親 Work Item scope 付き search document 操作へ変換します。
 */
export function mapCollaborationItem(
  item: Record<string, unknown>,
): SearchProjectionOperation | undefined {
  if (!isCanonicalCollaborationComment(item)) {
    return undefined
  }

  const entityKey = readRequiredString(item.entityKey)
  const commentId = readRequiredString(item.id)
  const recordKey = readRequiredString(item.recordKey)
  const scope = entityKey ? parseWorkItemCollaborationEntityKey(entityKey) : undefined

  if (!scope || !commentId || recordKey !== `COMMENT#${commentId}`) {
    return undefined
  }

  const entityId = createCommentEntityId(scope.teamId, scope.issueId, commentId)

  if (readOptionalString(item.deletedAt)) {
    return createDeleteOperation(scope.workspaceId, 'comment', entityId)
  }

  const body = readRequiredString(item.bodyMarkdown)

  if (!body) {
    return undefined
  }

  const authorMemberKey = readOptionalString(item.authorMemberKey)

  return {
    action: 'put',
    document: createSearchDocument({
      workspaceId: scope.workspaceId,
      entityType: 'comment',
      entityId,
      title: createCommentTitle(body),
      subtitle: authorMemberKey,
      body,
      url: createCommentUrl(scope.teamId, scope.issueId, commentId),
      teamId: scope.teamId,
      parentId: createWorkItemEntityId(scope.teamId, scope.issueId),
      creatorUserId: authorMemberKey,
      createdAt: readOptionalString(item.createdAt),
      updatedAt: readOptionalString(item.updatedAt) ?? readOptionalString(item.createdAt),
    }),
  }
}

function createSearchDocument(
  input: Omit<WorkspaceSearchDocument, 'schemaVersion' | 'recordKey' | 'entryType'>,
): WorkspaceSearchDocument {
  return createWorkspaceSearchDocument(input)
}

function createDeleteOperation(
  workspaceId: string,
  entityType: SearchEntityType,
  entityId: string,
): SearchProjectionOperation {
  return {
    action: 'delete',
    workspaceId,
    recordKey: createWorkspaceSearchDocumentRecordKey(entityType, entityId),
    entityType,
    entityId,
  }
}

/**
 * Canonical collaboration entity key を Workspace、Team、Work Item scope へ厳密に復元します。
 */
export function parseWorkItemCollaborationEntityKey(entityKey: string): WorkItemScope | undefined {
  const workItemMarker = '#work-item#team/'
  const markerIndex = entityKey.lastIndexOf(workItemMarker)

  if (markerIndex < 1) {
    return undefined
  }

  const workspaceId = entityKey.slice(0, markerIndex)
  const remainder = entityKey.slice(markerIndex + workItemMarker.length)
  const issueMarker = '/issue/'
  const issueMarkerIndex = remainder.indexOf(issueMarker)

  if (issueMarkerIndex < 1) {
    return undefined
  }

  const teamId = remainder.slice(0, issueMarkerIndex)
  const issueId = remainder.slice(issueMarkerIndex + issueMarker.length)

  if (
    !workspaceId ||
    !teamId ||
    !issueId ||
    teamId.includes('/') ||
    issueId.includes('/') ||
    `${workspaceId}${workItemMarker}${teamId}${issueMarker}${issueId}` !== entityKey
  ) {
    return undefined
  }

  return { workspaceId, teamId, issueId }
}

function createProjectEntityId(teamId: string, projectId: string) {
  return `team/${teamId}/project/${projectId}`
}

function createTeamEntityId(teamId: string) {
  return `team/${teamId}`
}

function createWorkItemEntityId(teamId: string, issueId: string) {
  return `team/${teamId}/issue/${issueId}`
}

function createCommentEntityId(teamId: string, issueId: string, commentId: string) {
  return `${createWorkItemEntityId(teamId, issueId)}/comment/${commentId}`
}

function createProjectUrl(projectId: string, teamId: string) {
  const query = new URLSearchParams({ teamId })
  return `/projects/${encodeURIComponent(projectId)}/issues?${query.toString()}`
}

function createWorkItemUrl(teamId: string, issueId: string, projectId: string | undefined) {
  if (!projectId) {
    const query = new URLSearchParams({ issueId })
    return `/teams/${encodeURIComponent(teamId)}/issues?${query.toString()}`
  }

  const query = new URLSearchParams({ teamId, issueId })
  return `/projects/${encodeURIComponent(projectId)}/issues?${query.toString()}`
}

function createCommentUrl(teamId: string, issueId: string, commentId: string) {
  const query = new URLSearchParams({ issueId, commentId })
  return `/teams/${encodeURIComponent(teamId)}/issues?${query.toString()}`
}

function createCommentTitle(body: string) {
  const firstLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)

  return (firstLine ?? 'Comment').slice(0, 160)
}

function readLocalizedTitle(item: Record<string, unknown>) {
  const nameJa = readOptionalString(item.nameJa)
  const nameEn = readOptionalString(item.nameEn)
  const title = nameJa ?? nameEn
  const subtitle = nameJa && nameEn && nameJa !== nameEn ? nameEn : undefined

  return { title, subtitle }
}

function readCustomFields(value: unknown): Record<string, SearchCustomFieldValue> | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const result: Record<string, SearchCustomFieldValue> = {}

  for (const [fieldId, fieldValue] of Object.entries(value)) {
    if (!fieldId.trim() || !isSearchCustomFieldValue(fieldValue)) {
      continue
    }

    result[fieldId] = fieldValue
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function isSearchCustomFieldValue(value: unknown): value is SearchCustomFieldValue {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'boolean' ||
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined
  }

  const entries = [...new Set(value.flatMap((entry) =>
    typeof entry === 'string' && entry.trim() ? [entry.trim()] : [],
  ))]

  return entries.length > 0 ? entries : undefined
}

function readRequiredString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined
}

function isCanonicalTeamDirectoryItem(item: Record<string, unknown>, workspaceId: string) {
  return item.directoryId === workspaceId &&
    item.entryType === 'team' &&
    typeof item.entryKey === 'string' &&
    typeof item.teamId === 'string' &&
    typeof item.teamSortOrder === 'number' &&
    typeof item.nameJa === 'string' &&
    typeof item.nameEn === 'string' &&
    (item.expanded === undefined || typeof item.expanded === 'boolean') &&
    (item.archivedAt === undefined || typeof item.archivedAt === 'string')
}

function isCanonicalProjectDirectoryItem(item: Record<string, unknown>, workspaceId: string) {
  return item.directoryId === workspaceId &&
    item.entryType === 'project' &&
    typeof item.entryKey === 'string' &&
    typeof item.teamId === 'string' &&
    typeof item.teamSortOrder === 'number' &&
    typeof item.projectId === 'string' &&
    typeof item.projectSortOrder === 'number' &&
    typeof item.nameJa === 'string' &&
    typeof item.nameEn === 'string' &&
    isProjectTone(item.tone) &&
    (item.archivedAt === undefined || typeof item.archivedAt === 'string')
}

function isCanonicalWorkItem(item: Record<string, unknown>) {
  return item.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    Boolean(readPositiveInteger(item.revision)) &&
    typeof item.directoryId === 'string' &&
    typeof item.teamId === 'string' &&
    item.directoryTeamId === `${item.directoryId}#team#${item.teamId}` &&
    typeof item.issueId === 'string' &&
    typeof item.sortOrder === 'number' &&
    (typeof item.title === 'string' || typeof item.titleKey === 'string') &&
    (item.description === undefined || typeof item.description === 'string') &&
    typeof item.assigneeUserId === 'string' &&
    (item.creatorMemberKey === undefined || typeof item.creatorMemberKey === 'string') &&
    isWorkItemStatus(item.status) &&
    typeof item.dueDate === 'string' &&
    isWorkItemPriority(item.priority) &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    (
      item.assignedProjectId === undefined ||
      (
        typeof item.assignedProjectId === 'string' &&
        item.directoryProjectId === `${item.directoryId}#project#${item.assignedProjectId}`
      )
    )
}

function isCanonicalCollaborationComment(item: Record<string, unknown>) {
  return item.entryType === 'comment' &&
    typeof item.entityKey === 'string' &&
    typeof item.recordKey === 'string' &&
    typeof item.id === 'string' &&
    typeof item.rootCommentId === 'string' &&
    typeof item.authorMemberKey === 'string' &&
    typeof item.bodyMarkdown === 'string' &&
    Number.isSafeInteger(item.version) &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
}

function isProjectTone(value: unknown) {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}

function isWorkItemStatus(value: unknown) {
  return value === 'todo' || value === 'in-progress' || value === 'review' || value === 'done'
}

function isWorkItemPriority(value: unknown) {
  return value === 'high' || value === 'medium' || value === 'low'
}

function readEnvironment(name: string) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function isSourceName(value: string): value is SourceName {
  return sourceNames.includes(value as SourceName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isLocalEndpoint(endpoint: string) {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
