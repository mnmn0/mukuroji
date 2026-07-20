import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  createWebhookMemberAuthorizationKey,
  createWebhookGrantCleanupItem,
  createWebhookProjectAuthorizationSortKey,
  createWebhookResourceAuthorizationKey,
  createWebhookTeamAuthorizationSortKey,
  createWebhookTeamGrantItem,
} from '../../webhook-authorization-projection'

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

/** v1 migrationが作成したcleanup locatorなしのgrant rowです。 */
type WebhookAuthorizationGrantRow = {
  /** Grant partition keyです。 */
  directoryId: string
  /** Grant sort keyです。 */
  entryKey: string
  /** Grant discriminatorです。 */
  entryType: 'webhook-team-grant'
  /** Workspace IDです。 */
  workspaceId: string
  /** Team IDです。 */
  teamId: string
  /** Project IDです。 */
  projectId: string
  /** Project member keyです。 */
  memberKey: string
  /** Authoritative member sort keyです。 */
  sourceEntryKey: string
  /** Authoritative Team sort keyです。 */
  teamSourceEntryKey: string
  /** Authoritative Project sort keyです。 */
  projectSourceEntryKey: string
  /** Sparse authorization index partition keyです。 */
  webhookAuthorizationKey: string
  /** Sparse authorization index sort keyです。 */
  webhookAuthorizationSortKey: string
}

/** Legacy GSI から primary locator へ移行する Webhook subscription row です。 */
type WebhookActiveLocatorSourceRow = {
  /** Workspace partition key です。 */
  workspaceId: string
  /** Subscription base row の sort key です。 */
  recordKey: string
  /** Subscription row discriminator です。 */
  entryType: 'webhook-subscription'
  /** Subscription の migration に必要な最小 domain value です。 */
  value: {
    /** Webhook subscription ID です。 */
    id: string
    /** Stable locator ordering timestamp です。 */
    createdAt: string
    /** Active locator の有無を決めるstatusです。 */
    status: 'active' | 'paused' | 'disabled'
  }
  /** Legacy GSI partition key です。 */
  lookupKey?: string
  /** Legacy GSI sort key です。 */
  lookupSortKey?: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAt?: number
  /** Concurrent mutation を検出するrow revisionです。 */
  version: number
}

/** Backfill の永続 checkpoint が示す処理段階です。 */
type WebhookAuthorizationBackfillPhase =
  | 'active-locators'
  | 'legacy-locator-cleanup'
  | 'projection'
  | 'verification'
  | 'grants'
  | 'grant-cleanup'
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
  /** 旧writer invocationが終了するまでscanを待機する日時です。 */
  writerDrainUntil: string
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
  /** v1 stale grantを削除した数です。 */
  grantsDeleted: number
  /** Active grantへ補完したcleanup locator数です。 */
  cleanupLocatorsWritten: number
  /** Primary active locator を整合させたsubscription数です。 */
  activeLocatorsReconciled: number
  /** Base row から除去したlegacy lookup数です。 */
  legacyLookupsRemoved: number
}

/** Rollback 時の legacy active locator 復元 checkpoint です。 */
type WebhookActiveLocatorRollbackCheckpoint = {
  /** 通常 directory partition から隔離した partition key です。 */
  directoryId: string
  /** Checkpoint sort key です。 */
  entryKey: string
  /** Rollback checkpoint discriminator です。 */
  entryType: 'webhook-active-locator-rollback-checkpoint'
  /** Schema migration version です。 */
  migrationVersion: typeof WEBHOOK_AUTHORIZATION_BACKFILL_VERSION
  /** Primary-only writer invocation が終了するまで待機する日時です。 */
  writerDrainUntil: string
  /** Compare-and-swap に使う revision です。 */
  revision: number
  /** 現在の Scan 再開位置です。 */
  scanCursor?: WebhookAuthorizationBackfillCursor
  /** Legacy locator を整合させた subscription 数です。 */
  legacyLookupsReconciled: number
}

/** Rollback の1回の progress Lambda 実行結果です。 */
type WebhookActiveLocatorRollbackProgress = {
  /** Rollback が完了したかどうかです。 */
  isComplete: boolean
  /** Checkpoint がこの page で前進したかどうかです。 */
  madeProgress: boolean
  /** 完了前の永続 checkpoint です。 */
  checkpoint?: WebhookActiveLocatorRollbackCheckpoint
}

/** CloudFormation Provider が渡す custom resource event です。 */
export type WebhookAuthorizationBackfillEvent = {
  /** CloudFormation request 種別です。 */
  RequestType?: 'Create' | 'Update' | 'Delete'
  /** Provider が現在のresourceへ割り当てたphysical IDです。 */
  PhysicalResourceId?: string
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
  /** Checkpoint がこの page で前進したかどうかです。 */
  madeProgress: boolean
  /** 永続化済み checkpoint です。 */
  checkpoint: WebhookAuthorizationBackfillCheckpoint
}

/** 1 invocation 内で複数 page を処理する際の上限です。 */
export type WebhookAuthorizationBackfillBatchOptions = {
  /** 1 invocation で処理する最大 page 数です。 */
  maxPages: number
  /** 次の page を開始できる time budget が残っているかを返します。 */
  canProcessNextPage: () => boolean
  /** Writer drain と各pageの判定時刻を返すclockです。 */
  now?: () => Date
  /** Active Webhook locatorを移行するDeveloper platform table名です。 */
  developerPlatformTableName?: string
}

/** Lambda の残り実行時間を参照する最小 context contract です。 */
type WebhookAuthorizationBackfillLambdaContext = {
  /** Lambda invocation の残り時間をミリ秒で返します。 */
  getRemainingTimeInMillis: () => number
}

/** Backfill の bounded write concurrency です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY = 16
/** 1回の progress Lambda が処理する最大 Scan item 数です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_PAGE_SIZE = 50
/** 疎な migration row を全表走査する1 pageの最大item数です。 */
const WEBHOOK_AUTHORIZATION_SPARSE_SCAN_PAGE_SIZE = 1_000
/** 1回の progress Lambda invocation が処理する最大 page 数です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_MAX_PAGES_PER_INVOCATION = 100
/** 次の page を開始せず checkpoint を返す残り実行時間です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_TIME_RESERVE_MILLISECONDS = 30_000
/** GSI の反映確認と locator 読み取りに使う1 page の上限です。 */
const WEBHOOK_AUTHORIZATION_QUERY_PAGE_SIZE = 50
/** 旧API/projection/delivery invocationをdrainする待機秒数です。 */
const WEBHOOK_AUTHORIZATION_WRITER_DRAIN_SECONDS = 60
/** Rollback marker のCAS競合を同一request内で再試行する上限です。 */
const WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_START_MAX_ATTEMPTS = 4
/** Forward checkpoint 初期化のCAS競合を同一request内で再試行する上限です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_START_MAX_ATTEMPTS = 4
/** Backfill schema version です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_VERSION = 'v3'
/** CloudFormation resource の安定 physical ID です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_PHYSICAL_ID =
  `webhook-authorization-projection-backfill-${WEBHOOK_AUTHORIZATION_BACKFILL_VERSION}`
/** 通常 directory partition から隔離した checkpoint partition key です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID =
  `WEBHOOK_AUTHORIZATION_BACKFILL#${WEBHOOK_AUTHORIZATION_BACKFILL_VERSION}`
/** Checkpoint sort key です。 */
const WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY = 'CHECKPOINT'
/** Rollback checkpoint を隔離する partition key です。 */
const WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_CHECKPOINT_DIRECTORY_ID =
  `WEBHOOK_ACTIVE_LOCATOR_ROLLBACK#${WEBHOOK_AUTHORIZATION_BACKFILL_VERSION}`
/** Webhook authorization sparse GSI の既定名です。 */
const DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME = 'WebhookAuthorizationIndex'
/** Active Webhook locator migration row の partition key です。 */
const WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID =
  'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'
/** Active Webhook locator migration row の sort key です。 */
const WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY = 'STATE'
/** Active Webhook locator migration row の discriminator です。 */
const WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE =
  'webhook-active-locator-migration'

/** Backfill checkpoint を未作成の場合だけ冪等初期化します。 */
export async function startWebhookAuthorizationBackfill(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  now = new Date(),
  developerPlatformTableName = tableName,
) {
  const startedAt = readDate(now, 'Backfill start time')
  let lastConditionalFailure: unknown
  for (
    let attempt = 0;
    attempt < WEBHOOK_AUTHORIZATION_BACKFILL_START_MAX_ATTEMPTS;
    attempt += 1
  ) {
    if (await readOptionalCheckpoint(documentClient, tableName)) return
    const activeLocatorMigration = await ensureWebhookActiveLocatorCutover(
      documentClient,
      developerPlatformTableName,
      startedAt,
    )
    const checkpoint = createInitialCheckpoint(
      startedAt,
      undefined,
      activeLocatorMigration.state === 'complete'
        ? 'legacy-locator-cleanup'
        : 'active-locators',
    )
    try {
      if (activeLocatorMigration.state === 'complete') {
        await documentClient.send(new PutCommand({
          TableName: tableName,
          Item: checkpoint,
          ConditionExpression: 'attribute_not_exists(directoryId)',
        }))
      } else {
        await documentClient.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: developerPlatformTableName,
                Key: {
                  workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
                  recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
                },
                UpdateExpression:
                  'SET #value.#writerDrainUntil = :writerDrainUntil, ' +
                  '#version = #version + :one',
                ConditionExpression:
                  '#entryType = :migrationEntryType AND ' +
                  '#value.#migrationVersion = :migrationVersion AND ' +
                  '#value.#state = :cutover AND #version = :expectedVersion',
                ExpressionAttributeNames: {
                  '#entryType': 'entryType',
                  '#value': 'value',
                  '#writerDrainUntil': 'writerDrainUntil',
                  '#migrationVersion': 'migrationVersion',
                  '#state': 'state',
                  '#version': 'version',
                },
                ExpressionAttributeValues: {
                  ':migrationEntryType':
                    WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE,
                  ':migrationVersion':
                    WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
                  ':cutover': 'cutover',
                  ':expectedVersion': activeLocatorMigration.version,
                  ':writerDrainUntil': checkpoint.writerDrainUntil,
                  ':one': 1,
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: checkpoint,
                ConditionExpression: 'attribute_not_exists(directoryId)',
              },
            },
          ],
        }))
      }
      return
    } catch (error) {
      if (
        !isConditionalCheckFailure(error) &&
        (
          !isRecord(error) ||
          error.name !== 'TransactionCanceledException'
        )
      ) throw error
      lastConditionalFailure = error
    }
  }
  throw lastConditionalFailure ??
    new Error('Webhook authorization backfill could not start.')
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
  now = new Date(),
  developerPlatformTableName = tableName,
): Promise<WebhookAuthorizationBackfillProgress> {
  const current = await readCheckpoint(documentClient, tableName)
  if (current.phase === 'complete') {
    return { isComplete: true, madeProgress: false, checkpoint: current }
  }
  if (Date.parse(current.writerDrainUntil) > readDate(now, 'Backfill clock').getTime()) {
    return { isComplete: false, madeProgress: false, checkpoint: current }
  }

  const activeLocatorPhase =
    current.phase === 'active-locators' ||
    current.phase === 'legacy-locator-cleanup'
  const sparseScanPhase = activeLocatorPhase ||
    current.phase === 'grant-cleanup'
  const response = await documentClient.send(new ScanCommand({
    TableName: activeLocatorPhase ? developerPlatformTableName : tableName,
    ConsistentRead: true,
    Limit: sparseScanPhase
      ? WEBHOOK_AUTHORIZATION_SPARSE_SCAN_PAGE_SIZE
      : WEBHOOK_AUTHORIZATION_BACKFILL_PAGE_SIZE,
    ProjectionExpression: activeLocatorPhase
      ? 'workspaceId, recordKey, #entryType, #value, lookupKey, ' +
        'lookupSortKey, expiresAt, #version'
      : 'directoryId, entryKey, #entryType, workspaceId, teamId, projectId, ' +
        'memberKey, #role, archivedAt, sourceEntryKey, teamSourceEntryKey, ' +
        'projectSourceEntryKey, webhookAuthorizationKey, ' +
        'webhookAuthorizationSortKey',
    ...(activeLocatorPhase
      ? {
          FilterExpression: '#entryType = :subscriptionEntryType',
          ExpressionAttributeNames: {
            '#entryType': 'entryType',
            '#value': 'value',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':subscriptionEntryType': 'webhook-subscription',
          },
        }
      : {
          ExpressionAttributeNames: {
            '#entryType': 'entryType',
            '#role': 'role',
          },
        }),
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
  let grantsDeleted = 0
  let cleanupLocatorsWritten = 0
  let activeLocatorsReconciled = 0
  let legacyLookupsRemoved = 0

  if (activeLocatorPhase) {
    const activeRows = (response.Items ?? []).flatMap((value) => {
      const row = readWebhookActiveLocatorSourceRow(value)
      return row ? [row] : []
    })
    const results: Array<'reconciled' | 'retry'> = []
    await runBounded(activeRows.map((row) => async () => {
      const result = await reconcileWebhookActiveLocator(
        documentClient,
        developerPlatformTableName,
        row,
        now,
        current.phase === 'legacy-locator-cleanup',
      )
      results.push(result.status)
      if (current.phase === 'active-locators') {
        activeLocatorsReconciled += result.reconciled
      } else {
        legacyLookupsRemoved += result.legacyLookupRemoved
      }
    }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
    if (results.includes('retry')) {
      return {
        isComplete: false,
        madeProgress: false,
        checkpoint: current,
      }
    }
  } else if (current.phase === 'projection') {
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
      return {
        isComplete: false,
        madeProgress: false,
        checkpoint: current,
      }
    }
  } else if (current.phase === 'grants') {
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
  } else {
    const grants = (response.Items ?? []).flatMap((value) => {
      const grant = readGrantRow(value)
      return grant ? [grant] : []
    })
    await runBounded(grants.map((grant) => async () => {
      const result = await reconcileLegacyGrant(
        documentClient,
        tableName,
        grant,
      )
      grantsDeleted += result.deleted
      cleanupLocatorsWritten += result.locatorWritten
    }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
  }

  const createdNext = createNextCheckpoint(
    current,
    response.LastEvaluatedKey,
    {
      sourceRowsUpdated,
      sourceRowsVerified,
      grantsWritten,
      grantsDeleted,
      cleanupLocatorsWritten,
      activeLocatorsReconciled,
      legacyLookupsRemoved,
    },
  )
  const completesLocatorCutover =
    current.phase === 'active-locators' &&
    createdNext.phase === 'legacy-locator-cleanup'
  const next = completesLocatorCutover
    ? {
        ...createdNext,
        writerDrainUntil: new Date(
          readDate(now, 'Backfill clock').getTime() +
            WEBHOOK_AUTHORIZATION_WRITER_DRAIN_SECONDS * 1_000,
        ).toISOString(),
      }
    : createdNext
  const persisted = await persistCheckpoint(
    documentClient,
    tableName,
    developerPlatformTableName,
    current.revision,
    next,
    completesLocatorCutover,
  )
  if (!persisted) {
    const checkpoint = await readCheckpoint(documentClient, tableName)
    return {
      isComplete: false,
      madeProgress: checkpoint.revision !== current.revision,
      checkpoint,
    }
  }
  return {
    isComplete: next.phase === 'complete',
    madeProgress: true,
    checkpoint: next,
  }
}

/**
 * 1 invocation 内で checkpoint を page ごとに保存しながら複数 page を進めます。
 *
 * GSI が未反映で page が前進しない場合は busy loop を避け、次の
 * CloudFormation provider poll まで待機します。
 */
export async function processWebhookAuthorizationBackfillPages(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  authorizationIndexName: string,
  options: WebhookAuthorizationBackfillBatchOptions,
): Promise<WebhookAuthorizationBackfillProgress> {
  if (
    !Number.isSafeInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > WEBHOOK_AUTHORIZATION_BACKFILL_MAX_PAGES_PER_INVOCATION
  ) {
    throw new TypeError('Webhook authorization backfill max pages is invalid.')
  }
  let result = await processWebhookAuthorizationBackfillPage(
    documentClient,
    tableName,
    authorizationIndexName,
    options.now?.() ?? new Date(),
    options.developerPlatformTableName ?? tableName,
  )
  for (
    let pagesProcessed = 1;
    pagesProcessed < options.maxPages &&
    !result.isComplete &&
    result.madeProgress &&
    options.canProcessNextPage();
    pagesProcessed += 1
  ) {
    result = await processWebhookAuthorizationBackfillPage(
      documentClient,
      tableName,
      authorizationIndexName,
      options.now?.() ?? new Date(),
      options.developerPlatformTableName ?? tableName,
    )
  }
  return result
}

/** CloudFormation custom resource onEvent entrypoint です。 */
export async function handler(event: WebhookAuthorizationBackfillEvent) {
  const tableName = readRequiredEnvironment('PROJECT_DIRECTORY_TABLE_NAME')
  const developerPlatformTableName =
    readRequiredEnvironment('DEVELOPER_PLATFORM_TABLE_NAME')
  return await processWebhookAuthorizationBackfillEvent(
    event,
    createDocumentClient(),
    tableName,
    developerPlatformTableName,
  )
}

/** Custom resource eventを指定したProject directoryへ適用します。 */
export async function processWebhookAuthorizationBackfillEvent(
  event: WebhookAuthorizationBackfillEvent,
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  developerPlatformTableName = tableName,
) {
  if (event.RequestType === 'Delete') {
    const deletingVersion = readKnownDeletingMigrationVersion(event)
    if (deletingVersion === WEBHOOK_AUTHORIZATION_BACKFILL_VERSION) {
      const rollbackRequired = await startWebhookActiveLocatorRollback(
        documentClient,
        tableName,
        developerPlatformTableName,
      )
      return {
        ...(event.PhysicalResourceId
          ? { PhysicalResourceId: event.PhysicalResourceId }
          : {}),
        ...(!rollbackRequired ? { SkipMigration: true } : {}),
      }
    }
    if (deletingVersion) {
      await deleteCheckpoint(documentClient, tableName, deletingVersion)
    }
    return {
      ...(event.PhysicalResourceId
        ? { PhysicalResourceId: event.PhysicalResourceId }
        : {}),
      SkipMigration: true,
    }
  }
  readMigrationVersion(event)
  await startWebhookAuthorizationBackfill(
    documentClient,
    tableName,
    new Date(),
    developerPlatformTableName,
  )
  return {
    PhysicalResourceId: WEBHOOK_AUTHORIZATION_BACKFILL_PHYSICAL_ID,
  }
}

/** CloudFormation custom resource の pagewise isComplete entrypoint です。 */
export async function isCompleteHandler(
  event: WebhookAuthorizationBackfillEvent,
  context?: WebhookAuthorizationBackfillLambdaContext,
) {
  if (event.SkipMigration) {
    return { IsComplete: true }
  }
  if (event.RequestType === 'Delete') {
    if (
      readKnownDeletingMigrationVersion(event) !==
        WEBHOOK_AUTHORIZATION_BACKFILL_VERSION
    ) {
      return { IsComplete: true }
    }
    const tableName = readRequiredEnvironment('PROJECT_DIRECTORY_TABLE_NAME')
    const developerPlatformTableName =
      readRequiredEnvironment('DEVELOPER_PLATFORM_TABLE_NAME')
    const result = await processWebhookActiveLocatorRollbackPages(
      createDocumentClient(),
      tableName,
      developerPlatformTableName,
      {
        maxPages: WEBHOOK_AUTHORIZATION_BACKFILL_MAX_PAGES_PER_INVOCATION,
        canProcessNextPage: () =>
          !context ||
          context.getRemainingTimeInMillis() >
            WEBHOOK_AUTHORIZATION_BACKFILL_TIME_RESERVE_MILLISECONDS,
      },
    )
    return result.isComplete
      ? {
          IsComplete: true,
          Data: {
            LegacyLookupsReconciled:
              result.checkpoint?.legacyLookupsReconciled ?? 0,
          },
        }
      : { IsComplete: false }
  }
  readMigrationVersion(event)
  const tableName = readRequiredEnvironment('PROJECT_DIRECTORY_TABLE_NAME')
  const developerPlatformTableName =
    readRequiredEnvironment('DEVELOPER_PLATFORM_TABLE_NAME')
  const documentClient = createDocumentClient()
  await startWebhookAuthorizationBackfill(
    documentClient,
    tableName,
    new Date(),
    developerPlatformTableName,
  )
  const result = await processWebhookAuthorizationBackfillPages(
    documentClient,
    tableName,
    process.env.PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME ??
      DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME,
    {
      maxPages: WEBHOOK_AUTHORIZATION_BACKFILL_MAX_PAGES_PER_INVOCATION,
      canProcessNextPage: () =>
        !context ||
        context.getRemainingTimeInMillis() >
          WEBHOOK_AUTHORIZATION_BACKFILL_TIME_RESERVE_MILLISECONDS,
      developerPlatformTableName,
    },
  )
  return result.isComplete
    ? {
        IsComplete: true,
        Data: {
          SourceRowsUpdated: result.checkpoint.sourceRowsUpdated,
          SourceRowsVerified: result.checkpoint.sourceRowsVerified,
          GrantsWritten: result.checkpoint.grantsWritten,
          GrantsDeleted: result.checkpoint.grantsDeleted,
          CleanupLocatorsWritten:
            result.checkpoint.cleanupLocatorsWritten,
          ActiveLocatorsReconciled:
            result.checkpoint.activeLocatorsReconciled,
          LegacyLookupsRemoved:
            result.checkpoint.legacyLookupsRemoved,
        },
      }
    : { IsComplete: false }
}

async function deleteCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  migrationVersion:
    | 'v1'
    | 'v2'
    | typeof WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
) {
  await documentClient.send(new DeleteCommand({
    TableName: tableName,
    Key: {
      directoryId: `WEBHOOK_AUTHORIZATION_BACKFILL#${migrationVersion}`,
      entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
    },
  }))
}

/** v3 rollback の marker と durable checkpoint を冪等に初期化します。 */
export async function startWebhookActiveLocatorRollback(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  developerPlatformTableName: string,
  now = new Date(),
) {
  const markerKey = {
    workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
    recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
  }
  const current = await documentClient.send(new GetCommand({
    TableName: developerPlatformTableName,
    Key: markerKey,
    ConsistentRead: true,
  }))
  if (!current.Item) {
    await deleteCheckpoint(
      documentClient,
      tableName,
      WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
    )
    await deleteWebhookActiveLocatorRollbackCheckpoint(
      documentClient,
      tableName,
    )
    return false
  }

  let migration = readWebhookActiveLocatorMigrationDrain(current.Item)
  const requestedRollbackDrainUntil = new Date(
    readDate(now, 'Rollback start time').getTime() +
      WEBHOOK_AUTHORIZATION_WRITER_DRAIN_SECONDS * 1_000,
  ).toISOString()
  let lastConditionalFailure: unknown
  for (
    let attempt = 0;
    migration.state !== 'rollback' &&
    attempt < WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_START_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await documentClient.send(new UpdateCommand({
        TableName: developerPlatformTableName,
        Key: markerKey,
        UpdateExpression:
          'SET #value.#state = :rollback, ' +
          '#value.#rollbackDrainUntil = :rollbackDrainUntil, ' +
          '#version = #version + :one',
        ConditionExpression:
          '#entryType = :entryType AND #version = :expectedVersion AND ' +
          '#value.#migrationVersion = :migrationVersion AND ' +
          '#value.#state = :expectedState',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#value': 'value',
          '#state': 'state',
          '#rollbackDrainUntil': 'rollbackDrainUntil',
          '#migrationVersion': 'migrationVersion',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':entryType': WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE,
          ':expectedVersion': migration.version,
          ':migrationVersion': WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
          ':expectedState': migration.state,
          ':rollback': 'rollback',
          ':rollbackDrainUntil': requestedRollbackDrainUntil,
          ':one': 1,
        },
      }))
      migration = {
        ...migration,
        state: 'rollback',
        version: migration.version + 1,
        rollbackDrainUntil: requestedRollbackDrainUntil,
      }
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error
      lastConditionalFailure = error
      const raced = await documentClient.send(new GetCommand({
        TableName: developerPlatformTableName,
        Key: markerKey,
        ConsistentRead: true,
      }))
      if (!raced.Item) {
        await deleteCheckpoint(
          documentClient,
          tableName,
          WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
        )
        return false
      }
      migration = readWebhookActiveLocatorMigrationDrain(raced.Item)
    }
  }
  if (migration.state !== 'rollback') {
    throw lastConditionalFailure ??
      new Error('Webhook active locator rollback could not start.')
  }

  const rollbackDrainUntil = migration.rollbackDrainUntil
  if (!rollbackDrainUntil) {
    throw new TypeError('Webhook active locator rollback deadline is missing.')
  }
  await ensureWebhookActiveLocatorRollbackCheckpoint(
    documentClient,
    tableName,
    rollbackDrainUntil,
  )
  await deleteCheckpoint(
    documentClient,
    tableName,
    WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
  )
  return true
}

/** v3 rollback を1 page処理し、旧 GSI reader 用 locator を復元します。 */
export async function processWebhookActiveLocatorRollbackPage(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  developerPlatformTableName: string,
  now = new Date(),
): Promise<WebhookActiveLocatorRollbackProgress> {
  const current = await readOptionalWebhookActiveLocatorRollbackCheckpoint(
    documentClient,
    tableName,
  )
  if (!current) {
    const marker = await documentClient.send(new GetCommand({
      TableName: developerPlatformTableName,
      Key: {
        workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
        recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
      },
      ConsistentRead: true,
    }))
    if (!marker.Item) {
      return { isComplete: true, madeProgress: false }
    }
    const migration = readWebhookActiveLocatorMigrationDrain(marker.Item)
    if (migration.state !== 'rollback') {
      throw new TypeError(
        'Webhook active locator rollback checkpoint is missing.',
      )
    }
    const rollbackDrainUntil = migration.rollbackDrainUntil
    if (!rollbackDrainUntil) {
      throw new TypeError(
        'Webhook active locator rollback deadline is missing.',
      )
    }
    await ensureWebhookActiveLocatorRollbackCheckpoint(
      documentClient,
      tableName,
      rollbackDrainUntil,
    )
    return await processWebhookActiveLocatorRollbackPage(
      documentClient,
      tableName,
      developerPlatformTableName,
      now,
    )
  }
  if (
    Date.parse(current.writerDrainUntil) >
      readDate(now, 'Rollback clock').getTime()
  ) {
    return {
      isComplete: false,
      madeProgress: false,
      checkpoint: current,
    }
  }

  const response = await documentClient.send(new ScanCommand({
    TableName: developerPlatformTableName,
    ConsistentRead: true,
    Limit: WEBHOOK_AUTHORIZATION_SPARSE_SCAN_PAGE_SIZE,
    ProjectionExpression:
      'workspaceId, recordKey, #entryType, #value, lookupKey, ' +
      'lookupSortKey, expiresAt, #version',
    FilterExpression: '#entryType = :subscriptionEntryType',
    ExpressionAttributeNames: {
      '#entryType': 'entryType',
      '#value': 'value',
      '#version': 'version',
    },
    ExpressionAttributeValues: {
      ':subscriptionEntryType': 'webhook-subscription',
    },
    ...(current.scanCursor
      ? { ExclusiveStartKey: current.scanCursor }
      : {}),
  }))
  const rows = (response.Items ?? []).flatMap((value) => {
    const row = readWebhookActiveLocatorSourceRow(value)
    return row ? [row] : []
  })
  const results: Array<'reconciled' | 'retry'> = []
  await runBounded(rows.map((row) => async () => {
    results.push(await reconcileWebhookLegacyActiveLocator(
      documentClient,
      developerPlatformTableName,
      row,
      now,
    ))
  }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
  if (results.includes('retry')) {
    return {
      isComplete: false,
      madeProgress: false,
      checkpoint: current,
    }
  }

  const next = {
    ...current,
    revision: current.revision + 1,
    ...(response.LastEvaluatedKey
      ? { scanCursor: response.LastEvaluatedKey }
      : {}),
    ...(!response.LastEvaluatedKey && current.scanCursor
      ? { scanCursor: undefined }
      : {}),
    legacyLookupsReconciled:
      current.legacyLookupsReconciled + rows.length,
  } satisfies WebhookActiveLocatorRollbackCheckpoint
  if (response.LastEvaluatedKey) {
    const persisted = await persistWebhookActiveLocatorRollbackCheckpoint(
      documentClient,
      tableName,
      current.revision,
      next,
    )
    if (!persisted) {
      const checkpoint =
        await readOptionalWebhookActiveLocatorRollbackCheckpoint(
          documentClient,
          tableName,
        )
      return checkpoint
        ? {
            isComplete: false,
            madeProgress: checkpoint.revision !== current.revision,
            checkpoint,
          }
        : { isComplete: true, madeProgress: true }
    }
    return { isComplete: false, madeProgress: true, checkpoint: next }
  }

  const completed = await completeWebhookActiveLocatorRollback(
    documentClient,
    tableName,
    developerPlatformTableName,
    current,
  )
  return completed
    ? { isComplete: true, madeProgress: true, checkpoint: next }
    : { isComplete: false, madeProgress: false, checkpoint: current }
}

/** v3 rollback をtime budget内で複数page処理します。 */
export async function processWebhookActiveLocatorRollbackPages(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  developerPlatformTableName: string,
  options: WebhookAuthorizationBackfillBatchOptions,
): Promise<WebhookActiveLocatorRollbackProgress> {
  if (
    !Number.isSafeInteger(options.maxPages) ||
    options.maxPages < 1 ||
    options.maxPages > WEBHOOK_AUTHORIZATION_BACKFILL_MAX_PAGES_PER_INVOCATION
  ) {
    throw new TypeError('Webhook active locator rollback max pages is invalid.')
  }
  let result = await processWebhookActiveLocatorRollbackPage(
    documentClient,
    tableName,
    developerPlatformTableName,
    options.now?.() ?? new Date(),
  )
  for (
    let pagesProcessed = 1;
    pagesProcessed < options.maxPages &&
    !result.isComplete &&
    result.madeProgress &&
    options.canProcessNextPage();
    pagesProcessed += 1
  ) {
    result = await processWebhookActiveLocatorRollbackPage(
      documentClient,
      tableName,
      developerPlatformTableName,
      options.now?.() ?? new Date(),
    )
  }
  return result
}

async function ensureWebhookActiveLocatorRollbackCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  writerDrainUntil: string,
) {
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        directoryId:
          WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_CHECKPOINT_DIRECTORY_ID,
        entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
        entryType: 'webhook-active-locator-rollback-checkpoint',
        migrationVersion: WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
        writerDrainUntil,
        revision: 0,
        legacyLookupsReconciled: 0,
      } satisfies WebhookActiveLocatorRollbackCheckpoint,
      ConditionExpression: 'attribute_not_exists(directoryId)',
    }))
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error
  }
}

async function readOptionalWebhookActiveLocatorRollbackCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      directoryId: WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_CHECKPOINT_DIRECTORY_ID,
      entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
    },
    ConsistentRead: true,
  }))
  const value = response.Item
  if (!value) return undefined
  if (
    value.directoryId !==
      WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_CHECKPOINT_DIRECTORY_ID ||
    value.entryKey !== WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY ||
    value.entryType !== 'webhook-active-locator-rollback-checkpoint' ||
    value.migrationVersion !== WEBHOOK_AUTHORIZATION_BACKFILL_VERSION ||
    typeof value.writerDrainUntil !== 'string' ||
    !Number.isFinite(Date.parse(value.writerDrainUntil)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Number.isSafeInteger(value.legacyLookupsReconciled) ||
    Number(value.legacyLookupsReconciled) < 0 ||
    (
      value.scanCursor !== undefined &&
      !isRecord(value.scanCursor)
    )
  ) {
    throw new TypeError(
      'Webhook active locator rollback checkpoint is invalid.',
    )
  }
  return value as WebhookActiveLocatorRollbackCheckpoint
}

async function persistWebhookActiveLocatorRollbackCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  expectedRevision: number,
  next: WebhookActiveLocatorRollbackCheckpoint,
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
        ':entryType': 'webhook-active-locator-rollback-checkpoint',
        ':expectedRevision': expectedRevision,
      },
    }))
    return true
  } catch (error) {
    if (isConditionalCheckFailure(error)) return false
    throw error
  }
}

async function completeWebhookActiveLocatorRollback(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  developerPlatformTableName: string,
  checkpoint: WebhookActiveLocatorRollbackCheckpoint,
) {
  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: developerPlatformTableName,
            Key: {
              workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
              recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
            },
            ConditionExpression:
              '#entryType = :migrationEntryType AND ' +
              '#value.#migrationVersion = :migrationVersion AND ' +
              '#value.#state = :rollback',
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#value': 'value',
              '#migrationVersion': 'migrationVersion',
              '#state': 'state',
            },
            ExpressionAttributeValues: {
              ':migrationEntryType':
                WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE,
              ':migrationVersion': WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
              ':rollback': 'rollback',
            },
          },
        },
        {
          Delete: {
            TableName: tableName,
            Key: {
              directoryId:
                WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_CHECKPOINT_DIRECTORY_ID,
              entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
            },
            ConditionExpression:
              '#entryType = :checkpointEntryType AND #revision = :revision',
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#revision': 'revision',
            },
            ExpressionAttributeValues: {
              ':checkpointEntryType':
                'webhook-active-locator-rollback-checkpoint',
              ':revision': checkpoint.revision,
            },
          },
        },
      ],
    }))
    return true
  } catch (error) {
    if (
      !isRecord(error) ||
      error.name !== 'TransactionCanceledException'
    ) throw error
    const [marker, rollbackCheckpoint] = await Promise.all([
      documentClient.send(new GetCommand({
        TableName: developerPlatformTableName,
        Key: {
          workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
          recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
        },
        ConsistentRead: true,
      })),
      readOptionalWebhookActiveLocatorRollbackCheckpoint(
        documentClient,
        tableName,
      ),
    ])
    if (!marker.Item && !rollbackCheckpoint) return true
    if (!marker.Item || !rollbackCheckpoint) {
      throw new TypeError(
        'Webhook active locator rollback state is inconsistent.',
      )
    }
    return false
  }
}

async function deleteWebhookActiveLocatorRollbackCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  await documentClient.send(new DeleteCommand({
    TableName: tableName,
    Key: {
      directoryId: WEBHOOK_ACTIVE_LOCATOR_ROLLBACK_CHECKPOINT_DIRECTORY_ID,
      entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
    },
  }))
}

async function ensureWebhookActiveLocatorCutover(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  now: Date,
) {
  const current = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
      recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
    },
    ConsistentRead: true,
  }))
  if (current.Item) {
    const migration = readWebhookActiveLocatorMigrationDrain(current.Item)
    if (migration.state === 'rollback') {
      throw new TypeError(
        'Webhook active locator rollback is still in progress.',
      )
    }
    return migration
  }
  const startedAt = readDate(now, 'Backfill start time')
  const writerDrainUntil = new Date(
    startedAt.getTime() + WEBHOOK_AUTHORIZATION_WRITER_DRAIN_SECONDS * 1_000,
  ).toISOString()
  try {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
        recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
        entryType: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE,
        value: {
          migrationVersion: WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
          state: 'cutover',
          writerDrainUntil,
        },
        version: 1,
      },
      ConditionExpression:
        'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    }))
    return {
      state: 'cutover' as const,
      writerDrainUntil,
      version: 1,
    }
  } catch (error) {
    if (!isConditionalCheckFailure(error)) throw error
    const raced = await documentClient.send(new GetCommand({
      TableName: tableName,
      Key: {
        workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
        recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
      },
      ConsistentRead: true,
    }))
    if (!raced.Item) throw error
    const migration = readWebhookActiveLocatorMigrationDrain(raced.Item)
    if (migration.state === 'rollback') {
      throw new TypeError(
        'Webhook active locator rollback is still in progress.',
      )
    }
    return migration
  }
}

function readWebhookActiveLocatorMigrationDrain(
  item: Record<string, unknown>,
) {
  const value = item.value
  if (
    item.workspaceId !== WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID ||
    item.recordKey !== WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY ||
    item.entryType !== WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE ||
    !Number.isSafeInteger(item.version) ||
    Number(item.version) < 1 ||
    !isRecord(value) ||
    value.migrationVersion !== WEBHOOK_AUTHORIZATION_BACKFILL_VERSION ||
    (
      value.state !== 'cutover' &&
      value.state !== 'complete' &&
      value.state !== 'rollback'
    ) ||
    typeof value.writerDrainUntil !== 'string' ||
    !Number.isFinite(Date.parse(value.writerDrainUntil)) ||
    (
      value.state === 'rollback' &&
      (
        typeof value.rollbackDrainUntil !== 'string' ||
        !Number.isFinite(Date.parse(value.rollbackDrainUntil))
      )
    )
  ) {
    throw new TypeError('Webhook active locator migration row is invalid.')
  }
  return {
    state: value.state,
    writerDrainUntil: value.writerDrainUntil,
    version: Number(item.version),
    ...(value.state === 'rollback'
      ? { rollbackDrainUntil: value.rollbackDrainUntil as string }
      : {}),
  } as const
}

function createInitialCheckpoint(
  now: Date,
  writerDrainUntil?: string,
  initialPhase:
    | 'active-locators'
    | 'legacy-locator-cleanup' = 'active-locators',
): WebhookAuthorizationBackfillCheckpoint {
  const startedAt = readDate(now, 'Backfill start time')
  return {
    directoryId: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID,
    entryKey: WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY,
    entryType: 'webhook-authorization-backfill-checkpoint',
    migrationVersion: WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
    writerDrainUntil: writerDrainUntil ?? new Date(
      startedAt.getTime() + WEBHOOK_AUTHORIZATION_WRITER_DRAIN_SECONDS * 1_000,
    ).toISOString(),
    phase: initialPhase,
    revision: 0,
    sourceRowsUpdated: 0,
    sourceRowsVerified: 0,
    grantsWritten: 0,
    grantsDeleted: 0,
    cleanupLocatorsWritten: 0,
    activeLocatorsReconciled: 0,
    legacyLookupsRemoved: 0,
  }
}

async function readCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
) {
  const checkpoint = await readOptionalCheckpoint(documentClient, tableName)
  if (!checkpoint) {
    throw new TypeError('Webhook authorization backfill checkpoint is invalid.')
  }
  return checkpoint
}

async function readOptionalCheckpoint(
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
  if (!value) return undefined
  if (
    value.directoryId !== WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_DIRECTORY_ID ||
    value.entryKey !== WEBHOOK_AUTHORIZATION_BACKFILL_CHECKPOINT_ENTRY_KEY ||
    value.entryType !== 'webhook-authorization-backfill-checkpoint' ||
    value.migrationVersion !== WEBHOOK_AUTHORIZATION_BACKFILL_VERSION ||
    typeof value.writerDrainUntil !== 'string' ||
    !Number.isFinite(Date.parse(value.writerDrainUntil)) ||
    (
      value.phase !== 'active-locators' &&
      value.phase !== 'legacy-locator-cleanup' &&
      value.phase !== 'projection' &&
      value.phase !== 'verification' &&
      value.phase !== 'grants' &&
      value.phase !== 'grant-cleanup' &&
      value.phase !== 'complete'
    ) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.sourceRowsUpdated) ||
    !Number.isSafeInteger(value.sourceRowsVerified) ||
    !Number.isSafeInteger(value.grantsWritten) ||
    !Number.isSafeInteger(value.grantsDeleted) ||
    !Number.isSafeInteger(value.cleanupLocatorsWritten) ||
    !Number.isSafeInteger(value.activeLocatorsReconciled) ||
    !Number.isSafeInteger(value.legacyLookupsRemoved) ||
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
    grantsDeleted: number
    cleanupLocatorsWritten: number
    activeLocatorsReconciled: number
    legacyLookupsRemoved: number
  },
) {
  const nextPhase = lastEvaluatedKey
    ? current.phase
    : current.phase === 'active-locators'
      ? 'legacy-locator-cleanup'
      : current.phase === 'legacy-locator-cleanup'
        ? 'projection'
      : current.phase === 'projection'
        ? 'verification'
        : current.phase === 'verification'
          ? 'grants'
          : current.phase === 'grants'
            ? 'grant-cleanup'
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
    grantsDeleted: current.grantsDeleted + increments.grantsDeleted,
    cleanupLocatorsWritten:
      current.cleanupLocatorsWritten + increments.cleanupLocatorsWritten,
    activeLocatorsReconciled:
      current.activeLocatorsReconciled + increments.activeLocatorsReconciled,
    legacyLookupsRemoved:
      current.legacyLookupsRemoved + increments.legacyLookupsRemoved,
  } satisfies WebhookAuthorizationBackfillCheckpoint
}

async function persistCheckpoint(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  developerPlatformTableName: string,
  expectedRevision: number,
  next: WebhookAuthorizationBackfillCheckpoint,
  completeActiveLocatorMigration: boolean,
) {
  try {
    const checkpointPut = {
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
    }
    if (completeActiveLocatorMigration) {
      await documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Put: checkpointPut },
          {
            Update: {
              TableName: developerPlatformTableName,
              Key: {
                workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
                recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
              },
              UpdateExpression:
                'SET #value.#state = :complete, #version = #version + :one',
              ConditionExpression:
                '#entryType = :migrationEntryType AND ' +
                '#value.#migrationVersion = :migrationVersion AND ' +
                '#value.#state = :cutover',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#state': 'state',
                '#migrationVersion': 'migrationVersion',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':migrationEntryType':
                  WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE,
                ':migrationVersion':
                  WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
                ':cutover': 'cutover',
                ':complete': 'complete',
                ':one': 1,
              },
            },
          },
        ],
      }))
    } else {
      await documentClient.send(new PutCommand(checkpointPut))
    }
    return true
  } catch (error) {
    if (
      isConditionalCheckFailure(error) ||
      (
        isRecord(error) &&
        error.name === 'TransactionCanceledException'
      )
    ) return false
    throw error
  }
}

function readWebhookActiveLocatorSourceRow(
  value: Record<string, unknown>,
): WebhookActiveLocatorSourceRow | undefined {
  if (value.entryType !== 'webhook-subscription') return undefined
  const subscription = value.value
  if (
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    !isRecord(subscription) ||
    typeof subscription.id !== 'string' ||
    subscription.id.length === 0 ||
    value.recordKey !== `WEBHOOK#${subscription.id}` ||
    typeof subscription.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(subscription.createdAt)) ||
    (
      subscription.status !== 'active' &&
      subscription.status !== 'paused' &&
      subscription.status !== 'disabled'
    ) ||
    (
      value.lookupKey !== undefined &&
      typeof value.lookupKey !== 'string'
    ) ||
    (
      value.lookupSortKey !== undefined &&
      typeof value.lookupSortKey !== 'string'
    ) ||
    (
      value.expiresAt !== undefined &&
      (
        !Number.isSafeInteger(value.expiresAt) ||
        Number(value.expiresAt) <= 0
      )
    ) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) <= 0
  ) {
    throw new TypeError(
      'Webhook active locator migration source row is invalid.',
    )
  }
  return {
    workspaceId: value.workspaceId,
    recordKey: value.recordKey,
    entryType: 'webhook-subscription',
    value: subscription as WebhookActiveLocatorSourceRow['value'],
    ...(value.lookupKey === undefined
      ? {}
      : { lookupKey: value.lookupKey }),
    ...(value.lookupSortKey === undefined
      ? {}
      : { lookupSortKey: value.lookupSortKey }),
    ...(value.expiresAt === undefined
      ? {}
      : { expiresAt: Number(value.expiresAt) }),
    version: Number(value.version),
  }
}

async function reconcileWebhookActiveLocator(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  row: WebhookActiveLocatorSourceRow,
  now: Date,
  removeLegacyLookup: boolean,
) {
  const active = row.value.status === 'active' &&
    (
      row.expiresAt === undefined ||
      row.expiresAt > Math.floor(readDate(now, 'Backfill clock').getTime() / 1_000)
    )
  const locatorKey = {
    workspaceId: row.workspaceId,
    recordKey:
      `WEBHOOKACTIVE#${row.value.createdAt}#${row.value.id}`,
  }
  const conditionParts = [
    '#entryType = :entryType',
    '#value.#id = :id',
    '#value.#createdAt = :createdAt',
    '#value.#status = :status',
    row.lookupKey === undefined
      ? 'attribute_not_exists(lookupKey)'
      : 'lookupKey = :lookupKey',
    row.lookupSortKey === undefined
      ? 'attribute_not_exists(lookupSortKey)'
      : 'lookupSortKey = :lookupSortKey',
    row.expiresAt === undefined
      ? 'attribute_not_exists(expiresAt)'
      : 'expiresAt = :expiresAt',
  ]
  const baseRowCondition = {
    TableName: tableName,
    Key: {
      workspaceId: row.workspaceId,
      recordKey: row.recordKey,
    },
    ConditionExpression: conditionParts.join(' AND '),
    ExpressionAttributeNames: {
      '#entryType': 'entryType',
      '#value': 'value',
      '#id': 'id',
      '#createdAt': 'createdAt',
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':entryType': 'webhook-subscription',
      ':id': row.value.id,
      ':createdAt': row.value.createdAt,
      ':status': row.value.status,
      ...(row.lookupKey === undefined
        ? {}
        : { ':lookupKey': row.lookupKey }),
      ...(row.lookupSortKey === undefined
        ? {}
        : { ':lookupSortKey': row.lookupSortKey }),
      ...(row.expiresAt === undefined
        ? {}
        : { ':expiresAt': row.expiresAt }),
    },
  }
  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: {
              workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
              recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
            },
            ConditionExpression:
              '#entryType = :migrationEntryType AND ' +
              '#value.#migrationVersion = :migrationVersion AND ' +
              '#value.#state = :migrationState',
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#value': 'value',
              '#migrationVersion': 'migrationVersion',
              '#state': 'state',
            },
            ExpressionAttributeValues: {
              ':migrationEntryType':
                WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE,
              ':migrationVersion': WEBHOOK_AUTHORIZATION_BACKFILL_VERSION,
              ':migrationState': removeLegacyLookup
                ? 'complete'
                : 'cutover',
            },
          },
        },
        removeLegacyLookup
          ? {
              Update: {
                ...baseRowCondition,
                UpdateExpression: 'REMOVE lookupKey, lookupSortKey',
              },
            }
          : { ConditionCheck: baseRowCondition },
        active
          ? {
              Put: {
                TableName: tableName,
                Item: {
                  ...locatorKey,
                  entryType: 'webhook-active-subscription',
                  value: { targetRecordKey: row.recordKey },
                  version: 1,
                },
              },
            }
          : {
              Delete: {
                TableName: tableName,
                Key: locatorKey,
              },
            },
      ],
    }))
    return {
      status: 'reconciled' as const,
      reconciled: 1,
      legacyLookupRemoved:
        removeLegacyLookup &&
          (row.lookupKey !== undefined || row.lookupSortKey !== undefined)
          ? 1
          : 0,
    }
  } catch (error) {
    if (
      isRecord(error) &&
      error.name === 'TransactionCanceledException'
    ) {
      return {
        status: 'retry' as const,
        reconciled: 0,
        legacyLookupRemoved: 0,
      }
    }
    throw error
  }
}

async function reconcileWebhookLegacyActiveLocator(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  row: WebhookActiveLocatorSourceRow,
  now: Date,
) {
  const active = row.value.status === 'active' &&
    (
      row.expiresAt === undefined ||
      row.expiresAt >
        Math.floor(readDate(now, 'Rollback clock').getTime() / 1_000)
    )
  const conditionParts = [
    '#entryType = :entryType',
    '#value.#id = :id',
    '#value.#createdAt = :createdAt',
    '#value.#status = :status',
    row.lookupKey === undefined
      ? 'attribute_not_exists(lookupKey)'
      : 'lookupKey = :observedLookupKey',
    row.lookupSortKey === undefined
      ? 'attribute_not_exists(lookupSortKey)'
      : 'lookupSortKey = :observedLookupSortKey',
    row.expiresAt === undefined
      ? 'attribute_not_exists(expiresAt)'
      : 'expiresAt = :expiresAt',
  ]
  try {
    await documentClient.send(new UpdateCommand({
      TableName: tableName,
      Key: {
        workspaceId: row.workspaceId,
        recordKey: row.recordKey,
      },
      UpdateExpression: active
        ? 'SET lookupKey = :lookupKey, lookupSortKey = :lookupSortKey'
        : 'REMOVE lookupKey, lookupSortKey',
      ConditionExpression: conditionParts.join(' AND '),
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#value': 'value',
        '#id': 'id',
        '#createdAt': 'createdAt',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':entryType': 'webhook-subscription',
        ':id': row.value.id,
        ':createdAt': row.value.createdAt,
        ':status': row.value.status,
        ...(row.lookupKey === undefined
          ? {}
          : { ':observedLookupKey': row.lookupKey }),
        ...(row.lookupSortKey === undefined
          ? {}
          : { ':observedLookupSortKey': row.lookupSortKey }),
        ...(row.expiresAt === undefined
          ? {}
          : { ':expiresAt': row.expiresAt }),
        ...(active
          ? {
              ':lookupKey': `WEBHOOK#ACTIVE#${row.workspaceId}`,
              ':lookupSortKey':
                `${row.value.createdAt}#${row.value.id}`,
            }
          : {}),
      },
    }))
    return 'reconciled' as const
  } catch (error) {
    if (isConditionalCheckFailure(error)) return 'retry' as const
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
    const grant = createWebhookTeamGrantItem({
      workspaceId: member.directoryId,
      teamId,
      projectId: member.projectId!,
      memberKey: member.memberKey!,
      teamSourceEntryKey: source.team.entryKey,
      projectSourceEntryKey: source.project.entryKey,
    })
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        createActiveSourceCondition(
          tableName,
          member,
          'project-member',
        ),
        createActiveSourceCondition(tableName, source.team, 'team'),
        createActiveSourceCondition(tableName, source.project, 'project'),
        {
          Put: {
            TableName: tableName,
            Item: grant,
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: createWebhookGrantCleanupItem({
              workspaceId: member.directoryId,
              teamId,
              projectId: member.projectId!,
              memberKey: member.memberKey!,
            }),
          },
        },
      ],
    }))
  }), WEBHOOK_AUTHORIZATION_BACKFILL_CONCURRENCY)
  return grantSources.size
}

function createActiveSourceCondition(
  tableName: string,
  row: WebhookAuthorizationSourceRow,
  entryType: WebhookAuthorizationSourceRow['entryType'],
) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        directoryId: row.directoryId,
        entryKey: row.entryKey,
      },
      ConditionExpression:
        '#entryType = :entryType AND attribute_not_exists(archivedAt)',
      ExpressionAttributeNames: { '#entryType': 'entryType' },
      ExpressionAttributeValues: { ':entryType': entryType },
    },
  }
}

async function reconcileLegacyGrant(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  grant: WebhookAuthorizationGrantRow,
) {
  const [member, team, project] = await Promise.all([
    readRawSource(documentClient, tableName, grant.workspaceId, grant.sourceEntryKey),
    readRawSource(documentClient, tableName, grant.workspaceId, grant.teamSourceEntryKey),
    readRawSource(
      documentClient,
      tableName,
      grant.workspaceId,
      grant.projectSourceEntryKey,
    ),
  ])
  const sources = [member, team, project] as const
  if (hasActiveGrantSources(grant, member, team, project)) {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        createActiveGrantSourceCondition(
          tableName,
          grant.workspaceId,
          grant.sourceEntryKey,
          'project-member',
          grant,
        ),
        createActiveGrantSourceCondition(
          tableName,
          grant.workspaceId,
          grant.teamSourceEntryKey,
          'team',
          grant,
        ),
        createActiveGrantSourceCondition(
          tableName,
          grant.workspaceId,
          grant.projectSourceEntryKey,
          'project',
          grant,
        ),
        {
          Put: {
            TableName: tableName,
            Item: createWebhookGrantCleanupItem(grant),
          },
        },
      ],
    }))
    return { deleted: 0, locatorWritten: 1 }
  }

  const invalidSourceIndex = sources.findIndex((source, index) =>
    !isExpectedActiveGrantSource(grant, source, index)
  )
  const invalidSourceKeys = [
    grant.sourceEntryKey,
    grant.teamSourceEntryKey,
    grant.projectSourceEntryKey,
  ] as const
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      createObservedSourceCondition(
        tableName,
        grant.workspaceId,
        invalidSourceKeys[invalidSourceIndex]!,
        sources[invalidSourceIndex],
      ),
      {
        Delete: {
          TableName: tableName,
          Key: {
            directoryId: grant.directoryId,
            entryKey: grant.entryKey,
          },
          ConditionExpression:
            '#entryType = :entryType AND workspaceId = :workspaceId AND ' +
            'teamId = :teamId AND projectId = :projectId AND ' +
            'memberKey = :memberKey AND sourceEntryKey = :sourceEntryKey AND ' +
            'teamSourceEntryKey = :teamSourceEntryKey AND ' +
            'projectSourceEntryKey = :projectSourceEntryKey AND ' +
            'webhookAuthorizationKey = :webhookAuthorizationKey AND ' +
            'webhookAuthorizationSortKey = :webhookAuthorizationSortKey',
          ExpressionAttributeNames: { '#entryType': 'entryType' },
          ExpressionAttributeValues: {
            ':entryType': 'webhook-team-grant',
            ':workspaceId': grant.workspaceId,
            ':teamId': grant.teamId,
            ':projectId': grant.projectId,
            ':memberKey': grant.memberKey,
            ':sourceEntryKey': grant.sourceEntryKey,
            ':teamSourceEntryKey': grant.teamSourceEntryKey,
            ':projectSourceEntryKey': grant.projectSourceEntryKey,
            ':webhookAuthorizationKey': grant.webhookAuthorizationKey,
            ':webhookAuthorizationSortKey':
              grant.webhookAuthorizationSortKey,
          },
        },
      },
      {
        Delete: {
          TableName: tableName,
          Key: {
            directoryId: createWebhookGrantCleanupItem(grant).directoryId,
            entryKey: createWebhookGrantCleanupItem(grant).entryKey,
          },
        },
      },
    ],
  }))
  return { deleted: 1, locatorWritten: 0 }
}

async function readRawSource(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  directoryId: string,
  entryKey: string,
) {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { directoryId, entryKey },
    ConsistentRead: true,
  }))
  return response.Item
}

function hasActiveGrantSources(
  grant: WebhookAuthorizationGrantRow,
  member: Record<string, unknown> | undefined,
  team: Record<string, unknown> | undefined,
  project: Record<string, unknown> | undefined,
) {
  return isExpectedActiveGrantSource(grant, member, 0) &&
    isExpectedActiveGrantSource(grant, team, 1) &&
    isExpectedActiveGrantSource(grant, project, 2)
}

function isExpectedActiveGrantSource(
  grant: WebhookAuthorizationGrantRow,
  source: Record<string, unknown> | undefined,
  sourceIndex: number,
) {
  if (!source || source.archivedAt !== undefined) return false
  if (sourceIndex === 0) {
    return source.entryType === 'project-member' &&
      source.projectId === grant.projectId &&
      source.memberKey === grant.memberKey &&
      (
        source.role === 'viewer' ||
        source.role === 'member' ||
        source.role === 'manager'
      )
  }
  if (sourceIndex === 1) {
    return source.entryType === 'team' && source.teamId === grant.teamId
  }
  return source.entryType === 'project' &&
    source.teamId === grant.teamId &&
    source.projectId === grant.projectId
}

function createActiveGrantSourceCondition(
  tableName: string,
  directoryId: string,
  entryKey: string,
  entryType: WebhookAuthorizationSourceRow['entryType'],
  grant: WebhookAuthorizationGrantRow,
) {
  const member = entryType === 'project-member'
  const team = entryType === 'team'
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { directoryId, entryKey },
      ConditionExpression:
        '#entryType = :entryType AND attribute_not_exists(archivedAt) AND ' +
        (member
          ? 'projectId = :projectId AND memberKey = :memberKey AND ' +
            '#role IN (:viewer, :member, :manager)'
          : team
            ? 'teamId = :teamId'
            : 'teamId = :teamId AND projectId = :projectId'),
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        ...(member ? { '#role': 'role' } : {}),
      },
      ExpressionAttributeValues: {
        ':entryType': entryType,
        ...(member
          ? {
              ':projectId': grant.projectId,
              ':memberKey': grant.memberKey,
              ':viewer': 'viewer',
              ':member': 'member',
              ':manager': 'manager',
            }
          : team
            ? { ':teamId': grant.teamId }
            : {
                ':teamId': grant.teamId,
                ':projectId': grant.projectId,
              }),
      },
    },
  }
}

function createObservedSourceCondition(
  tableName: string,
  directoryId: string,
  entryKey: string,
  source: Record<string, unknown> | undefined,
) {
  if (!source) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: { directoryId, entryKey },
        ConditionExpression: 'attribute_not_exists(directoryId)',
      },
    }
  }
  const validityFields = [
    'entryType',
    'teamId',
    'projectId',
    'memberKey',
    'role',
    'archivedAt',
  ] as const
  const presentFields = validityFields.filter((field) =>
    source[field] !== undefined
  )
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { directoryId, entryKey },
      ConditionExpression: validityFields
        .map((field) =>
          source[field] === undefined
            ? `attribute_not_exists(#${field})`
            : `#${field} = :${field}`
        )
        .join(' AND '),
      ExpressionAttributeNames: Object.fromEntries(
        validityFields.map((field) => [`#${field}`, field]),
      ),
      ...(presentFields.length > 0
        ? {
            ExpressionAttributeValues: Object.fromEntries(
              presentFields.map((field) => [`:${field}`, source[field]]),
            ),
          }
        : {}),
    },
  }
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

function readGrantRow(
  value: Record<string, unknown>,
): WebhookAuthorizationGrantRow | undefined {
  if (value.entryType !== 'webhook-team-grant') return undefined
  const stringFields = [
    'directoryId',
    'entryKey',
    'workspaceId',
    'teamId',
    'projectId',
    'memberKey',
    'sourceEntryKey',
    'teamSourceEntryKey',
    'projectSourceEntryKey',
    'webhookAuthorizationKey',
    'webhookAuthorizationSortKey',
  ] as const
  if (stringFields.some((field) => typeof value[field] !== 'string')) {
    throw new TypeError('Webhook authorization grant row is invalid.')
  }
  const grant = value as WebhookAuthorizationGrantRow
  const expected = createWebhookTeamGrantItem({
    workspaceId: grant.workspaceId,
    teamId: grant.teamId,
    projectId: grant.projectId,
    memberKey: grant.memberKey,
    teamSourceEntryKey: grant.teamSourceEntryKey,
    projectSourceEntryKey: grant.projectSourceEntryKey,
  })
  if (
    Object.entries(expected).some(([key, expectedValue]) =>
      grant[key as keyof WebhookAuthorizationGrantRow] !== expectedValue
    )
  ) {
    throw new TypeError('Webhook authorization grant row is invalid.')
  }
  return grant
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

function readKnownDeletingMigrationVersion(
  event: WebhookAuthorizationBackfillEvent,
):
  | 'v1'
  | 'v2'
  | typeof WEBHOOK_AUTHORIZATION_BACKFILL_VERSION
  | undefined {
  const version = event.ResourceProperties?.MigrationVersion
  return version === 'v1' ||
      version === 'v2' ||
      version === WEBHOOK_AUTHORIZATION_BACKFILL_VERSION
    ? version
    : undefined
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

function readDate(value: Date, label: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
