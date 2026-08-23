import {
  DynamoDBDocumentClient,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../src/infrastructure/aws/dynamodb-client'
import {
  loadServerConfig,
  readServerEnvironment,
  type ServerConfig,
  type ServerEnvironment,
} from '../../src/infrastructure/config/server-config'
import {
  type DocumentDetail,
  type SearchCustomFieldValue,
  type SearchEntityType,
} from '@mukuroji/contracts'
import { isCanonicalWorkItemRecord } from '../../src/modules/work-items'
import { validateDocumentPayload } from '../../src/modules/documents'
import {
  createCommentWorkspaceSearchDocument,
  createCommentWorkspaceSearchEntityId,
  createDocumentWorkspaceSearchDocument,
  createProjectWorkspaceSearchDocument,
  createTeamWorkspaceSearchDocument,
  createWorkItemWorkspaceSearchDocument,
  createWorkspaceSearchDocumentRecordKey,
  ensureLocalWorkspaceSearchTable,
  type WorkspaceSearchDocument,
} from '../../src/modules/workspace-search'

const scanPageSize = 100
const sourceNames = ['project-directory', 'work-items', 'collaboration', 'documents'] as const

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
   * Canonical Document current row を保存する table 名です。
   */
  documents: string
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

  const config = loadWorkspaceSearchBackfillServerConfig()
  const bootstrapLocalDynamoDb = shouldBootstrapLocalDynamoDb(config)
  const tables = resolveTableNames(
    config.environment,
    bootstrapLocalDynamoDb,
  )
  const dynamoDbClient = createConfiguredDynamoDbClient(config)
  const documentClient = createDynamoDbDocumentClient(dynamoDbClient)
  const definitions = createSourceDefinitions(tables)
    .filter((definition) => options.source === undefined || definition.name === options.source)

  if (!options.dryRun && bootstrapLocalDynamoDb) {
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
  --source <name>           Run only project-directory, work-items, collaboration, or documents.
  --help, -h                Show this help.

Required production environment:
  PROJECT_DIRECTORY_TABLE_NAME, WORK_ITEMS_TABLE_NAME, COLLABORATION_TABLE_NAME,
  DOCUMENTS_TABLE_NAME, WORKSPACE_SEARCH_TABLE_NAME

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

/**
 * Loads the DynamoDB-only configuration used by the Workspace Search backfill.
 *
 * A shared AWS endpoint remains valid for DynamoDB, but must not be interpreted
 * as a Secrets Manager endpoint by this CLI because the backfill never creates
 * a Secrets Manager client.
 *
 * @param environment - Live or test environment values.
 * @returns A validated configuration snapshot with no implicit Bun endpoint.
 */
export function loadWorkspaceSearchBackfillServerConfig(
  environment: ServerEnvironment = readServerEnvironment(),
): ServerConfig {
  const dynamoDbEndpoint = [
    environment.DYNAMODB_ENDPOINT,
    environment.AWS_ENDPOINT_URL_DYNAMODB,
    environment.AWS_ENDPOINT_URL,
  ].find((value) => value?.trim())?.trim()

  return loadServerConfig({
    ...environment,
    DYNAMODB_ENDPOINT: dynamoDbEndpoint,
    AWS_ENDPOINT_URL: undefined,
    SECRETS_MANAGER_ENDPOINT: undefined,
    AWS_ENDPOINT_URL_SECRETS_MANAGER: undefined,
    AWS_ENDPOINT_URL_SECRETSMANAGER: undefined,
  }, { localBun: false })
}

function resolveTableNames(
  environment: ServerEnvironment,
  allowLocalDefaults: boolean,
): TableNames {
  return {
    projectDirectory: resolveTableName(
      environment,
      ['MUKUROJI_PROJECT_DIRECTORY_TABLE', 'PROJECT_DIRECTORY_TABLE_NAME'],
      'mukuroji-project-directory-local',
      allowLocalDefaults,
    ),
    workItems: resolveTableName(
      environment,
      [
        'WORK_ITEMS_TABLE_NAME',
      ],
      'mukuroji-team-issues-local',
      allowLocalDefaults,
    ),
    collaboration: resolveTableName(
      environment,
      ['MUKUROJI_COLLABORATION_TABLE', 'COLLABORATION_TABLE_NAME'],
      'mukuroji-collaboration-local',
      allowLocalDefaults,
    ),
    documents: resolveTableName(
      environment,
      ['MUKUROJI_DOCUMENTS_TABLE', 'DOCUMENTS_TABLE_NAME'],
      'mukuroji-documents-local',
      allowLocalDefaults,
    ),
    workspaceSearch: resolveTableName(
      environment,
      ['WORKSPACE_SEARCH_TABLE_NAME', 'MUKUROJI_WORKSPACE_SEARCH_TABLE'],
      'mukuroji-workspace-search-local',
      allowLocalDefaults,
    ),
  }
}

function resolveTableName(
  environment: ServerEnvironment,
  environmentNames: readonly string[],
  localDefault: string,
  allowLocalDefault: boolean,
) {
  for (const environmentName of environmentNames) {
    const value = environment[environmentName]?.trim()

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
    {
      name: 'documents',
      tableName: tables.documents,
      mapItem: mapDocumentItem,
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
    documents: { scanned: 0, projected: 0, deleted: 0, skipped: 0 },
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
      new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: tableName,
            Item: operation.document,
          },
        }],
      }),
    )
    return
  }

  await client.send(
    new TransactWriteCommand({
      TransactItems: [{
        Delete: {
          TableName: tableName,
          Key: {
            workspaceId: operation.workspaceId,
            recordKey: operation.recordKey,
          },
        },
      }],
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
    document: createTeamWorkspaceSearchDocument({
      workspaceId,
      title,
      subtitle,
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
    document: createProjectWorkspaceSearchDocument({
      workspaceId,
      title,
      subtitle,
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
  if (!isCanonicalWorkItemRecord(item)) {
    throw new TypeError(
      'Workspace search backfill encountered a non-canonical Work Item row.',
    )
  }

  const workspaceId = item.directoryId
  const teamId = item.teamId
  const issueId = item.issueId

  if (!workspaceId || !teamId || !issueId) {
    return undefined
  }

  const entityId = createWorkItemEntityId(teamId, issueId)

  if (readOptionalString(item.deletedAt) || item.archivedAt) {
    return createDeleteOperation(workspaceId, 'work-item', entityId)
  }

  const title = item.title
  const projectId = item.assignedProjectId

  if (!title) {
    return undefined
  }

  return {
    action: 'put',
    document: createWorkItemWorkspaceSearchDocument({
      workspaceId,
      teamId,
      issueId,
      title,
      body: item.description,
      projectId,
      assigneeUserId: item.assigneeUserId,
      creatorUserId: item.creatorMemberKey,
      status: item.workflowStatusId,
      customFields: readCanonicalCustomFieldValues(item.customFieldValues),
      relationIds: item.relationIds,
      dueDate: item.dueDate,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }),
  }
}

/**
 * Collaboration comment row を親 Work Item scope 付き search document 操作へ変換します。
 */
export function mapCollaborationItem(
  item: Record<string, unknown>,
): SearchProjectionOperation | undefined {
  if (
    item.entryType === 'comment' &&
    Object.prototype.hasOwnProperty.call(item, 'expiresAt')
  ) {
    throw new TypeError(
      'Workspace search backfill cannot reconcile a Collaboration target candidate that carries the TTL-managed expiresAt attribute.',
    )
  }

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

  const entityId = createCommentWorkspaceSearchEntityId(scope.teamId, scope.issueId, commentId)

  if (readOptionalString(item.deletedAt)) {
    return createDeleteOperation(scope.workspaceId, 'comment', entityId)
  }

  const body = readRequiredString(item.bodyMarkdown)

  if (!body) {
    return undefined
  }

  const authorMemberKey = readOptionalString(item.authorMemberKey)
  const sourceRevision = readPositiveInteger(item.version)

  return {
    action: 'put',
    document: createCommentWorkspaceSearchDocument({
      workspaceId: scope.workspaceId,
      teamId: scope.teamId,
      issueId: scope.issueId,
      commentId,
      body,
      creatorUserId: authorMemberKey,
      createdAt: readOptionalString(item.createdAt),
      updatedAt: readOptionalString(item.updatedAt) ?? readOptionalString(item.createdAt),
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
    }),
  }
}

/**
 * Canonical current Document row を search document の put/delete 操作へ変換します。
 *
 * Version、receipt、comment など同じ single-table 内の派生 row と、key/snapshot が一致しない
 * malformed row は fail closed で skip します。
 */
export function mapDocumentItem(
  item: Record<string, unknown>,
): SearchProjectionOperation | undefined {
  if (
    item.entryType === 'document' &&
    Object.prototype.hasOwnProperty.call(item, 'expiresAtEpoch')
  ) {
    throw new TypeError(
      'Workspace search backfill cannot reconcile a Document target candidate that carries the TTL-managed expiresAtEpoch attribute.',
    )
  }

  const workspaceId = readRequiredString(item.workspaceId)
  const documentId = readRequiredString(item.documentId)
  const revision = readPositiveInteger(item.revision)

  if (
    item.entryType !== 'document' ||
    !workspaceId ||
    !documentId ||
    item.recordKey !== `DOCUMENT#${documentId}` ||
    !revision ||
    !isRecord(item.document)
  ) {
    return undefined
  }

  const document = item.document as DocumentDetail

  if (
    document.id !== documentId ||
    document.revision !== revision ||
    (
      document.archivedAt !== undefined &&
      !isCanonicalIsoTimestamp(document.archivedAt)
    )
  ) {
    return undefined
  }

  try {
    validateDocumentPayload(document)
  } catch {
    return undefined
  }

  if (document.archivedAt) {
    return createDeleteOperation(workspaceId, 'document', document.id)
  }

  return {
    action: 'put',
    document: createDocumentWorkspaceSearchDocument(workspaceId, document),
  }
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

function readLocalizedTitle(item: Record<string, unknown>) {
  const nameJa = readOptionalString(item.nameJa)
  const nameEn = readOptionalString(item.nameEn)
  const title = nameJa ?? nameEn
  const subtitle = nameJa && nameEn && nameJa !== nameEn ? nameEn : undefined

  return { title, subtitle }
}

function readCanonicalCustomFieldValues(
  value: unknown,
): Record<string, SearchCustomFieldValue> | undefined {
  if (!isCanonicalCustomFieldValueRecord(value)) {
    return undefined
  }

  return Object.keys(value).length > 0 ? value : undefined
}

function isCanonicalCustomFieldValue(value: unknown): value is SearchCustomFieldValue {
  return typeof value === 'string' ||
    typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'boolean' ||
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isCanonicalCustomFieldValueRecord(
  value: unknown,
): value is Record<string, SearchCustomFieldValue> {
  return isRecord(value) && Object.entries(value).every(
    ([fieldId, fieldValue]) => fieldId.trim() && isCanonicalCustomFieldValue(fieldValue),
  )
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

function isCanonicalIsoTimestamp(value: unknown) {
  if (typeof value !== 'string') return false

  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
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

function isSourceName(value: string): value is SourceName {
  return sourceNames.includes(value as SourceName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
