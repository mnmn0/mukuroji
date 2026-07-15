import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'

/** Migration が適用する Work Item configuration schema version です。 */
export { WORK_ITEM_CONFIGURATION_SCHEMA_VERSION }

/** Legacy Work Item status に対応する workflow category です。 */
export type WorkItemStatusCategory = 'completed' | 'started' | 'unstarted'

/** Migration が認識する既存 Work Item status です。 */
export type LegacyWorkItemStatus = 'done' | 'in-progress' | 'review' | 'todo'

/** DynamoDB DocumentClient が返す汎用 item です。 */
export type WorkItemMigrationItem = Record<string, unknown>

/** Work Item configuration metadata の additive backfill 値です。 */
export type WorkItemConfigurationBackfill = {
  /** Workflow metadata 自体の schema version です。 */
  workflowSchemaVersion?: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /** 既存 status と同一 ID の default workflow status です。 */
  workflowStatusId?: LegacyWorkItemStatus
  /** Workflow status を横断集計する category です。 */
  statusCategory?: WorkItemStatusCategory
  /** Custom field definition ID ごとの保存値です。 */
  customFieldValues?: Record<string, never>
}

/** Conditional update に必要な Work Item identity です。 */
export type WorkItemConfigurationBackfillTarget = {
  /** Canonical Work Item の partition key です。 */
  directoryTeamId: string
  /** Canonical Work Item の sort key です。 */
  issueId: string
  /** Race 検出に使う Work Item revision です。 */
  expectedRevision: number
  /** Validation 時点の既存 status です。 */
  expectedStatus: LegacyWorkItemStatus
}

/** 1 Work Item の configuration backfill 計画です。 */
export type WorkItemConfigurationBackfillPlan =
  | {
      /** Metadata が不足し、安全に additive update できる状態です。 */
      action: 'backfill'
      /** Conditional update 対象です。 */
      target: WorkItemConfigurationBackfillTarget
      /** 未設定 field だけを含む update 値です。 */
      updates: WorkItemConfigurationBackfill
    }
  | {
      /** Metadata が既に現行契約を満たす状態です。 */
      action: 'unchanged'
      /** 検証済み Work Item identity です。 */
      target: WorkItemConfigurationBackfillTarget
    }
  | {
      /** Operator 確認なしでは変更できない不正状態です。 */
      action: 'invalid'
      /** Fail-closed にした理由です。 */
      reason: string
    }

/** Migration CLI の動作 mode です。 */
type MigrationMode = 'apply' | 'dry-run' | 'preflight' | 'verify'

/** Migration CLI option です。 */
type MigrationOptions = {
  /** 実行する migration mode です。 */
  mode: Exclude<MigrationMode, 'preflight'>
  /** DynamoDB Scan 1 page の最大評価件数です。 */
  pageSize: number
  /** 1 run で評価する最大 Work Item 件数です。 */
  limit?: number
  /** Help だけを表示するかどうかです。 */
  help: boolean
}

/** Migration pass の集計値です。 */
export type MigrationCounters = {
  /** Scan で評価した Work Item 件数です。 */
  scanned: number
  /** Apply で更新した Work Item 件数です。 */
  updated: number
  /** 既に metadata が揃っていた件数です。 */
  unchanged: number
  /** Conditional race 後に同じ状態を確認した件数です。 */
  duplicates: number
  /** Concurrent edit により次回実行へ持ち越した件数です。 */
  conflicts: number
  /** Dry-run で update 対象と判定した件数です。 */
  wouldUpdate: number
  /** Verify で metadata 不足と判定した件数です。 */
  missing: number
  /** 不正 schema/status/metadata と判定した件数です。 */
  invalid: number
}

/** Migration pass の依存関係です。 */
type MigrationPassInput = {
  /** Work Items table 名です。 */
  tableName: string
  /** DynamoDB DocumentClient です。 */
  client: DynamoDBDocumentClient
  /** Pass の動作 mode です。 */
  mode: MigrationMode
  /** DynamoDB Scan 1 page の最大評価件数です。 */
  pageSize: number
  /** 1 pass で評価する最大 Work Item 件数です。 */
  limit?: number
}

/** Work Item configuration migration runner の入力です。 */
export type WorkItemConfigurationMigrationInput = {
  /** Work Items table 名です。 */
  tableName: string
  /** DynamoDB DocumentClient です。 */
  client: DynamoDBDocumentClient
  /** 実行する migration mode です。 */
  mode: Exclude<MigrationMode, 'preflight'>
  /** DynamoDB Scan 1 page の最大評価件数です。 */
  pageSize: number
  /** Dry-run または verify で評価する最大 Work Item 件数です。 */
  limit?: number
}

/** Work Item configuration migration runner の結果です。 */
export type WorkItemConfigurationMigrationResult =
  | {
      /** 全件 preflight で不正行を検出し、apply を開始しなかった状態です。 */
      outcome: 'preflight-failed'
      /** 失敗した preflight の集計値です。 */
      counters: MigrationCounters
    }
  | {
      /** 指定 mode の pass を最後まで実行した状態です。 */
      outcome: 'completed'
      /** 指定 mode の集計値です。 */
      counters: MigrationCounters
    }

/**
 * Legacy status に対応する workflow category を返します。
 *
 * @param status - 既存 Work Item status です。
 * @returns 対応 category。不明 status の場合は undefined です。
 */
export function statusCategoryForLegacyStatus(status: unknown): WorkItemStatusCategory | undefined {
  if (status === 'todo') {
    return 'unstarted'
  }
  if (status === 'in-progress' || status === 'review') {
    return 'started'
  }
  if (status === 'done') {
    return 'completed'
  }

  return undefined
}

/**
 * 既存 Work Item を検証し、未設定 configuration metadata だけの backfill を計画します。
 *
 * 既に存在する metadata は上書きしません。既存 status と矛盾する workflow metadata、
 * 未知 Work Item schema、または不正 key/revision は operator 判断が必要な invalid とします。
 *
 * @param value - DynamoDB から読み取った Work Item 候補です。
 * @returns Backfill、unchanged、invalid の判定です。
 */
export function planWorkItemConfigurationBackfill(
  value: unknown,
): WorkItemConfigurationBackfillPlan {
  if (!isRecord(value)) {
    return { action: 'invalid', reason: 'Work Item row must be an object.' }
  }
  if (value.schemaVersion !== WORK_ITEM_SCHEMA_VERSION) {
    return {
      action: 'invalid',
      reason: `Unsupported Work Item schema version: ${String(value.schemaVersion)}.`,
    }
  }

  const directoryTeamId = readRequiredString(value.directoryTeamId)
  const issueId = readRequiredString(value.issueId)
  if (!directoryTeamId || !issueId) {
    return { action: 'invalid', reason: 'Work Item key is missing or invalid.' }
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    return { action: 'invalid', reason: 'Work Item revision must be a positive integer.' }
  }

  const status = readLegacyWorkItemStatus(value.status)
  const statusCategory = statusCategoryForLegacyStatus(status)
  if (!status || !statusCategory) {
    return { action: 'invalid', reason: `Unsupported Work Item status: ${String(value.status)}.` }
  }

  const target: WorkItemConfigurationBackfillTarget = {
    directoryTeamId,
    issueId,
    expectedRevision: value.revision as number,
    expectedStatus: status,
  }

  if (
    value.workflowSchemaVersion !== undefined &&
    value.workflowSchemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  ) {
    return {
      action: 'invalid',
      reason: `Unsupported workflow schema version: ${String(value.workflowSchemaVersion)}.`,
    }
  }
  if (value.workflowStatusId !== undefined && value.workflowStatusId !== status) {
    return {
      action: 'invalid',
      reason: 'workflowStatusId does not match the legacy Work Item status.',
    }
  }
  if (value.statusCategory !== undefined && value.statusCategory !== statusCategory) {
    return {
      action: 'invalid',
      reason: 'statusCategory does not match the legacy Work Item status.',
    }
  }
  if (
    value.customFieldValues !== undefined &&
    !isMigrationCustomFieldValueRecord(value.customFieldValues)
  ) {
    return { action: 'invalid', reason: 'customFieldValues contains an invalid value.' }
  }

  const updates: WorkItemConfigurationBackfill = {}
  if (value.workflowSchemaVersion === undefined) {
    updates.workflowSchemaVersion = WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  }
  if (value.workflowStatusId === undefined) {
    updates.workflowStatusId = status
  }
  if (value.statusCategory === undefined) {
    updates.statusCategory = statusCategory
  }
  if (value.customFieldValues === undefined) {
    updates.customFieldValues = {}
  }

  return Object.keys(updates).length === 0
    ? { action: 'unchanged', target }
    : { action: 'backfill', target, updates }
}

/**
 * Work Item が現行 configuration metadata 契約を満たすか判定します。
 *
 * @param value - DynamoDB Work Item 候補です。
 * @returns 現行 metadata が揃っている場合は true です。
 */
export function hasWorkItemConfigurationMetadata(value: unknown) {
  return planWorkItemConfigurationBackfill(value).action === 'unchanged'
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const tableName = readRequiredEnvironment('WORK_ITEMS_TABLE_NAME')
  const endpoint = readEnvironment('DYNAMODB_ENDPOINT') ??
    readEnvironment('AWS_ENDPOINT_URL_DYNAMODB') ??
    readEnvironment('AWS_ENDPOINT_URL')
  const region = readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'us-east-1'
  const dynamoDbClient = new DynamoDBClient({
    region,
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })
  const client = DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })

  const result = await runWorkItemConfigurationMigration({
    tableName,
    client,
    mode: options.mode,
    pageSize: options.pageSize,
    limit: options.limit,
  })
  if (result.outcome === 'preflight-failed') {
    printSummary(result.counters, 'preflight')
    throw new Error('Work Item configuration migration preflight found invalid rows.')
  }

  printSummary(result.counters, options.mode)

  if (
    result.counters.invalid > 0 ||
    result.counters.missing > 0 ||
    result.counters.conflicts > 0
  ) {
    throw new Error('Work Item configuration migration did not satisfy the schema contract.')
  }
}

/**
 * Work Item configuration migration を安全な pass 順序で実行します。
 *
 * Apply は必ず無制限の全件 preflight を先に完了し、不正行が1件でもあれば
 * update を開始しません。`limit` は部分 apply を防ぐため runner でも拒否します。
 *
 * @param input - Table、client、実行 mode と scan option です。
 * @returns 完了した pass、または apply 前に失敗した preflight の集計値です。
 */
export async function runWorkItemConfigurationMigration(
  input: WorkItemConfigurationMigrationInput,
): Promise<WorkItemConfigurationMigrationResult> {
  if (input.mode === 'apply' && input.limit !== undefined) {
    throw new Error('--limit is only available with --dry-run or --verify.')
  }

  if (input.mode === 'apply') {
    const preflight = await runMigrationPass({
      tableName: input.tableName,
      client: input.client,
      mode: 'preflight',
      pageSize: input.pageSize,
    })
    if (preflight.invalid > 0) {
      return { outcome: 'preflight-failed', counters: preflight }
    }
  }

  const counters = await runMigrationPass({
    tableName: input.tableName,
    client: input.client,
    mode: input.mode,
    pageSize: input.pageSize,
    limit: input.limit,
  })
  return { outcome: 'completed', counters }
}

async function runMigrationPass(input: MigrationPassInput): Promise<MigrationCounters> {
  const counters = createEmptyCounters()
  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
    const remaining = input.limit === undefined ? input.pageSize : input.limit - counters.scanned
    if (remaining <= 0) {
      break
    }

    const response = await input.client.send(new ScanCommand({
      TableName: input.tableName,
      ConsistentRead: true,
      ExclusiveStartKey: exclusiveStartKey,
      Limit: Math.min(input.pageSize, remaining),
    }))

    for (const item of response.Items ?? []) {
      counters.scanned += 1
      const plan = planWorkItemConfigurationBackfill(item)
      if (plan.action === 'invalid') {
        counters.invalid += 1
        console.error(`invalid ${formatWorkItemKey(item)}: ${plan.reason}`)
        continue
      }
      if (plan.action === 'unchanged') {
        counters.unchanged += 1
        continue
      }
      if (input.mode === 'preflight') {
        continue
      }
      if (input.mode === 'dry-run') {
        counters.wouldUpdate += 1
        continue
      }
      if (input.mode === 'verify') {
        counters.missing += 1
        console.error(`missing ${formatTargetKey(plan.target)}: configuration metadata is incomplete.`)
        continue
      }

      const result = await applyBackfill(input.client, input.tableName, plan)
      counters[result] += 1
    }

    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey && (input.limit === undefined || counters.scanned < input.limit))

  return counters
}

async function applyBackfill(
  client: DynamoDBDocumentClient,
  tableName: string,
  plan: Extract<WorkItemConfigurationBackfillPlan, { action: 'backfill' }>,
): Promise<'conflicts' | 'duplicates' | 'updated'> {
  const expressionAttributeNames: Record<string, string> = {
    '#schemaVersion': 'schemaVersion',
    '#revision': 'revision',
    '#status': 'status',
  }
  const expressionAttributeValues: Record<string, unknown> = {
    ':schemaVersion': WORK_ITEM_SCHEMA_VERSION,
    ':expectedRevision': plan.target.expectedRevision,
    ':expectedStatus': plan.target.expectedStatus,
  }
  const setExpressions: string[] = []
  const conditions = [
    'attribute_exists(directoryTeamId)',
    'attribute_exists(issueId)',
    '#schemaVersion = :schemaVersion',
    '#revision = :expectedRevision',
    '#status = :expectedStatus',
  ]

  for (const [field, value] of Object.entries(plan.updates)) {
    const name = `#${field}`
    const placeholder = `:${field}`
    expressionAttributeNames[name] = field
    expressionAttributeValues[placeholder] = value
    setExpressions.push(`${name} = ${placeholder}`)
    conditions.push(`attribute_not_exists(${name})`)
  }

  try {
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        directoryTeamId: plan.target.directoryTeamId,
        issueId: plan.target.issueId,
      },
      UpdateExpression: `SET ${setExpressions.join(', ')}`,
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }))
    return 'updated'
  } catch (error) {
    if (!isNamedError(error, 'ConditionalCheckFailedException')) {
      throw error
    }

    const latest = await client.send(new GetCommand({
      TableName: tableName,
      Key: {
        directoryTeamId: plan.target.directoryTeamId,
        issueId: plan.target.issueId,
      },
      ConsistentRead: true,
    }))
    const latestPlan = planWorkItemConfigurationBackfill(latest.Item)
    if (latestPlan.action === 'unchanged') {
      return 'duplicates'
    }

    const reason = latestPlan.action === 'invalid'
      ? latestPlan.reason
      : 'Work Item changed while configuration metadata was being migrated; ' +
        'it will be retried on the next run.'
    console.error(`conflict ${formatTargetKey(plan.target)}: ${reason}`)
    return 'conflicts'
  }
}

/** Migration CLI 引数を検証済み option へ変換します。 */
export function parseArguments(args: string[]): MigrationOptions {
  let mode: MigrationOptions['mode'] = 'apply'
  let modeWasSelected = false
  let pageSize = 100
  let limit: number | undefined
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--dry-run' || argument === '--verify') {
      if (modeWasSelected) {
        throw new Error('--dry-run and --verify cannot be used together.')
      }
      mode = argument === '--dry-run' ? 'dry-run' : 'verify'
      modeWasSelected = true
      continue
    }
    if (argument === '--page-size') {
      pageSize = readPositiveInteger(readNextArgument(args, ++index, '--page-size'), '--page-size', 1_000)
      continue
    }
    if (argument === '--limit') {
      limit = readPositiveInteger(readNextArgument(args, ++index, '--limit'), '--limit')
      continue
    }
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }

    throw new Error(`Unknown argument: ${argument}`)
  }

  if (!help && mode === 'apply' && limit !== undefined) {
    throw new Error('--limit is only available with --dry-run or --verify.')
  }

  return { mode, pageSize, limit, help }
}

function isMigrationCustomFieldValueRecord(value: unknown) {
  return isRecord(value) && Object.values(value).every((fieldValue) =>
    typeof fieldValue === 'string' ||
    typeof fieldValue === 'boolean' ||
    (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) ||
    (
      Array.isArray(fieldValue) &&
      fieldValue.every((entry) => typeof entry === 'string')
    ),
  )
}

function readLegacyWorkItemStatus(value: unknown): LegacyWorkItemStatus | undefined {
  return value === 'done' || value === 'in-progress' || value === 'review' || value === 'todo'
    ? value
    : undefined
}

function createEmptyCounters(): MigrationCounters {
  return {
    scanned: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    conflicts: 0,
    wouldUpdate: 0,
    missing: 0,
    invalid: 0,
  }
}

function readPositiveInteger(value: string, option: string, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${option} must be an integer between 1 and ${maximum}.`)
  }
  return parsed
}

function readNextArgument(args: string[], index: number, option: string) {
  const value = args[index]
  if (!value) {
    throw new Error(`${option} requires a value.`)
  }
  return value
}

function readRequiredEnvironment(name: string) {
  const value = readEnvironment(name)
  if (!value) {
    throw new Error(`${name} is required.`)
  }
  return value
}

function readEnvironment(name: string) {
  return process.env[name]?.trim() || undefined
}

function readRequiredString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function formatWorkItemKey(item: WorkItemMigrationItem) {
  return `${String(item.directoryTeamId ?? '<missing-team>')}/${String(item.issueId ?? '<missing-issue>')}`
}

function formatTargetKey(target: WorkItemConfigurationBackfillTarget) {
  return `${target.directoryTeamId}/${target.issueId}`
}

function isNamedError(error: unknown, nameOrCode: string) {
  return isRecord(error) && (error.name === nameOrCode || error.code === nameOrCode)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function printSummary(counters: MigrationCounters, mode: MigrationMode) {
  console.info(
    `work-items: mode=${mode} scanned=${counters.scanned} updated=${counters.updated} ` +
    `unchanged=${counters.unchanged} duplicates=${counters.duplicates} conflicts=${counters.conflicts} ` +
    `wouldUpdate=${counters.wouldUpdate} missing=${counters.missing} invalid=${counters.invalid}`,
  )
}

function printHelp() {
  console.info(`Usage: bun run work-item-configuration:migrate -- [options]\n\n` +
    `Required environment:\n` +
    `  WORK_ITEMS_TABLE_NAME\n\n` +
    `Options:\n` +
    `  --dry-run             Validate rows and preview additive updates\n` +
    `  --verify              Fail when metadata is missing or invalid\n` +
    `  --page-size <count>   Scan page size (1-1000, default 100)\n` +
    `  --limit <count>       Evaluate at most count rows\n` +
    `  --help                Show this help`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
