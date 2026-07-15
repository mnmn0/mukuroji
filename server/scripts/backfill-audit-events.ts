import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  AUDIT_MAX_TEXT_LENGTH,
  calculateAuditExpiresAt,
  createAuditEvent as createSchemaV1AuditEvent,
  createAuditFieldChanges,
  createMutationAuditContext,
  ensureLocalAuditEventsTable,
  type AuditEventV1,
  type AuditFieldChange,
} from '../src/audit'
import { isCanonicalWorkItemRecord } from '../src/canonical-work-item'

const unknownOccurredAt = '1970-01-01T00:00:00.000Z'
const checkpointVersion = 1
const scanPageSize = 100
const sourceNames = [
  'team-issue-events',
  'team-issues',
  'project-tasks',
  'project-directory',
] as const

/**
 * Backfill で読み取れる source 名です。
 */
type SourceName = typeof sourceNames[number]

/**
 * DynamoDB DocumentClient が返す key です。
 */
type DynamoKey = Record<string, unknown>

/**
 * 汎用 audit event を組み立てる入力です。
 */
type AuditEventInput = {
  /**
   * Source table の種類です。
   */
  legacySource: SourceName
  /**
   * Source item の一意 key です。
   */
  legacyKey: string
  /**
   * Domain event type です。
   */
  eventType: string
  /**
   * Workspace directory ID です。
   */
  directoryId: string
  /**
   * Event timestamp です。
   */
  occurredAt: string
  /**
   * User または system actor ID です。
   */
  actorUserId: string
  /**
   * Activity entity type です。
   */
  entityType: string
  /**
   * Activity entity ID です。
   */
  entityId: string
  /**
   * 直接変更された resource type です。
   */
  targetType: string
  /**
   * 直接変更された resource ID です。
   */
  targetId: string
  /**
   * Mutation action です。
   */
  action: string
  /**
   * 復元済み field changes です。
   */
  changes: AuditFieldChange[]
  /**
   * Event 生成理由です。
   */
  reason?: string
  /**
   * Migration event か current snapshot backfill かを示します。
   */
  source: 'migration' | 'backfill'
  /**
   * Adapter scope や legacy source の診断情報です。
   */
  metadata?: Readonly<Record<string, unknown>>
}

/**
 * CLI から受け取る実行 option です。
 */
type BackfillOptions = {
  /**
   * DynamoDB と checkpoint を変更しない preview mode です。
   */
  dryRun: boolean
  /**
   * Help を表示するかどうかです。
   */
  help: boolean
  /**
   * Checkpoint JSON の保存先です。
   */
  checkpointPath: string
  /**
   * 1 run で scan する source item 数の上限です。
   */
  limit?: number
  /**
   * 1 source だけ実行する場合の source 名です。
   */
  source?: SourceName
}

/**
 * Source ごとの累積 counter です。
 */
type BackfillCounters = {
  /**
   * Scan した source item 数です。
   */
  scanned: number
  /**
   * 新規作成した event 数です。
   */
  written: number
  /**
   * Conditional check により既存と判定した event 数です。
   */
  duplicates: number
  /**
   * 必須 field 不足または対象外で skip した item 数です。
   */
  skipped: number
}

/**
 * 1 source の scan checkpoint です。
 */
type SourceCheckpoint = {
  /**
   * Source table の scan が完了したかどうかです。
   */
  completed: boolean
  /**
   * 次 page の DynamoDB ExclusiveStartKey です。
   */
  lastEvaluatedKey?: DynamoKey
  /**
   * Source の累積 counter です。
   */
  counters: BackfillCounters
}

/**
 * Backfill 全体の checkpoint file です。
 */
type CheckpointState = {
  /**
   * Checkpoint schema version です。
   */
  version: 1
  /**
   * Table 組み合わせの誤用を防ぐ hash です。
   */
  configurationHash: string
  /**
   * Checkpoint の最終更新時刻です。
   */
  updatedAt: string
  /**
   * Source ごとの checkpoint です。
   */
  sources: Record<SourceName, SourceCheckpoint>
}

/**
 * Backfill で利用する table 名です。
 */
type TableNames = {
  /**
   * 旧 Team Issue event table 名です。
   */
  teamIssueEvents: string
  /**
   * Current Team Issue table 名です。
   */
  teamIssues: string
  /**
   * Legacy project task table 名です。
   */
  projectTasks: string
  /**
   * Team/project/member directory table 名です。
   */
  projectDirectory: string
  /**
   * Backfill 先の汎用 AuditEvents table 名です。
   */
  auditEvents: string
}

/**
 * 1 source table の scan と mapping 定義です。
 */
type SourceDefinition = {
  /**
   * CLI/checkpoint で使う source 名です。
   */
  name: SourceName
  /**
   * Scan する DynamoDB table 名です。
   */
  tableName: string
  /**
   * Source item を汎用 audit event に変換します。
   */
  mapItem: (item: Record<string, unknown>) => AuditEventV1 | undefined
}

/**
 * Actor ID の正規化結果です。
 */
type ActorIdentity = {
  /**
   * User または system actor の ID です。
   */
  actorUserId: string
}

/**
 * Error object の最小形です。
 */
type NamedError = {
  /**
   * Node/AWS SDK error name です。
   */
  name?: string
  /**
   * Node filesystem error code です。
   */
  code?: string
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
  const configurationHash = createDigest(JSON.stringify({
    endpoint: endpoint ?? 'aws-default',
    region,
    profile: readEnvironment('AWS_PROFILE') ?? 'default-provider-chain',
    account: readEnvironment('AWS_ACCOUNT_ID') ?? 'unknown-account',
    tables,
  }))
  const checkpoint = await readCheckpoint(options.checkpointPath, configurationHash)
  const dynamoDbClient = createDynamoDbClient(endpoint, region)
  const client = createDocumentClient(dynamoDbClient)
  const definitions = createSourceDefinitions(tables)
    .filter((definition) => options.source === undefined || definition.name === options.source)

  if (!options.dryRun && endpoint && isLocalEndpoint(endpoint)) {
    await ensureLocalAuditEventsTable(tables.auditEvents, dynamoDbClient)
  }

  console.info(
    `Audit event backfill started: target=${tables.auditEvents} dryRun=${options.dryRun} ` +
    `limit=${options.limit ?? 'unlimited'} checkpoint=${options.checkpointPath}`,
  )

  await runBackfill(client, definitions, tables.auditEvents, checkpoint, options)
  printSummary(checkpoint, definitions)
}

function parseArguments(args: string[]): BackfillOptions {
  const options: BackfillOptions = {
    dryRun: false,
    help: false,
    checkpointPath: resolve(process.cwd(), 'audit-event-backfill.checkpoint.json'),
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

    if (argument === '--checkpoint' || argument.startsWith('--checkpoint=')) {
      const value = readOptionValue(argument, args[index + 1], '--checkpoint')
      options.checkpointPath = resolve(process.cwd(), value)
      index += argument === '--checkpoint' ? 1 : 0
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

function printHelp() {
  console.info(`Usage: bun server/scripts/backfill-audit-events.ts [options]

Options:
  --dry-run                 Scan and map items without writing events/checkpoint.
  --checkpoint <path>      Checkpoint JSON path (default: ./audit-event-backfill.checkpoint.json).
  --limit <count>          Maximum source items scanned in this run.
  --source <name>          Run only team-issue-events, team-issues, project-tasks, or project-directory.
  --help, -h               Show this help.

Required production environment:
  TEAM_ISSUE_EVENTS_TABLE_NAME, TEAM_ISSUES_TABLE_NAME, TASKS_TABLE_NAME,
  PROJECT_DIRECTORY_TABLE_NAME, AUDIT_EVENTS_TABLE_NAME

For a local endpoint, repository-local default table names are used when omitted.
Write runs bootstrap mukuroji-audit-events with the shared schema when it is missing.`)
}

function resolveTableNames(endpoint: string | undefined): TableNames {
  const allowLocalDefaults = endpoint !== undefined && isLocalEndpoint(endpoint)

  return {
    teamIssueEvents: resolveTableName(
      ['MUKUROJI_TEAM_ISSUE_EVENTS_TABLE', 'TEAM_ISSUE_EVENTS_TABLE_NAME'],
      'mukuroji-team-issue-events-local',
      allowLocalDefaults,
    ),
    teamIssues: resolveTableName(
      ['MUKUROJI_TEAM_ISSUES_TABLE', 'TEAM_ISSUES_TABLE_NAME'],
      'mukuroji-team-issues-local',
      allowLocalDefaults,
    ),
    projectTasks: resolveTableName(
      ['MUKUROJI_PROJECT_TASKS_TABLE', 'TASKS_TABLE_NAME'],
      'mukuroji-project-tasks-v2-local',
      allowLocalDefaults,
    ),
    projectDirectory: resolveTableName(
      ['MUKUROJI_PROJECT_DIRECTORY_TABLE', 'PROJECT_DIRECTORY_TABLE_NAME'],
      'mukuroji-project-directory-local',
      allowLocalDefaults,
    ),
    auditEvents: resolveTableName(
      [
        'MUKUROJI_AUDIT_EVENTS_TABLE',
        'AUDIT_EVENTS_TABLE_NAME',
        'MUKUROJI_WORKSPACE_EVENTS_TABLE',
        'WORKSPACE_EVENTS_TABLE_NAME',
      ],
      'mukuroji-audit-events',
      allowLocalDefaults,
    ),
  }
}

function resolveTableName(
  environmentNames: string[],
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
      name: 'team-issue-events',
      tableName: tables.teamIssueEvents,
      mapItem: mapLegacyTeamIssueEvent,
    },
    {
      name: 'team-issues',
      tableName: tables.teamIssues,
      mapItem: mapCurrentTeamIssue,
    },
    {
      name: 'project-tasks',
      tableName: tables.projectTasks,
      mapItem: mapCurrentProjectTask,
    },
    {
      name: 'project-directory',
      tableName: tables.projectDirectory,
      mapItem: mapProjectDirectoryItem,
    },
  ]
}

async function runBackfill(
  client: DynamoDBDocumentClient,
  definitions: SourceDefinition[],
  auditEventsTableName: string,
  checkpoint: CheckpointState,
  options: BackfillOptions,
) {
  let remaining = options.limit

  for (const definition of definitions) {
    const sourceCheckpoint = checkpoint.sources[definition.name]

    if (sourceCheckpoint.completed) {
      console.info(`Skipping completed source: ${definition.name}`)
      continue
    }

    while (!sourceCheckpoint.completed && (remaining === undefined || remaining > 0)) {
      const pageLimit = Math.min(scanPageSize, remaining ?? scanPageSize)
      const response = await client.send(
        new ScanCommand({
          TableName: definition.tableName,
          ExclusiveStartKey: sourceCheckpoint.lastEvaluatedKey,
          Limit: pageLimit,
          ConsistentRead: true,
        }),
      )
      const items = response.Items ?? []
      const scanned = response.ScannedCount ?? items.length

      sourceCheckpoint.counters.scanned += scanned

      for (const item of items) {
        const event = definition.mapItem(item)

        if (!event) {
          sourceCheckpoint.counters.skipped += 1
          console.warn(`Skipped invalid or unsupported ${definition.name} item.`)
          continue
        }

        if (options.dryRun) {
          console.info(
            `[dry-run] ${event.eventType} eventId=${event.eventId} ` +
            `entity=${event.entityType}:${event.entityId} target=${event.targetType}:${event.targetId}`,
          )
          continue
        }

        const result = await putAuditEvent(client, auditEventsTableName, event)

        if (result === 'written') {
          sourceCheckpoint.counters.written += 1
        } else {
          sourceCheckpoint.counters.duplicates += 1
        }
      }

      sourceCheckpoint.lastEvaluatedKey = response.LastEvaluatedKey
      sourceCheckpoint.completed = response.LastEvaluatedKey === undefined
      checkpoint.updatedAt = new Date().toISOString()

      if (!options.dryRun) {
        await writeCheckpoint(options.checkpointPath, checkpoint)
      }

      if (remaining !== undefined) {
        remaining = Math.max(0, remaining - scanned)
      }
    }

    if (remaining === 0) {
      console.info('Run limit reached; resume with the same checkpoint path.')
      return
    }
  }
}

async function putAuditEvent(
  client: DynamoDBDocumentClient,
  tableName: string,
  event: AuditEventV1,
): Promise<'written' | 'duplicate'> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: event,
        ConditionExpression:
          'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
      }),
    )

    return 'written'
  } catch (error) {
    if (isNamedError(error, 'ConditionalCheckFailedException')) {
      return 'duplicate'
    }

    throw error
  }
}

function mapLegacyTeamIssueEvent(item: Record<string, unknown>) {
  const directoryId = readRequiredString(item, 'directoryId')
  const teamId = readRequiredString(item, 'teamId')
  const issueId = readRequiredString(item, 'issueId')
  const legacyEventId = readRequiredString(item, 'eventId')
  const legacyPartition = readRequiredString(item, 'directoryTeamIssueId')
  const legacyEventType = readRequiredString(item, 'eventType')

  if (!directoryId || !teamId || !issueId || !legacyEventId || !legacyPartition || !legacyEventType) {
    return undefined
  }

  const eventType = mapLegacyEventType(legacyEventType)

  if (!eventType) {
    return undefined
  }

  const actor = readActor(item.actorUserId)
  const isComment = legacyEventType === 'commented'
  const body = readOptionalString(item, 'body')
  const workItemId = createTeamIssueWorkItemId(teamId, issueId)
  const changes = isComment && body
    ? createAuditFieldChanges(undefined, { body }, ['body'])
    : []

  return createAuditEvent({
    legacySource: 'team-issue-events',
    legacyKey: `${legacyPartition}#${legacyEventId}`,
    eventType,
    directoryId,
    occurredAt: normalizeTimestamp(item.createdAt ?? legacyEventId.slice(0, 24)),
    ...actor,
    entityType: 'work-item',
    entityId: workItemId,
    targetType: isComment ? 'comment' : 'work-item',
    targetId: isComment ? createTeamIssueCommentId(workItemId, legacyEventId) : workItemId,
    action: mapLegacyAction(legacyEventType),
    changes,
    reason: readOptionalString(item, 'summary'),
    source: 'migration',
    metadata: {
      adapter: 'team-issue',
      diffUnavailable: legacyEventType === 'updated',
      legacyEventType,
      teamId,
    },
  })
}

/** Strict canonical Work Item row を audit backfill event へ変換します。 */
export function mapCurrentTeamIssue(item: Record<string, unknown>) {
  if (!isCanonicalWorkItemRecord(item)) {
    return undefined
  }

  const directoryId = item.directoryId
  const teamId = item.teamId
  const issueId = item.issueId
  const directoryTeamId = item.directoryTeamId
  const workItemId = createTeamIssueWorkItemId(teamId, issueId)

  return createAuditEvent({
    legacySource: 'team-issues',
    legacyKey: `${directoryTeamId}#${issueId}`,
    eventType: 'work-item.backfilled',
    directoryId,
    occurredAt: normalizeTimestamp(item.updatedAt ?? item.createdAt),
    actorUserId: 'system:backfill',
    entityType: 'work-item',
    entityId: workItemId,
    targetType: 'work-item',
    targetId: workItemId,
    action: 'backfilled',
    changes: createSnapshotChanges(item, [
      ['teamId', false],
      ['assignedProjectId', false],
      ['title', false],
      ['description', true],
      ['assigneeUserId', true],
      ['creatorMemberKey', true],
      ['workflowSchemaVersion', false],
      ['workflowStatusId', false],
      ['statusCategory', false],
      ['customFieldValues', true],
      ['dueDate', false],
      ['priority', false],
      ['createdAt', false],
      ['updatedAt', false],
    ]),
    reason: 'Current team-owned Work Item snapshot backfilled.',
    source: 'backfill',
    metadata: {
      adapter: 'team-issue',
      teamId,
    },
  })
}

function mapCurrentProjectTask(item: Record<string, unknown>) {
  const directoryId = readRequiredString(item, 'directoryId')
  const projectId = readRequiredString(item, 'projectId')
  const taskId = readRequiredString(item, 'taskId')
  const directoryProjectId = readRequiredString(item, 'directoryProjectId')

  if (!directoryId || !projectId || !taskId || !directoryProjectId) {
    return undefined
  }

  const workItemId = createProjectTaskWorkItemId(projectId, taskId)

  return createAuditEvent({
    legacySource: 'project-tasks',
    legacyKey: `${directoryProjectId}#${taskId}`,
    eventType: 'work-item.backfilled',
    directoryId,
    occurredAt: normalizeTimestamp(item.updatedAt ?? item.createdAt),
    actorUserId: 'system:backfill',
    entityType: 'work-item',
    entityId: workItemId,
    targetType: 'work-item',
    targetId: workItemId,
    action: 'backfilled',
    changes: createSnapshotChanges(item, [
      ['projectId', false],
      ['title', false],
      ['titleKey', false],
      ['assigneeUserId', true],
      ['assigneeKey', false],
      ['assignee', true],
      ['status', false],
      ['dueDate', false],
      ['priority', false],
      ['sortOrder', false],
    ]),
    reason: 'Legacy project task snapshot backfilled for Work Item migration.',
    source: 'backfill',
    metadata: {
      adapter: 'legacy-project-task',
      projectId,
    },
  })
}

function mapProjectDirectoryItem(item: Record<string, unknown>) {
  const directoryId = readRequiredString(item, 'directoryId')
  const entryKey = readRequiredString(item, 'entryKey')
  const entryType = readRequiredString(item, 'entryType')

  if (!directoryId || !entryKey || !entryType) {
    return undefined
  }

  if (entryType === 'team') {
    const teamId = readRequiredString(item, 'teamId')

    if (!teamId) {
      return undefined
    }

    return createAuditEvent({
      legacySource: 'project-directory',
      legacyKey: entryKey,
      eventType: 'project.backfilled',
      directoryId,
      occurredAt: normalizeTimestamp(item.archivedAt),
      actorUserId: 'system:backfill',
      entityType: 'project',
      entityId: `team/${teamId}`,
      targetType: 'project',
      targetId: `team/${teamId}`,
      action: 'backfilled',
      changes: createSnapshotChanges(item, [
        ['teamId', false],
        ['teamSortOrder', false],
        ['nameJa', false],
        ['nameEn', false],
        ['expanded', false],
        ['archivedAt', false],
      ]),
      reason: 'Current team snapshot backfilled.',
      source: 'backfill',
      metadata: {
        kind: 'team',
        teamId,
      },
    })
  }

  if (entryType === 'project') {
    const projectId = readRequiredString(item, 'projectId')

    if (!projectId) {
      return undefined
    }

    return createAuditEvent({
      legacySource: 'project-directory',
      legacyKey: entryKey,
      eventType: 'project.backfilled',
      directoryId,
      occurredAt: normalizeTimestamp(item.archivedAt),
      actorUserId: 'system:backfill',
      entityType: 'project',
      entityId: projectId,
      targetType: 'project',
      targetId: projectId,
      action: 'backfilled',
      changes: createSnapshotChanges(item, [
        ['teamId', false],
        ['projectId', false],
        ['projectSortOrder', false],
        ['nameJa', false],
        ['nameEn', false],
        ['tone', false],
        ['archivedAt', false],
      ]),
      reason: 'Current project snapshot backfilled.',
      source: 'backfill',
      metadata: {
        kind: 'project',
        projectId,
      },
    })
  }

  if (entryType === 'project-member') {
    const projectId = readRequiredString(item, 'projectId')
    const memberKey = readRequiredString(item, 'memberKey')

    if (!projectId || !memberKey) {
      return undefined
    }

    const targetId = `${projectId}/${memberKey}`

    return createAuditEvent({
      legacySource: 'project-directory',
      legacyKey: entryKey,
      eventType: 'member.backfilled',
      directoryId,
      occurredAt: normalizeTimestamp(item.updatedAt ?? item.createdAt),
      actorUserId: 'system:backfill',
      entityType: 'member',
      entityId: `${projectId}/${memberKey}`,
      targetType: 'member',
      targetId,
      action: 'backfilled',
      changes: createSnapshotChanges(item, [
        ['projectId', false],
        ['memberKey', true],
        ['email', true],
        ['name', true],
        ['role', false],
        ['createdAt', false],
        ['updatedAt', false],
      ]),
      reason: 'Current project member snapshot backfilled.',
      source: 'backfill',
      metadata: {
        kind: 'project-member',
        projectId,
      },
    })
  }

  return undefined
}

function createAuditEvent(input: AuditEventInput): AuditEventV1 {
  const sourceKeyDigest = createDigest(`${input.legacySource}\0${input.legacyKey}`)
  const context = createMutationAuditContext({
    workspaceId: input.directoryId,
    actor: {
      id: input.actorUserId,
      kind: input.actorUserId.startsWith('system:') ? 'system' : 'user',
      displayName: input.actorUserId,
    },
    idempotencyKey: `backfill:${sourceKeyDigest}`,
    request: {
      method: 'BACKFILL',
      path: `/audit/backfill/${input.legacySource}`,
      body: {
        legacyKey: input.legacyKey,
      },
    },
    source: {
      kind: input.source,
      method: 'BACKFILL',
      requestId: `backfill:${sourceKeyDigest.slice(0, 32)}`,
      route: `/audit/backfill/${input.legacySource}`,
    },
    occurredAt: input.occurredAt,
  })

  return createSchemaV1AuditEvent({
    context,
    eventType: input.eventType,
    entity: {
      type: input.entityType,
      id: input.entityId,
    },
    target: {
      type: input.targetType,
      id: input.targetId,
    },
    action: input.action,
    changes: input.changes,
    sequence: 0,
    summary: input.reason,
    expiresAt: calculateAuditExpiresAt(input.occurredAt, readAuditRetentionDays()),
    metadata: {
      ...input.metadata,
      backfilled: true,
      legacyKey: input.legacyKey,
      legacySource: input.legacySource,
    },
    outboxStatus: 'suppressed',
  })
}

function createSnapshotChanges(
  item: Record<string, unknown>,
  fields: Array<readonly [fieldName: string, sensitive: boolean]>,
) {
  const includedFields = fields.map(([fieldName]) => fieldName)
  const redactedFields = fields
    .filter(([, sensitive]) => sensitive)
    .map(([fieldName]) => fieldName)

  return createAuditFieldChanges(undefined, item, includedFields, redactedFields)
}

function mapLegacyEventType(value: string) {
  if (value === 'created') {
    return 'work-item.created'
  }

  if (value === 'updated') {
    return 'work-item.updated'
  }

  if (value === 'commented') {
    return 'comment.created'
  }

  return undefined
}

function mapLegacyAction(value: string) {
  if (value === 'created') {
    return 'created'
  }

  if (value === 'updated') {
    return 'updated'
  }

  return 'commented'
}

function createTeamIssueWorkItemId(teamId: string, issueId: string) {
  return limitBackfillText(`team/${teamId}/issue/${issueId}`)
}

function createProjectTaskWorkItemId(projectId: string, taskId: string) {
  return limitBackfillText(`project/${projectId}/task/${taskId}`)
}

function createTeamIssueCommentId(workItemId: string, legacyEventId: string) {
  return limitBackfillText(`${workItemId}/comment/${legacyEventId}`)
}

function readActor(value: unknown): ActorIdentity {
  if (typeof value === 'string' && value.trim()) {
    return {
      actorUserId: limitBackfillText(value.trim().toLowerCase()),
    }
  }

  return {
    actorUserId: 'system:migration',
  }
}

function normalizeTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    return unknownOccurredAt
  }

  const timestamp = Date.parse(value)

  return Number.isNaN(timestamp) ? unknownOccurredAt : new Date(timestamp).toISOString()
}

function readRequiredString(item: Record<string, unknown>, fieldName: string) {
  const value = item[fieldName]

  return typeof value === 'string' && value.trim()
    ? limitBackfillText(value.trim())
    : undefined
}

function readOptionalString(item: Record<string, unknown>, fieldName: string) {
  const value = item[fieldName]

  return typeof value === 'string' && value.trim()
    ? limitBackfillText(value.trim())
    : undefined
}

function limitBackfillText(value: string) {
  return value.length <= AUDIT_MAX_TEXT_LENGTH
    ? value
    : `${value.slice(0, AUDIT_MAX_TEXT_LENGTH - 1)}…`
}

function createDigest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function readAuditRetentionDays() {
  const configured = Number(
    readEnvironment('MUKUROJI_AUDIT_RETENTION_DAYS') ??
      readEnvironment('AUDIT_RETENTION_DAYS') ??
      2555,
  )

  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 2555
}

async function readCheckpoint(path: string, configurationHash: string): Promise<CheckpointState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))

    if (!isCheckpointState(parsed)) {
      throw new Error(`Checkpoint file is invalid: ${path}`)
    }

    if (parsed.configurationHash !== configurationHash) {
      throw new Error(
        `Checkpoint table configuration does not match this run: ${path}`,
      )
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
      'team-issue-events': createEmptySourceCheckpoint(),
      'team-issues': createEmptySourceCheckpoint(),
      'project-tasks': createEmptySourceCheckpoint(),
      'project-directory': createEmptySourceCheckpoint(),
    },
  }
}

function createEmptySourceCheckpoint(): SourceCheckpoint {
  return {
    completed: false,
    counters: {
      scanned: 0,
      written: 0,
      duplicates: 0,
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

  if (!isRecord(value.sources)) {
    return false
  }

  const sources = value.sources

  return sourceNames.every((sourceName) => isSourceCheckpoint(sources[sourceName]))
}

function isSourceCheckpoint(value: unknown): value is SourceCheckpoint {
  if (!isRecord(value) || typeof value.completed !== 'boolean' || !isRecord(value.counters)) {
    return false
  }

  const counters = value.counters

  return (
    typeof counters.scanned === 'number' &&
    typeof counters.written === 'number' &&
    typeof counters.duplicates === 'number' &&
    typeof counters.skipped === 'number' &&
    (value.lastEvaluatedKey === undefined || isRecord(value.lastEvaluatedKey))
  )
}

function printSummary(checkpoint: CheckpointState, definitions: SourceDefinition[]) {
  for (const definition of definitions) {
    const source = checkpoint.sources[definition.name]

    console.info(
      `${definition.name}: completed=${source.completed} scanned=${source.counters.scanned} ` +
      `written=${source.counters.written} duplicates=${source.counters.duplicates} ` +
      `skipped=${source.counters.skipped}`,
    )
  }
}

function isSourceName(value: string): value is SourceName {
  return sourceNames.some((sourceName) => sourceName === value)
}

function isLocalEndpoint(endpoint: string) {
  try {
    const host = new URL(endpoint).hostname

    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'floci'].includes(host)
  } catch {
    return false
  }
}

function readEnvironment(name: string) {
  const value = process.env[name]

  return value?.trim() || undefined
}

function isNamedError(error: unknown, nameOrCode: string) {
  if (!isRecord(error)) {
    return false
  }

  const namedError = error as NamedError

  return namedError.name === nameOrCode || namedError.code === nameOrCode
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
