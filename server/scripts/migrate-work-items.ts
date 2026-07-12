import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { WORK_ITEM_SCHEMA_VERSION } from '@mukuroji/contracts'
import {
  createMigratedWorkItem,
  createProjectOwnership,
  createProjectOwnershipKey,
  hasEquivalentWorkItemState,
  hasCurrentWorkItemVersion,
  hasUnsupportedWorkItemVersion,
  resolveProjectOwnerTeam,
  type MigrationItem,
} from '../src/work-item-migration'

const sourceNames = ['work-items', 'legacy-tasks'] as const
const checkpointVersion = 1
const scanPageSize = 100

/** Migration source の識別子です。 */
type SourceName = typeof sourceNames[number]

/** DynamoDB scan checkpoint key です。 */
type DynamoKey = Record<string, unknown>

/** Migration の table 設定です。 */
type TableNames = {
  /** Canonical Work Item を保存する既存 TeamIssues table です。 */
  workItems: string
  /** Read-only に切り替える legacy ProjectTasks table です。 */
  legacyTasks: string
  /** Project と owner team の対応を取得する directory table です。 */
  projectDirectory: string
}

/** Checkpoint を AWS account / region / endpoint 単位で分離する環境識別子です。 */
type MigrationEnvironmentIdentity = {
  /** Local emulator を含む DynamoDB endpoint です。 */
  endpoint?: string
  /** DynamoDB client が接続する AWS region です。 */
  region: string
  /** DescribeTable で取得した table ごとの ARN です。 */
  tableArns: Record<keyof TableNames, string>
}

/** CLI option です。 */
type MigrationOptions = {
  /** DynamoDB と checkpoint を更新しない preview mode です。 */
  dryRun: boolean
  /** Migration 後の状態だけを検証する mode です。 */
  verify: boolean
  /** Help を表示するかどうかです。 */
  help: boolean
  /** Resumable scan checkpoint の保存先です。 */
  checkpointPath: string
  /** Source ごとに処理する最大 item 数です。 */
  limit?: number
  /** Ambiguous project の明示 owner team mapping です。 */
  projectTeamMappings: ReadonlyMap<string, string>
}

/** Source ごとの集計値です。 */
type MigrationCounters = {
  /** Scan した item 数です。 */
  scanned: number
  /** 新規作成または version 補完した item 数です。 */
  written: number
  /** 既に同じ状態だった item 数です。 */
  unchanged: number
  /** Conditional race 後に同じ状態と確認できた item 数です。 */
  duplicates: number
  /** Operator 判断が必要な衝突数です。 */
  conflicts: number
  /** Canonical row へ変換できなかった item 数です。 */
  skipped: number
}

/** 1 source の resumable state です。 */
type SourceCheckpoint = {
  /** Source の全 scan が完了したかどうかです。 */
  completed: boolean
  /** 次 page の ExclusiveStartKey です。 */
  lastEvaluatedKey?: DynamoKey
  /** 累積 counter です。 */
  counters: MigrationCounters
}

/** Checkpoint file の schema です。 */
type CheckpointState = {
  /** Checkpoint schema version です。 */
  version: 1
  /** 異なる table/mapping での誤再利用を防ぐ hash です。 */
  configurationHash: string
  /** 最終更新日時です。 */
  updatedAt: string
  /** Source ごとの scan state です。 */
  sources: Record<SourceName, SourceCheckpoint>
}

/** Source item processor の結果です。 */
type ProcessResult = 'written' | 'unchanged' | 'duplicate' | 'conflict' | 'skipped'

async function main() {
  const options = parseArguments(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  const tableNames = readTableNames()
  const endpoint = readEnvironment('DYNAMODB_ENDPOINT') ??
    readEnvironment('AWS_ENDPOINT_URL_DYNAMODB') ??
    readEnvironment('AWS_ENDPOINT_URL')
  const region = readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'us-east-1'
  const dynamoDbClient = new DynamoDBClient({
    ...(endpoint ? { endpoint } : {}),
    ...(endpoint
      ? {
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
    region,
  })
  const client = DynamoDBDocumentClient.from(
    dynamoDbClient,
    { marshallOptions: { removeUndefinedValues: true } },
  )
  const environmentIdentity: MigrationEnvironmentIdentity = {
    ...(endpoint ? { endpoint } : {}),
    region,
    tableArns: await readTableArns(dynamoDbClient, tableNames),
  }
  const directoryItems = await scanAllItems(client, tableNames.projectDirectory)
  const ownership = createProjectOwnership(directoryItems)
  const configurationHash = createConfigurationHash(tableNames, environmentIdentity, options)
  const checkpoint = options.dryRun || options.verify
    ? createEmptyCheckpoint(configurationHash)
    : await readCheckpoint(options.checkpointPath, configurationHash)

  await migrateSource(
    'work-items',
    tableNames.workItems,
    client,
    checkpoint,
    options,
    async (item) => processWorkItem(item, client, tableNames.workItems, options),
  )
  await migrateSource(
    'legacy-tasks',
    tableNames.legacyTasks,
    client,
    checkpoint,
    options,
    async (item) => processLegacyTask(
      item,
      ownership,
      client,
      tableNames.workItems,
      options,
    ),
  )

  printSummary(checkpoint, options)
  const hasConflicts = sourceNames.some((sourceName) => {
    const counters = checkpoint.sources[sourceName].counters
    return counters.conflicts > 0 || counters.skipped > 0
  })

  if (hasConflicts) {
    throw new Error('Work Item migration finished with unresolved conflicts or skipped rows.')
  }
}

async function migrateSource(
  sourceName: SourceName,
  tableName: string,
  client: DynamoDBDocumentClient,
  checkpoint: CheckpointState,
  options: MigrationOptions,
  processItem: (item: MigrationItem) => Promise<ProcessResult>,
) {
  const source = checkpoint.sources[sourceName]

  if (source.completed && !options.dryRun && !options.verify) {
    return
  }

  let lastEvaluatedKey = source.lastEvaluatedKey
  let processedThisRun = 0

  do {
    const remaining = options.limit === undefined ? scanPageSize : options.limit - processedThisRun
    if (remaining <= 0) {
      break
    }

    const response = await client.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        ExclusiveStartKey: lastEvaluatedKey,
        Limit: Math.min(scanPageSize, remaining),
      }),
    )
    const conflictsBeforePage = source.counters.conflicts + source.counters.skipped

    for (const item of response.Items ?? []) {
      source.counters.scanned += 1
      processedThisRun += 1
      const result = await processItem(item)
      incrementCounter(source.counters, result)
    }

    const conflictsAfterPage = source.counters.conflicts + source.counters.skipped
    if (conflictsAfterPage > conflictsBeforePage && !options.dryRun && !options.verify) {
      printSummary(checkpoint, options)
      throw new Error(
        `${sourceName} contains unresolved rows. Fix the reported data or mapping and rerun with the same checkpoint.`,
      )
    }

    lastEvaluatedKey = response.LastEvaluatedKey
    source.lastEvaluatedKey = lastEvaluatedKey
    source.completed = !lastEvaluatedKey
    checkpoint.updatedAt = new Date().toISOString()

    if (!options.dryRun && !options.verify) {
      await writeCheckpoint(options.checkpointPath, checkpoint)
    }
  } while (lastEvaluatedKey)
}

async function processWorkItem(
  item: MigrationItem,
  client: DynamoDBDocumentClient,
  tableName: string,
  options: MigrationOptions,
): Promise<ProcessResult> {
  if (hasUnsupportedWorkItemVersion(item)) {
    console.error(
      `Unsupported Work Item schema: ${String(item.directoryTeamId)}/${String(item.issueId)} ` +
      `schemaVersion=${String(item.schemaVersion)}`,
    )
    return 'conflict'
  }

  if (hasCurrentWorkItemVersion(item)) {
    return 'unchanged'
  }

  if (item.revision !== undefined && (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1)) {
    console.error(
      `Invalid Work Item revision: ${String(item.directoryTeamId)}/${String(item.issueId)} ` +
      `revision=${String(item.revision)}`,
    )
    return 'conflict'
  }

  const directoryTeamId = readRequiredString(item.directoryTeamId)
  const issueId = readRequiredString(item.issueId)
  if (!directoryTeamId || !issueId) {
    console.error('Work Item row is missing directoryTeamId or issueId.')
    return 'skipped'
  }

  if (options.verify) {
    console.error(`Work Item version is incomplete: ${directoryTeamId}/${issueId}`)
    return 'conflict'
  }
  if (options.dryRun) {
    return 'written'
  }

  const setExpressions: string[] = []
  const conditionExpressions = [
    'attribute_exists(directoryTeamId)',
    'attribute_exists(issueId)',
  ]
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}

  if (item.schemaVersion === undefined) {
    names['#schemaVersion'] = 'schemaVersion'
    values[':schemaVersion'] = WORK_ITEM_SCHEMA_VERSION
    setExpressions.push('#schemaVersion = :schemaVersion')
    conditionExpressions.push('attribute_not_exists(#schemaVersion)')
  }
  if (item.revision === undefined) {
    names['#revision'] = 'revision'
    values[':revision'] = 1
    setExpressions.push('#revision = :revision')
    conditionExpressions.push('attribute_not_exists(#revision)')
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { directoryTeamId, issueId },
        UpdateExpression: `SET ${setExpressions.join(', ')}`,
        ConditionExpression: conditionExpressions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    )
    return 'written'
  } catch (error) {
    if (!isNamedError(error, 'ConditionalCheckFailedException')) {
      throw error
    }

    const current = await readWorkItem(client, tableName, directoryTeamId, issueId)
    return current && hasCurrentWorkItemVersion(current) ? 'duplicate' : 'conflict'
  }
}

async function processLegacyTask(
  task: MigrationItem,
  ownership: ReturnType<typeof createProjectOwnership>,
  client: DynamoDBDocumentClient,
  workItemsTableName: string,
  options: MigrationOptions,
): Promise<ProcessResult> {
  const directoryId = readRequiredString(task.directoryId)
  const projectId = readRequiredString(task.projectId)
  if (!directoryId || !projectId) {
    console.error('Legacy task is missing directoryId or projectId.')
    return 'skipped'
  }

  const owner = resolveProjectOwnerTeam(
    ownership,
    directoryId,
    projectId,
    options.projectTeamMappings,
  )
  if (!owner.ok) {
    console.error(owner.reason)
    return 'conflict'
  }

  const converted = createMigratedWorkItem({ task, teamId: owner.teamId })
  if (!converted.ok) {
    console.error(converted.reason)
    return 'skipped'
  }

  const directoryTeamId = converted.item.directoryTeamId as string
  const issueId = converted.item.issueId as string
  const current = await readWorkItem(client, workItemsTableName, directoryTeamId, issueId)
  if (current) {
    if (
      current.migrationFingerprint === converted.item.migrationFingerprint ||
      hasEquivalentWorkItemState(current, converted.item)
    ) {
      return 'unchanged'
    }
    console.error(`Work Item collision: ${directoryTeamId}/${issueId}`)
    return 'conflict'
  }

  if (options.verify) {
    console.error(`Migrated Work Item is missing: ${directoryTeamId}/${issueId}`)
    return 'conflict'
  }
  if (options.dryRun) {
    return 'written'
  }

  try {
    await client.send(
      new PutCommand({
        TableName: workItemsTableName,
        Item: converted.item,
        ConditionExpression: 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)',
      }),
    )
    return 'written'
  } catch (error) {
    if (!isNamedError(error, 'ConditionalCheckFailedException')) {
      throw error
    }

    const racedItem = await readWorkItem(client, workItemsTableName, directoryTeamId, issueId)
    return racedItem && (
      racedItem.migrationFingerprint === converted.item.migrationFingerprint ||
      hasEquivalentWorkItemState(racedItem, converted.item)
    )
      ? 'duplicate'
      : 'conflict'
  }
}

async function readWorkItem(
  client: DynamoDBDocumentClient,
  tableName: string,
  directoryTeamId: string,
  issueId: string,
) {
  const response = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { directoryTeamId, issueId },
      ConsistentRead: true,
    }),
  )

  return response.Item
}

async function scanAllItems(client: DynamoDBDocumentClient, tableName: string) {
  const items: MigrationItem[] = []
  let lastEvaluatedKey: DynamoKey | undefined

  do {
    const response = await client.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    )
    items.push(...(response.Items ?? []))
    lastEvaluatedKey = response.LastEvaluatedKey
  } while (lastEvaluatedKey)

  return items
}

function parseArguments(args: string[]): MigrationOptions {
  let dryRun = false
  let verify = false
  let help = false
  let checkpointPath = resolve('.mukuroji/work-item-migration.json')
  let limit: number | undefined
  const projectTeamMappings = new Map<string, string>()

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument === '--verify') {
      verify = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--checkpoint') {
      checkpointPath = resolve(readNextArgument(args, ++index, '--checkpoint'))
      continue
    }
    if (argument === '--limit') {
      const parsedLimit = Number(readNextArgument(args, ++index, '--limit'))
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
        throw new Error('--limit must be a positive integer.')
      }
      limit = parsedLimit
      continue
    }
    if (argument === '--project-team') {
      const mapping = readNextArgument(args, ++index, '--project-team')
      const assignmentSeparatorIndex = mapping.indexOf('=')
      const directoryProject = mapping.slice(0, assignmentSeparatorIndex).trim()
      const scopeSeparatorIndex = directoryProject.lastIndexOf('/')
      const directoryId = directoryProject.slice(0, scopeSeparatorIndex).trim()
      const projectId = directoryProject.slice(scopeSeparatorIndex + 1).trim()
      const teamId = mapping.slice(assignmentSeparatorIndex + 1).trim()
      if (
        assignmentSeparatorIndex < 1 ||
        assignmentSeparatorIndex === mapping.length - 1 ||
        scopeSeparatorIndex < 1 ||
        scopeSeparatorIndex === directoryProject.length - 1 ||
        !directoryId ||
        !projectId ||
        !teamId
      ) {
        throw new Error('--project-team must use <directoryId>/<projectId>=<teamId>.')
      }
      projectTeamMappings.set(
        createProjectOwnershipKey(directoryId, projectId),
        teamId,
      )
      continue
    }

    throw new Error(`Unknown argument: ${argument}`)
  }

  if (dryRun && verify) {
    throw new Error('--dry-run and --verify cannot be used together.')
  }

  return { dryRun, verify, help, checkpointPath, limit, projectTeamMappings }
}

function readTableNames(): TableNames {
  return {
    workItems: readRequiredEnvironment(
      'WORK_ITEMS_TABLE_NAME',
      'MUKUROJI_WORK_ITEMS_TABLE',
      'TEAM_ISSUES_TABLE_NAME',
      'MUKUROJI_TEAM_ISSUES_TABLE',
    ),
    legacyTasks: readRequiredEnvironment(
      'PROJECT_TASKS_TABLE_NAME',
      'TASKS_TABLE_NAME',
      'MUKUROJI_PROJECT_TASKS_TABLE',
    ),
    projectDirectory: readRequiredEnvironment(
      'PROJECT_DIRECTORY_TABLE_NAME',
      'MUKUROJI_PROJECT_DIRECTORY_TABLE',
    ),
  }
}

function readRequiredEnvironment(...names: string[]) {
  for (const name of names) {
    const value = readEnvironment(name)
    if (value) {
      return value
    }
  }

  throw new Error(`One of ${names.join(', ')} is required.`)
}

function createConfigurationHash(
  tableNames: TableNames,
  environmentIdentity: MigrationEnvironmentIdentity,
  options: MigrationOptions,
) {
  return createHash('sha256').update(JSON.stringify({
    tableNames,
    environmentIdentity,
    mode: options.verify ? 'verify' : 'migrate',
    projectTeamMappings: [...options.projectTeamMappings].sort(([left], [right]) =>
      left.localeCompare(right)),
  })).digest('hex')
}

async function readTableArns(client: DynamoDBClient, tableNames: TableNames) {
  const entries = await Promise.all(
    (Object.entries(tableNames) as Array<[keyof TableNames, string]>).map(
      async ([key, tableName]) => {
        const response = await client.send(new DescribeTableCommand({ TableName: tableName }))
        const tableArn = response.Table?.TableArn

        if (!tableArn) {
          throw new Error(`DescribeTable did not return TableArn for "${tableName}".`)
        }

        return [key, tableArn] as const
      },
    ),
  )

  return Object.fromEntries(entries) as Record<keyof TableNames, string>
}

async function readCheckpoint(path: string, configurationHash: string): Promise<CheckpointState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isCheckpointState(parsed) || parsed.configurationHash !== configurationHash) {
      throw new Error(`Checkpoint is invalid or belongs to another configuration: ${path}`)
    }
    return parsed
  } catch (error) {
    if (!isNamedError(error, 'ENOENT')) {
      throw error
    }
    return createEmptyCheckpoint(configurationHash)
  }
}

function createEmptyCheckpoint(configurationHash: string): CheckpointState {
  return {
    version: checkpointVersion,
    configurationHash,
    updatedAt: new Date().toISOString(),
    sources: {
      'work-items': createEmptySourceCheckpoint(),
      'legacy-tasks': createEmptySourceCheckpoint(),
    },
  }
}

function createEmptySourceCheckpoint(): SourceCheckpoint {
  return {
    completed: false,
    counters: {
      scanned: 0,
      written: 0,
      unchanged: 0,
      duplicates: 0,
      conflicts: 0,
      skipped: 0,
    },
  }
}

async function writeCheckpoint(path: string, checkpoint: CheckpointState) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, undefined, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

function isCheckpointState(value: unknown): value is CheckpointState {
  if (!isRecord(value) || value.version !== checkpointVersion) {
    return false
  }
  if (typeof value.configurationHash !== 'string' || typeof value.updatedAt !== 'string') {
    return false
  }
  const sources = value.sources
  if (!isRecord(sources)) {
    return false
  }

  return sourceNames.every((sourceName) => isSourceCheckpoint(sources[sourceName]))
}

function isSourceCheckpoint(value: unknown): value is SourceCheckpoint {
  if (!isRecord(value) || typeof value.completed !== 'boolean' || !isRecord(value.counters)) {
    return false
  }

  const counters = value.counters
  return ['scanned', 'written', 'unchanged', 'duplicates', 'conflicts', 'skipped']
    .every((key) => typeof counters[key] === 'number') &&
    (value.lastEvaluatedKey === undefined || isRecord(value.lastEvaluatedKey))
}

function incrementCounter(counters: MigrationCounters, result: ProcessResult) {
  if (result === 'written') {
    counters.written += 1
  } else if (result === 'unchanged') {
    counters.unchanged += 1
  } else if (result === 'duplicate') {
    counters.duplicates += 1
  } else if (result === 'conflict') {
    counters.conflicts += 1
  } else {
    counters.skipped += 1
  }
}

function printSummary(checkpoint: CheckpointState, options: MigrationOptions) {
  const mode = options.verify ? 'verify' : options.dryRun ? 'dry-run' : 'apply'
  for (const sourceName of sourceNames) {
    const source = checkpoint.sources[sourceName]
    const counters = source.counters
    console.info(
      `${sourceName}: mode=${mode} completed=${source.completed} scanned=${counters.scanned} ` +
      `written=${counters.written} unchanged=${counters.unchanged} duplicates=${counters.duplicates} ` +
      `conflicts=${counters.conflicts} skipped=${counters.skipped}`,
    )
  }
}

function readNextArgument(args: string[], index: number, option: string) {
  const value = args[index]
  if (!value) {
    throw new Error(`${option} requires a value.`)
  }
  return value
}

function readRequiredString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readEnvironment(name: string) {
  return process.env[name]?.trim() || undefined
}

function isNamedError(error: unknown, nameOrCode: string) {
  return isRecord(error) && (error.name === nameOrCode || error.code === nameOrCode)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function printHelp() {
  console.info(`Usage: bun run work-items:migrate -- [options]\n\n` +
    `Required environment:\n` +
    `  WORK_ITEMS_TABLE_NAME (or TEAM_ISSUES_TABLE_NAME)\n` +
    `  PROJECT_TASKS_TABLE_NAME (or TASKS_TABLE_NAME)\n` +
    `  PROJECT_DIRECTORY_TABLE_NAME\n\n` +
    `Options:\n` +
    `  --dry-run                         Preview writes and detect collisions\n` +
    `  --verify                          Verify every legacy row has a canonical copy\n` +
    `  --checkpoint <path>               Resumable apply checkpoint\n` +
    `  --limit <count>                   Process at most count rows per source\n` +
    `  --project-team <directory>/<project>=<team>\n` +
    `                                    Resolve an ambiguous Workspace project owner\n` +
    `  --help                            Show this help`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
