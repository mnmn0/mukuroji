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
  AUDIT_UNKNOWN_OCCURRED_AT,
  calculateAuditExpiresAt,
  createAuditEvent as createSchemaV1AuditEvent,
  createAuditFieldChanges,
  createMutationAuditContext,
  createWorkspaceInvitationAuditEntityId,
  createWorkspaceMemberAuditEntityId,
  ensureLocalAuditEventsTable,
  readWorkspaceAuditPseudonymKey,
  WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION,
  type AuditEventV1,
  type AuditFieldChange,
} from '../../src/modules/audit'
import { isCanonicalWorkItemRecord } from '../../src/modules/work-items'

const checkpointVersion = 2
const scanPageSize = 100
const sourceNames = [
  'team-issue-events',
  'team-issues',
  'project-tasks',
  'project-directory',
  'workspace-access',
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
   * 保存 metadata では legacy key を digest に置き換えるかどうかです。
   */
  redactLegacyKey?: boolean
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
   * 明示的に allowlist した非 domain metadata item 数です。
   */
  ignored: number
  /**
   * 既存 source mapper が必須 field 不足などで変換できず skip した item 数です。
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
  version: 2
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
   * Workspace member / invitation lifecycle table 名です。
   */
  workspaceAccess: string
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
  mapItem: (item: Record<string, unknown>) => AuditEventV1 | null | undefined
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
  const workspaceAuditPseudonymKey = readWorkspaceAuditPseudonymKey()
  const configurationHash = createDigest(JSON.stringify({
    endpoint: endpoint ?? 'aws-default',
    region,
    profile: readEnvironment('AWS_PROFILE') ?? 'default-provider-chain',
    account: readEnvironment('AWS_ACCOUNT_ID') ?? 'unknown-account',
    tables,
    workspaceAccessEntityIdContract: WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION,
    workspaceAuditPseudonymKeyFingerprint: createDigest(workspaceAuditPseudonymKey),
  }))
  const checkpoint = await readCheckpoint(options.checkpointPath, configurationHash)
  const dynamoDbClient = createDynamoDbClient(endpoint, region)
  const client = createDocumentClient(dynamoDbClient)
  const definitions = createSourceDefinitions(tables, workspaceAuditPseudonymKey)
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
    checkpointPath: resolve(process.cwd(), 'audit-event-backfill-v2.checkpoint.json'),
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
  console.info(`Usage: bun server/scripts/backfills/backfill-audit-events.ts [options]

Options:
  --dry-run                 Scan and map items without writing events/checkpoint.
  --checkpoint <path>      Checkpoint JSON path (default: ./audit-event-backfill-v2.checkpoint.json).
  --limit <count>          Maximum source items scanned in this run.
  --source <name>          Run only team-issue-events, team-issues, project-tasks,
                           project-directory, or workspace-access.
  --help, -h               Show this help.

Required production environment:
  TEAM_ISSUE_EVENTS_TABLE_NAME, TEAM_ISSUES_TABLE_NAME, TASKS_TABLE_NAME,
  PROJECT_DIRECTORY_TABLE_NAME, WORKSPACE_ACCESS_TABLE_NAME, AUDIT_EVENTS_TABLE_NAME,
  MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY (exactly 64 lowercase hexadecimal characters)

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
    workspaceAccess: resolveTableName(
      ['MUKUROJI_WORKSPACE_ACCESS_TABLE', 'WORKSPACE_ACCESS_TABLE_NAME'],
      'mukuroji-workspace-access-local',
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

function createSourceDefinitions(
  tables: TableNames,
  workspaceAuditPseudonymKey: string,
): SourceDefinition[] {
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
    {
      name: 'workspace-access',
      tableName: tables.workspaceAccess,
      mapItem: (item) => mapWorkspaceAccessItem(item, workspaceAuditPseudonymKey),
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

        if (event === null) {
          sourceCheckpoint.counters.ignored += 1
          continue
        }

        if (!event) {
          sourceCheckpoint.counters.skipped += 1
          console.warn(`Skipped invalid or unsupported ${definition.name} item.`)
          continue
        }

        if (options.dryRun) {
          console.info(`[dry-run] ${event.eventType} eventId=${event.eventId}`)
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
    source: 'backfill',
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
    throw new TypeError(
      'Audit backfill encountered a non-canonical Work Item row.',
    )
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
      ['schedule', false],
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

/**
 * WorkspaceAccessTable の canonical member / invitation row を snapshot event へ変換します。
 *
 * @remarks
 * `WORKSPACE` metadata row は event を作らず無視します。一方、member / invitation row の破損や
 * 未知の row は、欠落を ignored / skipped として隠さないよう fail-closed で例外にします。
 */
export function mapWorkspaceAccessItem(
  item: Record<string, unknown>,
  workspaceAuditPseudonymKey: string,
) {
  const entryType = readOptionalString(item, 'entryType')
  const recordKey = readOptionalString(item, 'recordKey')

  if (entryType === 'workspace-meta' || recordKey === 'WORKSPACE') {
    assertWorkspaceAccessRow(
      entryType === 'workspace-meta' && recordKey === 'WORKSPACE' &&
        readRequiredString(item, 'workspaceId') !== undefined,
      'Workspace metadata row has an invalid key or entryType.',
    )
    return null
  }

  if (entryType === 'workspace-member' || recordKey?.startsWith('MEMBER#')) {
    return mapWorkspaceMemberItem(item, workspaceAuditPseudonymKey)
  }

  if (entryType === 'workspace-invitation' || recordKey?.startsWith('INVITATION#')) {
    return mapWorkspaceInvitationItem(item, workspaceAuditPseudonymKey)
  }

  throw new Error('Invalid workspace-access source row: Unrecognized row discriminator.')
}

function mapWorkspaceMemberItem(
  item: Record<string, unknown>,
  workspaceAuditPseudonymKey: string,
) {
  const workspaceId = requireWorkspaceAccessString(item, 'workspaceId', 'Workspace member')
  const recordKey = requireWorkspaceAccessString(item, 'recordKey', 'Workspace member')
  const entryType = requireWorkspaceAccessString(item, 'entryType', 'Workspace member')
  const memberKey = normalizeWorkspaceAccessEmail(
    requireWorkspaceAccessString(item, 'memberKey', 'Workspace member'),
    'Workspace member key',
  )
  const email = normalizeWorkspaceAccessEmail(
    requireWorkspaceAccessString(item, 'email', 'Workspace member'),
    'Workspace member email',
  )
  const id = normalizeWorkspaceAccessEmail(
    requireWorkspaceAccessString(item, 'id', 'Workspace member'),
    'Workspace member ID',
  )
  const role = requireWorkspaceAccessString(item, 'role', 'Workspace member')
  const status = requireWorkspaceAccessString(item, 'status', 'Workspace member')
  requireWorkspaceAccessTimestamp(item, 'createdAt', 'Workspace member')
  const updatedAt = requireWorkspaceAccessTimestamp(item, 'updatedAt', 'Workspace member')

  assertWorkspaceAccessRow(entryType === 'workspace-member', 'Workspace member entryType is invalid.')
  assertWorkspaceAccessRow(recordKey === `MEMBER#${memberKey}`, 'Workspace member recordKey is invalid.')
  assertWorkspaceAccessRow(email === memberKey, 'Workspace member email and memberKey do not match.')
  assertWorkspaceAccessRow(id === memberKey, 'Workspace member ID and memberKey do not match.')
  assertWorkspaceAccessRow(
    role === 'owner' || role === 'admin' || role === 'member' || role === 'guest',
    'Workspace member role is invalid.',
  )
  assertWorkspaceAccessRow(
    status === 'active' || status === 'deactivated',
    'Workspace member status is invalid.',
  )
  requireWorkspaceAccessVersion(item, 'Workspace member')
  validateOptionalWorkspaceAccessTimestamp(item, 'deactivatedAt', 'Workspace member')
  validateOptionalWorkspaceAccessString(item, 'name', 'Workspace member')
  validateOptionalWorkspaceAccessIdentityOwnership(item, 'Workspace member')

  const memberId = createWorkspaceMemberAuditEntityId(
    workspaceId,
    memberKey,
    workspaceAuditPseudonymKey,
  )

  return createAuditEvent({
    legacySource: 'workspace-access',
    legacyKey: `${workspaceId}#${recordKey}`,
    redactLegacyKey: true,
    eventType: 'member.backfilled',
    directoryId: workspaceId,
    occurredAt: updatedAt,
    actorUserId: 'system:backfill',
    entityType: 'member',
    entityId: memberId,
    targetType: 'member',
    targetId: memberId,
    action: 'backfilled',
    changes: createSnapshotChanges(item, [
      ['memberKey', true],
      ['email', true],
      ['name', true],
      ['role', false],
      ['status', false],
      ['version', false],
      ['createdAt', false],
      ['updatedAt', false],
      ['deactivatedAt', false],
      ['identityOwnership', false],
    ]),
    reason: 'Current Workspace member snapshot backfilled; historical transitions were not reconstructed.',
    source: 'backfill',
    metadata: { kind: 'workspace-member' },
  })
}

function mapWorkspaceInvitationItem(
  item: Record<string, unknown>,
  workspaceAuditPseudonymKey: string,
) {
  const workspaceId = requireWorkspaceAccessString(item, 'workspaceId', 'Workspace invitation')
  const recordKey = requireWorkspaceAccessString(item, 'recordKey', 'Workspace invitation')
  const entryType = requireWorkspaceAccessString(item, 'entryType', 'Workspace invitation')
  const invitationId = normalizeWorkspaceAccessEmail(
    requireWorkspaceAccessString(item, 'id', 'Workspace invitation'),
    'Workspace invitation ID',
  )
  const email = normalizeWorkspaceAccessEmail(
    requireWorkspaceAccessString(item, 'email', 'Workspace invitation'),
    'Workspace invitation email',
  )
  const role = requireWorkspaceAccessString(item, 'role', 'Workspace invitation')
  const status = requireWorkspaceAccessString(item, 'status', 'Workspace invitation')
  const deliveryStatus = requireWorkspaceAccessString(item, 'deliveryStatus', 'Workspace invitation')
  const identityOwnership = requireWorkspaceAccessString(
    item,
    'identityOwnership',
    'Workspace invitation',
  )
  const updatedAt = requireWorkspaceAccessTimestamp(item, 'updatedAt', 'Workspace invitation')
  requireWorkspaceAccessTimestamp(item, 'createdAt', 'Workspace invitation')

  assertWorkspaceAccessRow(
    entryType === 'workspace-invitation',
    'Workspace invitation entryType is invalid.',
  )
  assertWorkspaceAccessRow(
    recordKey === `INVITATION#${invitationId}`,
    'Workspace invitation recordKey is invalid.',
  )
  assertWorkspaceAccessRow(email === invitationId, 'Workspace invitation email and ID do not match.')
  assertWorkspaceAccessRow(
    role === 'owner' || role === 'admin' || role === 'member' || role === 'guest',
    'Workspace invitation role is invalid.',
  )
  assertWorkspaceAccessRow(
    status === 'provisioning' || status === 'pending' || status === 'delivery-failed' ||
      status === 'expired' || status === 'revoked' || status === 'accepted',
    'Workspace invitation status is invalid.',
  )
  assertWorkspaceAccessRow(
    deliveryStatus === 'pending' || deliveryStatus === 'sent' || deliveryStatus === 'failed' ||
      deliveryStatus === 'not-required',
    'Workspace invitation deliveryStatus is invalid.',
  )
  assertWorkspaceAccessRow(
    identityOwnership === 'workspace-created' || identityOwnership === 'pre-existing' ||
      identityOwnership === 'ambiguous',
    'Workspace invitation identityOwnership is invalid.',
  )
  requireWorkspaceAccessVersion(item, 'Workspace invitation')
  requireWorkspaceAccessTimestamp(item, 'expiresAt', 'Workspace invitation')
  validateOptionalWorkspaceAccessTimestamp(item, 'acceptedAt', 'Workspace invitation')
  validateOptionalWorkspaceAccessTimestamp(item, 'lastSentAt', 'Workspace invitation')
  validateOptionalWorkspaceAccessTimestamp(item, 'acceptanceLockExpiresAt', 'Workspace invitation')
  validateOptionalWorkspaceAccessString(item, 'name', 'Workspace invitation')
  validateOptionalWorkspaceAccessString(item, 'failureMessage', 'Workspace invitation')
  validateOptionalWorkspaceAccessString(item, 'cognitoIdentityId', 'Workspace invitation')
  validateOptionalWorkspaceAccessString(item, 'cognitoUsername', 'Workspace invitation')
  for (const field of [
    'directoryClaimCleanupRequired',
    'identityCleanupCompleted',
    'identityCleanupManualRequired',
    'identityMutationAttempted',
  ]) {
    assertWorkspaceAccessRow(
      item[field] === undefined || typeof item[field] === 'boolean',
      `Workspace invitation ${field} is invalid.`,
    )
  }
  assertWorkspaceAccessRow(
    item.identityLifecycleVersion === undefined || item.identityLifecycleVersion === 2,
    'Workspace invitation identityLifecycleVersion is invalid.',
  )

  const scopedInvitationId = createWorkspaceInvitationAuditEntityId(
    workspaceId,
    invitationId,
    workspaceAuditPseudonymKey,
  )

  return createAuditEvent({
    legacySource: 'workspace-access',
    legacyKey: `${workspaceId}#${recordKey}`,
    redactLegacyKey: true,
    eventType: 'invitation.backfilled',
    directoryId: workspaceId,
    occurredAt: updatedAt,
    actorUserId: 'system:backfill',
    entityType: 'invitation',
    entityId: scopedInvitationId,
    targetType: 'invitation',
    targetId: scopedInvitationId,
    action: 'backfilled',
    changes: createSnapshotChanges(item, [
      ['email', true],
      ['name', true],
      ['role', false],
      ['status', false],
      ['deliveryStatus', false],
      ['identityOwnership', false],
      ['identityLifecycleVersion', false],
      ['directoryClaimCleanupRequired', false],
      ['identityCleanupCompleted', false],
      ['identityCleanupManualRequired', false],
      ['identityMutationAttempted', false],
      ['version', false],
      ['expiresAt', false],
      ['createdAt', false],
      ['updatedAt', false],
      ['acceptedAt', false],
      ['lastSentAt', false],
      ['acceptanceLockExpiresAt', false],
      ['failureMessage', true],
    ]),
    reason: 'Current Workspace invitation snapshot backfilled; historical transitions were not reconstructed.',
    source: 'backfill',
    metadata: { kind: 'workspace-invitation' },
  })
}

function requireWorkspaceAccessString(
  item: Record<string, unknown>,
  fieldName: string,
  rowLabel: string,
) {
  const value = readRequiredString(item, fieldName)

  assertWorkspaceAccessRow(value !== undefined, `${rowLabel} ${fieldName} is required.`)
  return value
}

function requireWorkspaceAccessTimestamp(
  item: Record<string, unknown>,
  fieldName: string,
  rowLabel: string,
) {
  const rawValue = item[fieldName]
  const value = requireWorkspaceAccessString(item, fieldName, rowLabel)
  const timestamp = new Date(value)

  assertWorkspaceAccessRow(
    rawValue === value && !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value,
    `${rowLabel} ${fieldName} is invalid.`,
  )
  return value
}

function validateOptionalWorkspaceAccessTimestamp(
  item: Record<string, unknown>,
  fieldName: string,
  rowLabel: string,
) {
  if (item[fieldName] === undefined) return
  requireWorkspaceAccessTimestamp(item, fieldName, rowLabel)
}

function validateOptionalWorkspaceAccessString(
  item: Record<string, unknown>,
  fieldName: string,
  rowLabel: string,
) {
  if (item[fieldName] === undefined) return
  requireWorkspaceAccessString(item, fieldName, rowLabel)
}

function validateOptionalWorkspaceAccessIdentityOwnership(
  item: Record<string, unknown>,
  rowLabel: string,
) {
  if (item.identityOwnership === undefined) return
  const value = requireWorkspaceAccessString(item, 'identityOwnership', rowLabel)

  assertWorkspaceAccessRow(
    value === 'workspace-created' || value === 'pre-existing' || value === 'ambiguous',
    `${rowLabel} identityOwnership is invalid.`,
  )
}

function requireWorkspaceAccessVersion(item: Record<string, unknown>, rowLabel: string) {
  const value = item.version

  assertWorkspaceAccessRow(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
    `${rowLabel} version is invalid.`,
  )
  return value
}

function normalizeWorkspaceAccessEmail(value: string, fieldLabel: string) {
  const normalized = value.trim().toLowerCase()

  assertWorkspaceAccessRow(
    normalized.length > 0 && normalized.includes('@'),
    `${fieldLabel} is invalid.`,
  )
  return normalized
}

function assertWorkspaceAccessRow(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invalid workspace-access source row: ${message}`)
  }
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
    ...(input.occurredAt === AUDIT_UNKNOWN_OCCURRED_AT
      ? {}
      : { expiresAt: calculateAuditExpiresAt(input.occurredAt, readAuditRetentionDays()) }),
    metadata: {
      ...input.metadata,
      backfilled: true,
      legacyKey: input.redactLegacyKey
        ? `sha256:${createDigest(input.legacyKey)}`
        : input.legacyKey,
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
    return AUDIT_UNKNOWN_OCCURRED_AT
  }

  const timestamp = Date.parse(value)

  return Number.isNaN(timestamp) ? AUDIT_UNKNOWN_OCCURRED_AT : new Date(timestamp).toISOString()
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

    if (isRecord(parsed) && parsed.version === 1) {
      throw new Error(
        `Checkpoint v1 cannot be resumed after adding workspace-access: ${path}. Choose a separate path for the new v2 checkpoint.`,
      )
    }

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
      'workspace-access': createEmptySourceCheckpoint(),
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
      ignored: 0,
      skipped: 0,
    },
  }
}

async function writeCheckpoint(path: string, checkpoint: CheckpointState) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(
    temporaryPath,
    `${JSON.stringify(checkpoint, undefined, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
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
    typeof counters.ignored === 'number' &&
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
      `ignored=${source.counters.ignored} skipped=${source.counters.skipped}`,
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
