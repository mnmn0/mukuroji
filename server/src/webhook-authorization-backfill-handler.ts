import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  createWebhookMemberAuthorizationKey,
  createWebhookProjectAuthorizationSortKey,
  createWebhookResourceAuthorizationKey,
  createWebhookTeamAuthorizationSortKey,
  createWebhookTeamGrantItem,
} from './webhook-authorization-projection'

/** Backfill が認識する Project directory source row です。 */
type WebhookAuthorizationSourceRow = {
  /** Workspace partition key です。 */
  directoryId: string
  /** Base table sort key です。 */
  entryKey: string
  /** Source row discriminator です。 */
  entryType: 'team' | 'project' | 'project-member'
  /** Team ID です。 */
  teamId?: string
  /** Project ID です。 */
  projectId?: string
  /** Project member key です。 */
  memberKey?: string
  /** Project role です。 */
  role?: 'viewer' | 'member' | 'manager'
  /** Archive timestamp です。 */
  archivedAt?: string
}

/** Grant が強整合で再検証する Team / Project source row です。 */
type WebhookAuthorizationGrantSource = {
  /** Grant の Team source row です。 */
  team: WebhookAuthorizationSourceRow
  /** Grant の Project source row です。 */
  project: WebhookAuthorizationSourceRow
}

/** Backfill の永続 checkpoint が示す処理段階です。 */
type WebhookAuthorizationBackfillPhase =
  | 'projection'
  | 'verification'
  | 'grants'
  | 'complete'

/** DynamoDB Scan の再開位置です。 */
type WebhookAuthorizationBackfillCursor = Record<string, unknown>

/** Backfill の再開位置と進捗を保持する永続 row です。 */
type WebhookAuthorizationBackfillCheckpoint = {
  /** Checkpoint 専用 partition key です。 */
  directoryId: string
  /** Checkpoint 専用 sort key です。 */
  entryKey: string
  /** Checkpoint row discriminator です。 */
  entryType: 'webhook-authorization-backfill-checkpoint'
  /** Schema migration version です。 */
  migrationVersion: typeof WEBHOOK_AUTHORIZATION_BACKFILL_VERSION
  /** 現在の処理段階です。 */
  phase: WebhookAuthorizationBackfillPhase
  /** Compare-and-swap に使う revision です。 */
  revision: number
  /** 現在の Scan 再開位置です。 */
  scanCursor?: WebhookAuthorizationBackfillCursor
  /** Projection を更新した source row 数です。 */
  sourceRowsUpdated: number
  /** GSI 反映を確認した source row 数です。 */
  sourceRowsVerified: number
  /** 冪等 Put した Team/member grant 数です。 */
  grantsWritten: number
}

/** CloudFormation Provider が渡す custom resource event です。 */
export type WebhookAuthorizationBackfillEvent = {
  /** CloudFormation request 種別です。 */
  RequestType?: 'Create' | 'Update' | 'Delete'
  /** onEvent response から isComplete へ渡す削除時の短絡 flag です。 */
  SkipMigration?: boolean
  /** Custom resource properties です。 */
  ResourceProperties?: {
    /** 実行対象 migration version です。 */
    MigrationVersion?: string
  }
}

/** Backfill の1回の progress Lambda 実行結果です。 */
export type WebhookAuthorizationBackfillProgress = {
  /** Migration が完了したかどうかです。 */
  isComplete: boolean
  /** 永続化済み checkpoint です。 */
  checkpoint: WebhookAuthorizationBackfillCheckpoint
}

/** Backfill の bounded write concurrency です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY = 16
/** 1回の progress Lambda が処理する最大 Scan item 数です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_PAGE_SIZE = 50
/** GSI の反映確認と locator 読み取りに使う1 page の上限です。 */
const WEBHOOK_AUTHORIZATION_QUERY_PAGE_SIZE = 50
/** Backfill schema version です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_VERSION = 'v1'
/** CloudFormation resource の安定 physical ID です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_PHYSICAL_ID =
  `webhook-authorization-projection-backfill-${WEBHOOK_AUTHORIZATION_BACKFILL_VERSION}`
/** 通常 directory partition から隔離した checkpoint partition key です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID =
  `WEBHOOK_AUTHORIZATION_BACKFILL#${WEBHOOK_AUTHORIZATION_BACKFILL_VERSION}`
/** Checkpoint sort key です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY = 'CHECKPOINT'
/** Webhook authorization sparse GSI の既定名です。 */
const DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME = 'WebhookAuthorizationIndex'

/** Backfill checkpoint を未作成の場合だけ冪等初期化します。 */
export async function startWebhookAuthorizationBackfill(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: createInitialCheckpoint(),
      ConditionExpression: 'attribute_not_exists(directoryId)',
    }))
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error
  }
}

/**
 * Retain 済み source row を1 pageだけ処理し、永続 checkpoint を進めます。
 *
 * Projection 更新、GSI 反映確認、grant 作成を別 phase にすることで、
 * GSI の eventual consistency を越えてから grant join を開始します。
 */
export async function processWebhookAuthorizationBackfillPage(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  authorizationIndexName = DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME,
): Promise<WebhookAuthorizationBackfillProgress> {
  const current = await readCheckpoint(documentClient, tableName)
  if (current.phase === 'complete') {
    return { isComplete: true, checkpoint: current }
  }

  const response = await documentClient.send(new ScanCommand({
    TableName: tableName,
    ConsistentRead: true,
    Limit: WEBHOOK_AUTHORIZATION_BACKFILL_PAGE_SIZE,
    ProjectionExpression:
      'directoryId, entryKey, #entryType, teamId, projectId, memberKey, #role, archivedAt',
    ExpressionAttributeNames: {
      '#entryType': 'entryType',
      '#role': 'role',
    },
    ...(current.scanCursor
      ? { ExclusiveStartKey: current.scanCursor }
      : {}),
  }))
  const rows = (response.Items ?? []).flatMap((value) => {
    const row = readSourceRow(value)
    return row ? [row] : []
  })

  let sourceRowsUpdated = 0
  let sourceRowsVerified = 0
  let grantsWritten = 0

  if (current.phase === 'projection') {
    await runBounded(rows.map((row) => async () => {
      if (await updateSourceProjection(documentClient, tableName, row)) {
        sourceRowsUpdated += 1
      }
    }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
  } else if (current.phase === 'verification') {
    const results: boolean[] = []
    await runBounded(rows.map((row) => async () => {
      const visible = await isSourceProjectionVisible(
        documentClient,
        tableName,
        authorizationIndexName,
        row,
      )
      results.push(visible)
      if (visible) sourceRowsVerified += 1
    }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
    if (results.some((visible) => !visible)) {
      return { isComplete: false, checkpoint: current }
    }
  } else {
    const activeTeamCache = new Map<
      string,
      Promise<WebhookAuthorizationSourceRow | undefined>
    >()
    const activeProjectCache =
      new Map<string, Promise<WebhookAuthorizationSourceRow[]>>()
    const members = rows.filter((row) =>
      row.entryType === 'project-member' &&
      row.archivedAt === undefined
    )
    await runBounded(members.map((member) => async () => {
      grantsWritten += await writeMemberTeamGrants(
        documentClient,
        tableName,
        authorizationIndexName,
        member,
        activeProjectCache,
        activeTeamCache,
      )
    }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
  }

  const next = createNextCheckpoint(
    current,
    response.LastEvaluatedKey,
    {
      sourceRowsUpdated,
      sourceRowsVerified,
      grantsWritten,
    },
  )
  const persisted = await persistCheckpoint(
    documentClient,
    tableName,
    current.revision,
    next,
  )
  if (!persisted) {
    return {
      isComplete: false,
      checkpoint: await readCheckpoint(documentClient, tableName),
    }
  }
  return {
    isComplete: next.phase === 'complete',
    checkpoint: next,
  }
}

/** CloudFormation custom resource onEvent entrypoint です。 */
export async function handler(event: WebhookAuthorizationBackfillEvent) {
  readMigrationVersion(event)
  const tableName = readRequiredEnvironment('PROJECT_DIRECTORY_TABLE_NAME')
  if (event.RequestType === 'Delete') {
    await deleteCheckpoint(createDocumentClient(), tableName)
    return {
      PhysicalResourceId: WEBHOOK_AUTHORIZATION_BACKFILL_PHYSICAL_ID,
      SkipMigration: true,
    }
  }
  await startWebhookAuthorizationBackfill(createDocumentClient(), tableName)
  return {
    PhysicalResourceId: WEBHOOK_AUTHORIZATION_BACKFILL_PHYSICAL_ID,
  }
}

/** CloudFormation custom resource の pagewise isComplete entrypoint です。 */
export async function isCompleteHandler(
  event: WebhookAuthorizationBackfillEvent,
) {
  readMigrationVersion(event)
  if (event.SkipMigration || event.RequestType === 'Delete') {
    return { IsComplete: true }
  }
  const tableName = readRequiredEnvironment('PROJECT_DIRECTORY_TABLE_NAME')
  const documentClient = createDocumentClient()
  await startWebhookAuthorizationBackfill(documentClient, tableName)
  const result = await processWebhookAuthorizationBackfillPage(
    documentClient,
    tableName,
    process.env.PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME ??
      DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME,
  )
  return result.isComplete
    ? {
        IsComplete: true,
        Data: {
          SourceRowsUpdated: result.checkpoint.sourceRowsUpdated,
          SourceRowsVerified: result.checkpoint.sourceRowsVerified,
          GrantsWritten: result.checkpoint.grantsWritten,
        },
      }
    : { IsComplete: false }
}

async function deleteCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  await documentClient.send(new DeleteCommand({
    TableName: tableName,
    Key: {
      directoryId: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID,
      entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
    },
  }))
}

function createInitialCheckpoint(): WebhookAuthorizationBackfillCheckpoint {
  return {
    directoryId: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID,
    entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
    entryType: 'webhook-authorization-backfill-checkpoint',
    migrationVersion: WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
    phase: 'projection',
    revision: 0,
    sourceRowsUpdated: 0,
    sourceRowsVerified: 0,
    grantsWritten: 0,
  }
}

async function readCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      directoryId: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID,
      entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
    },
    ConsistentRead: true,
  }))
  const value = response.Item
  if (
    !value ||
    value.directoryId !== WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID ||
    value.entryKey !== WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY ||
    value.entryType !== 'webhook-authorization-backfill-checkpoint' ||
    value.migrationVersion !== WEBHOOK_AUTHORIZATION_BACKFILL_VERSION ||
    (
      value.phase !== 'projection' &&
      value.phase !== 'verification' &&
      value.phase !== 'grants' &&
      value.phase !== 'complete'
    ) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.sourceRowsUpdated) ||
    !Number.isSafeInteger(value.sourceRowsVerified) ||
    !Number.isSafeInteger(value.grantsWritten) ||
    (
      value.scanCursor !== undefined &&
      !isRecord(value.scanCursor)
    )
  ) {
    throw new TypeError('Webhook authorization backfill checkpoint is invalid.')
  }
  return value as WebhookAuthorizationBackfillCheckpoint
}

function createNextCheckpoint(
  current: WebhookAuthorizationBackfillCheckpoint,
  lastEvaluatedKey: WebhookAuthorizationBackfillCursor | undefined,
  increments: {
    sourceRowsUpdated: number
    sourceRowsVerified: number
    grantsWritten: number
  },
) {
  const nextPhase = lastEvaluatedKey
    ? current.phase
    : current.phase === 'projection'
      ? 'verification'
      : current.phase === 'verification'
        ? 'grants'
        : 'complete'
  return {
    ...current,
    phase: nextPhase,
    revision: current.revision + 1,
    ...(lastEvaluatedKey ? { scanCursor: lastEvaluatedKey } : {}),
    ...(!lastEvaluatedKey && current.scanCursor ? { scanCursor: undefined } : {}),
    sourceRowsUpdated:
      current.sourceRowsUpdated + increments.sourceRowsUpdated,
    sourceRowsVerified:
      current.sourceRowsVerified + increments.sourceRowsVerified,
    grantsWritten: current.grantsWritten + increments.grantsWritten,
  } satisfies WebhookAuthorizationBackfillCheckpoint
}

async function persistCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  expectedRevision: number,
  next: WebhookAuthorizationBackfillCheckpoint,
) {
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: next,
      ConditionExpression:
        '#entryType = :entryType AND #revision = :expectedRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'webhook-authorization-backfill-checkpoint',
        ':expectedRevision': expectedRevision,
      },
    }))
    return true
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false
    throw error
  }
}

async function updateSourceProjection(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  row: WebhookAuthorizationSourceRow,
) {
  const projection = createSourceProjection(row)
  try {
    await documentClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        directoryId: row.directoryId,
        entryKey: row.entryKey,
      },
      UpdateExpression:
        'SET webhookAuthorizationKey = :authorizationKey, ' +
        'webhookAuthorizationSortKey = :authorizationSortKey',
      ConditionExpression: '#entryType = :entryType',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
      },
      ExpressionAttributeValues: {
        ':entryType': row.entryType,
        ':authorizationKey': projection.webhookAuthorizationKey,
        ':authorizationSortKey': projection.webhookAuthorizationSortKey,
      },
    }))
    return true
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false
    throw error
  }
}

async function isSourceProjectionVisible(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  authorizationIndexName: string,
  row: WebhookAuthorizationSourceRow,
) {
  const projection = createSourceProjection(row)
  const locators = await queryAuthorizationLocators(
    documentClient,
    tableName,
    authorizationIndexName,
    projection.webhookAuthorizationKey,
    projection.webhookAuthorizationSortKey,
  )
  return locators.some((locator) =>
    locator.directoryId === row.directoryId &&
    locator.entryKey === row.entryKey
  )
}

async function writeMemberTeamGrants(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  authorizationIndexName: string,
  member: WebhookAuthorizationSourceRow,
  activeProjectCache: Map<string, Promise<WebhookAuthorizationSourceRow[]>>,
  activeTeamCache: Map<
    string,
    Promise<WebhookAuthorizationSourceRow | undefined>
  >,
) {
  const projectCacheKey = `${member.directoryId}\0${member.projectId}`
  const activeProjects = await readThrough(
    activeProjectCache,
    projectCacheKey,
    async () => {
      const rows = await readAuthorizationSourceRows(
        documentClient,
        tableName,
        authorizationIndexName,
        createWebhookResourceAuthorizationKey(member.directoryId),
        createWebhookProjectAuthorizationSortKey(member.projectId!),
      )
      return rows.filter((row) =>
        row.entryType === 'project' &&
        row.projectId === member.projectId &&
        row.archivedAt === undefined
      )
    },
  )
  const grantSources = new Map<string, WebhookAuthorizationGrantSource>()
  for (const project of activeProjects) {
    const teamCacheKey = `${member.directoryId}\0${project.teamId}`
    const team = await readThrough(
      activeTeamCache,
      teamCacheKey,
      async () => {
        const rows = await readAuthorizationSourceRows(
          documentClient,
          tableName,
          authorizationIndexName,
          createWebhookResourceAuthorizationKey(member.directoryId),
          createWebhookTeamAuthorizationSortKey(project.teamId!),
        )
        return rows.find((row) =>
          row.entryType === 'team' &&
          row.teamId === project.teamId &&
          row.archivedAt === undefined
        )
      },
    )
    if (team && project.teamId && !grantSources.has(project.teamId)) {
      grantSources.set(project.teamId, { team, project })
    }
  }
  await runBounded([...grantSources.entries()].map(([teamId, source]) => async () => {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: createWebhookTeamGrantItem({
        workspaceId: member.directoryId,
        teamId,
        projectId: member.projectId!,
        memberKey: member.memberKey!,
        teamSourceEntryKey: source.team.entryKey,
        projectSourceEntryKey: source.project.entryKey,
      }),
    }))
  }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
  return grantSources.size
}

async function readAuthorizationSourceRows(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  authorizationIndexName: string,
  authorizationKey: string,
  authorizationSortKey: string,
) {
  const locators = await queryAuthorizationLocators(
    documentClient,
    tableName,
    authorizationIndexName,
    authorizationKey,
    authorizationSortKey,
  )
  const rows: WebhookAuthorizationSourceRow[] = []
  await runBounded(locators.map((locator) => async () => {
    const response = await documentClient.send(new GetCommand({
      TableName: tableName,
      Key: locator,
      ConsistentRead: true,
    }))
    const row = readSourceRow(response.Item ?? {})
    if (row) rows.push(row)
  }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
  return rows
}

async function queryAuthorizationLocators(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  authorizationIndexName: string,
  authorizationKey: string,
  authorizationSortKey: string,
) {
  const locators: Array<{ directoryId: string; entryKey: string }> = []
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const response = await documentClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: authorizationIndexName,
      KeyConditionExpression:
        'webhookAuthorizationKey = :authorizationKey AND ' +
        'webhookAuthorizationSortKey = :authorizationSortKey',
      ExpressionAttributeValues: {
        ':authorizationKey': authorizationKey,
        ':authorizationSortKey': authorizationSortKey,
      },
      ProjectionExpression: 'directoryId, entryKey',
      Limit: WEBHOOK_AUTHORIZATION_QUERY_PAGE_SIZE,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))
    for (const value of response.Items ?? []) {
      if (
        typeof value.directoryId === 'string' &&
        typeof value.entryKey === 'string'
      ) {
        locators.push({
          directoryId: value.directoryId,
          entryKey: value.entryKey,
        })
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)
  return locators
}

function readSourceRow(
  value: Record<string, unknown>,
): WebhookAuthorizationSourceRow | undefined {
  if (
    value.entryType !== 'team' &&
    value.entryType !== 'project' &&
    value.entryType !== 'project-member'
  ) {
    return undefined
  }
  if (
    typeof value.directoryId !== 'string' ||
    typeof value.entryKey !== 'string' ||
    (
      value.archivedAt !== undefined &&
      typeof value.archivedAt !== 'string'
    )
  ) {
    throw new TypeError('Project directory source row is invalid.')
  }
  const archivedAt = value.archivedAt === undefined
    ? {}
    : { archivedAt: value.archivedAt }
  if (
    value.entryType === 'team' &&
    typeof value.teamId === 'string'
  ) {
    return {
      directoryId: value.directoryId,
      entryKey: value.entryKey,
      entryType: value.entryType,
      teamId: value.teamId,
      ...archivedAt,
    }
  }
  if (
    value.entryType === 'project' &&
    typeof value.teamId === 'string' &&
    typeof value.projectId === 'string'
  ) {
    return {
      directoryId: value.directoryId,
      entryKey: value.entryKey,
      entryType: value.entryType,
      teamId: value.teamId,
      projectId: value.projectId,
      ...archivedAt,
    }
  }
  if (
    value.entryType === 'project-member' &&
    typeof value.projectId === 'string' &&
    typeof value.memberKey === 'string' &&
    (
      value.role === 'viewer' ||
      value.role === 'member' ||
      value.role === 'manager'
    )
  ) {
    return {
      directoryId: value.directoryId,
      entryKey: value.entryKey,
      entryType: value.entryType,
      projectId: value.projectId,
      memberKey: value.memberKey,
      role: value.role,
      ...archivedAt,
    }
  }
  throw new TypeError('Project directory source row is invalid.')
}

function createSourceProjection(row: WebhookAuthorizationSourceRow) {
  if (row.entryType === 'team') {
    return {
      webhookAuthorizationKey:
        createWebhookResourceAuthorizationKey(row.directoryId),
      webhookAuthorizationSortKey:
        createWebhookTeamAuthorizationSortKey(row.teamId!),
    }
  }
  if (row.entryType === 'project') {
    return {
      webhookAuthorizationKey:
        createWebhookResourceAuthorizationKey(row.directoryId),
      webhookAuthorizationSortKey:
        createWebhookProjectAuthorizationSortKey(row.projectId!),
    }
  }
  return {
    webhookAuthorizationKey:
      createWebhookMemberAuthorizationKey(row.directoryId, row.memberKey!),
    webhookAuthorizationSortKey:
      createWebhookProjectAuthorizationSortKey(row.projectId!),
  }
}

async function readThrough<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  read: () => Promise<V>,
) {
  const cached = cache.get(key)
  if (cached) return await cached
  const pending = read()
  cache.set(key, pending)
  return await pending
}

async function runBounded(
  writes: Array<() => Promise<unknown>>,
  concurrency: number,
) {
  for (let index = 0; index < writes.length; index += concurrency) {
    await Promise.all(writes
      .slice(index, index + concurrency)
      .map(async (write) => await write()))
  }
}

function isConditionalCheckFailure(error: unknown) {
  return isRecord(error) &&
    error.name === 'ConditionalCheckFailedException'
}

function readMigrationVersion(event: WebhookAuthorizationBackfillEvent) {
  const version = event.ResourceProperties?.MigrationVersion
  if (
    version !== undefined &&
    version !== WEBHOOK_AUTHORIZATION_BACKFILL_VERSION
  ) {
    throw new TypeError('Webhook authorization migration version is invalid.')
  }
}

function createDocumentClient() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function readRequiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new TypeError(`${name} is required.`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
