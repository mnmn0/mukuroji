import { createHash, createHmac } from 'node:crypto'
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
import { isLocalDynamoDbEndpoint } from './backfill-endpoint'

const checkpointVersion = 3
const scanPageSize = 100
const sourceNames = [
  'team-issues',
  'project-directory',
  'workspace-access',
] as const

/** Source table names supported by the audit-event backfill. */
type SourceName = typeof sourceNames[number]

/** A DynamoDB key returned by the DocumentClient. */
type DynamoKey = Record<string, unknown>

/** Input used to construct a schema-versioned audit event. */
type AuditEventInput = {
  /** Source table name. */
  sourceName: SourceName
  /** Source item key used only while constructing the event. */
  sourceKey: string
  /** Domain event type. */
  eventType: string
  /** Canonical workspace directory ID. */
  directoryId: string
  /** Event timestamp. */
  occurredAt: string
  /** User or system actor ID. */
  actorUserId: string
  /** Activity entity type. */
  entityType: string
  /** Activity entity ID. */
  entityId: string
  /** Directly changed resource type. */
  targetType: string
  /** Directly changed resource ID. */
  targetId: string
  /** Mutation action. */
  action: string
  /** Reconstructed field changes. */
  changes: AuditFieldChange[]
  /** Human-readable reason for generating the event. */
  reason?: string
  /** Whether the event is a migration or current-snapshot backfill. */
  source: 'migration' | 'backfill'
  /** Adapter scope or source diagnostics that are safe to persist. */
  metadata?: Readonly<Record<string, unknown>>
  /** Dedicated key used to pseudonymize the source key before persistence. */
  sourcePseudonymKey: string
}

/** Command-line options for one backfill run. */
type BackfillOptions = {
  /** Whether to scan and map without writing DynamoDB or checkpoints. */
  dryRun: boolean
  /** Whether to print help and exit. */
  help: boolean
  /** Path for the checkpoint JSON file. */
  checkpointPath: string
  /** Maximum number of source items to scan in one run. */
  limit?: number
  /** Optional source name to run exclusively. */
  source?: SourceName
}

/** Cumulative counters for one source. */
type BackfillCounters = {
  /** Number of source items scanned. */
  scanned: number
  /** Number of newly written events. */
  written: number
  /** Number of events found to already exist by a conditional write. */
  duplicates: number
  /** Number of explicitly allowlisted non-domain metadata items. */
  ignored: number
  /** Number of source items skipped by a mapper because they are unsupported or incomplete. */
  skipped: number
}

/** Scan checkpoint for one source. */
type SourceCheckpoint = {
  /** Whether scanning the source table has completed. */
  completed: boolean
  /** DynamoDB ExclusiveStartKey for the next page. */
  lastEvaluatedKey?: DynamoKey
  /** Cumulative counters for the source. */
  counters: BackfillCounters
}

/** Checkpoint file for the complete backfill. */
type CheckpointState = {
  /** Checkpoint schema version. */
  version: 3
  /** Hash that prevents resuming with a different table configuration. */
  configurationHash: string
  /** Time at which the checkpoint was last updated. */
  updatedAt: string
  /** Checkpoint for each source. */
  sources: Record<SourceName, SourceCheckpoint>
}

/**
 * DynamoDB table names used by the audit-event backfill.
 */
type TableNames = {
  /** Current Team Issue table name. */
  teamIssues: string
  /** Team, project, and member directory table name. */
  projectDirectory: string
  /** Workspace membership and invitation lifecycle table name. */
  workspaceAccess: string
  /** Destination audit-events table name. */
  auditEvents: string
}

/** Scan and mapping definition for one source table. */
type SourceDefinition = {
  /** Source name used by the CLI and checkpoint. */
  name: SourceName
  /** DynamoDB table to scan. */
  tableName: string
  /** Converts a source item into a generic audit event. */
  mapItem: (item: Record<string, unknown>) => AuditEventV1 | null | undefined
}

/** Minimal shape used to identify Node and AWS SDK errors. */
type NamedError = {
  /** Node or AWS SDK error name. */
  name?: string
  /** Node filesystem error code. */
  code?: string
}

/** Runs the audit-event backfill CLI. */
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

  if (!options.dryRun && endpoint && isLocalDynamoDbEndpoint(endpoint)) {
    await ensureLocalAuditEventsTable(tables.auditEvents, dynamoDbClient)
  }

  console.info(
    `Audit event backfill started: target=${tables.auditEvents} dryRun=${options.dryRun} ` +
    `limit=${options.limit ?? 'unlimited'} checkpoint=${options.checkpointPath}`,
  )

  await runBackfill(client, definitions, tables.auditEvents, checkpoint, options)
  printSummary(checkpoint, definitions)
}

/**
 * Parses command-line arguments for a backfill run.
 *
 * @param args Arguments excluding the Bun executable and script path.
 * @returns Validated backfill options.
 * @throws When an option is unknown or has an invalid value.
 */
function parseArguments(args: string[]): BackfillOptions {
  const options: BackfillOptions = {
    dryRun: false,
    help: false,
    checkpointPath: resolve(process.cwd(), 'audit-event-backfill-v3.checkpoint.json'),
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

/**
 * Reads an option value supplied either after an option or after an equals sign.
 *
 * @param argument Current command-line argument.
 * @param following Following command-line argument, when present.
 * @param optionName Name used in validation errors.
 * @returns The non-empty option value.
 * @throws When the option has no value or the value looks like another option.
 */
function readOptionValue(argument: string, following: string | undefined, optionName: string) {
  const equalsIndex = argument.indexOf('=')
  const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : following

  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`)
  }

  return value
}

/**
 * Parses a positive safe integer command-line option.
 *
 * @param value Raw option value.
 * @param optionName Name used in validation errors.
 * @returns The parsed positive integer.
 * @throws When the value is not a positive safe integer.
 */
function parsePositiveInteger(value: string, optionName: string) {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`)
  }

  return parsed
}

/** Prints the command-line usage and required environment variables. */
function printHelp() {
  console.info(`Usage: bun server/scripts/backfills/backfill-audit-events.ts [options]

Options:
  --dry-run                 Scan and map items without writing events/checkpoint.
  --checkpoint <path>      Checkpoint JSON path (default: ./audit-event-backfill-v3.checkpoint.json).
  --limit <count>          Maximum source items scanned in this run.
  --source <name>          Run only team-issues, project-directory, or workspace-access.
  --help, -h               Show this help.

Required production environment:
  TEAM_ISSUES_TABLE_NAME, PROJECT_DIRECTORY_TABLE_NAME, WORKSPACE_ACCESS_TABLE_NAME,
  AUDIT_EVENTS_TABLE_NAME,
  MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY (exactly 64 lowercase hexadecimal characters)

For a local endpoint, repository-local default table names are used when omitted.
Write runs bootstrap mukuroji-audit-events with the shared schema when it is missing.`)
}

/**
 * Resolves source and destination table names from the environment.
 *
 * @param endpoint Optional DynamoDB endpoint used to determine whether local defaults are allowed.
 * @returns Resolved table names for the backfill.
 * @throws When a required table name is missing outside a local DynamoDB endpoint.
 */
function resolveTableNames(endpoint: string | undefined): TableNames {
  const allowLocalDefaults = endpoint !== undefined && isLocalDynamoDbEndpoint(endpoint)

  return {
    teamIssues: resolveTableName(
      ['MUKUROJI_TEAM_ISSUES_TABLE', 'TEAM_ISSUES_TABLE_NAME'],
      'mukuroji-team-issues-local',
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

/**
 * Resolves a table name from environment aliases and an optional local default.
 *
 * @param environmentNames Environment variable aliases in priority order.
 * @param localDefault Default used for local DynamoDB only.
 * @param allowLocalDefault Whether local defaults are permitted.
 * @returns The resolved table name.
 * @throws When no configured name exists and local defaults are not allowed.
 */
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

/** Creates the DynamoDB client used by the backfill. */
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

/** Creates a DocumentClient configured to omit undefined attribute values. */
function createDocumentClient(baseClient: DynamoDBClient) {
  return DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  })
}

/**
 * Creates the ordered source mappings consumed by the audit-event backfill.
 *
 * @param tables Resolved source and destination table names.
 * @param workspaceAuditPseudonymKey Key used to pseudonymize workspace audit data.
 * @returns Source definitions in checkpoint and processing order.
 */
function createSourceDefinitions(
  tables: TableNames,
  workspaceAuditPseudonymKey: string,
): SourceDefinition[] {
  return [
    {
      name: 'team-issues',
      tableName: tables.teamIssues,
      mapItem: (item) => mapCurrentTeamIssue(item, workspaceAuditPseudonymKey),
    },
    {
      name: 'project-directory',
      tableName: tables.projectDirectory,
      mapItem: (item) => mapProjectDirectoryItem(item, workspaceAuditPseudonymKey),
    },
    {
      name: 'workspace-access',
      tableName: tables.workspaceAccess,
      mapItem: (item) => mapWorkspaceAccessItem(item, workspaceAuditPseudonymKey),
    },
  ]
}

/**
 * Runs source scans, maps rows, and conditionally writes audit events.
 *
 * @param client DynamoDB DocumentClient.
 * @param definitions Ordered source mapping definitions.
 * @param auditEventsTableName Destination audit-events table name.
 * @param checkpoint Mutable checkpoint state.
 * @param options Backfill execution options.
 * @returns A promise that resolves after the selected sources are processed.
 */
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

/**
 * Writes an audit event unless the same workspace/event key already exists.
 *
 * @param client DynamoDB DocumentClient.
 * @param tableName Destination audit-events table name.
 * @param event Event to write.
 * @returns Whether the event was newly written or already existed.
 * @throws For DynamoDB errors other than a conditional-write conflict.
 */
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

/**
 * Converts a strict canonical Work Item row into a current-snapshot audit event.
 *
 * @param item Source row to validate and map.
 * @param sourcePseudonymKey Dedicated key used to pseudonymize the source key.
 * @returns A deterministic audit event for the canonical Work Item.
 * @throws When the row is not a canonical Work Item. Non-canonical rows are rejected
 *   instead of being represented as partial backfill data.
 */
export function mapCurrentTeamIssue(
  item: Record<string, unknown>,
  sourcePseudonymKey: string,
) {
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
    sourceName: 'team-issues',
    sourceKey: `${directoryTeamId}#${issueId}`,
    sourcePseudonymKey,
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
      adapter: 'canonical-work-item',
      teamId,
    },
  })
}

/**
 * Converts a project-directory row into a safe current-snapshot audit event.
 *
 * @param item Source row to validate and map.
 * @param sourcePseudonymKey Dedicated key used to pseudonymize the source key.
 * @returns A mapped event, or undefined when the row is incomplete or unsupported.
 */
function mapProjectDirectoryItem(
  item: Record<string, unknown>,
  sourcePseudonymKey: string,
) {
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
      sourceName: 'project-directory',
      sourceKey: entryKey,
      sourcePseudonymKey,
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
      sourceName: 'project-directory',
      sourceKey: entryKey,
      sourcePseudonymKey,
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
      sourceName: 'project-directory',
      sourceKey: entryKey,
      sourcePseudonymKey,
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
 * Converts a canonical workspace member or invitation row into a snapshot event.
 *
 * @param item Source row to validate and map.
 * @param workspaceAuditPseudonymKey Dedicated key used for workspace-bound identifiers.
 * @returns null for the valid workspace metadata row, or a mapped member/invitation event.
 * @throws When a member or invitation row is malformed or has an unknown discriminator.
 *
 * Workspace metadata rows are ignored, while malformed domain rows fail closed so that
 * missing data cannot be hidden as an ordinary skipped item.
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

/**
 * Converts a validated workspace member row into a pseudonymized snapshot event.
 *
 * @param item Source row to validate and map.
 * @param workspaceAuditPseudonymKey Dedicated key used for workspace-bound identifiers.
 * @returns A pseudonymized workspace member audit event.
 * @throws When a required field or workspace member invariant is invalid.
 */
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
    sourceName: 'workspace-access',
    sourceKey: `${workspaceId}#${recordKey}`,
    sourcePseudonymKey: workspaceAuditPseudonymKey,
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

/**
 * Converts a validated workspace invitation row into a pseudonymized snapshot event.
 *
 * @param item Source row to validate and map.
 * @param workspaceAuditPseudonymKey Dedicated key used for workspace-bound identifiers.
 * @returns A pseudonymized workspace invitation audit event.
 * @throws When a required field or workspace invitation invariant is invalid.
 */
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
    sourceName: 'workspace-access',
    sourceKey: `${workspaceId}#${recordKey}`,
    sourcePseudonymKey: workspaceAuditPseudonymKey,
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

/** Reads a required non-empty workspace-access string field. */
function requireWorkspaceAccessString(
  item: Record<string, unknown>,
  fieldName: string,
  rowLabel: string,
) {
  const value = readRequiredString(item, fieldName)

  assertWorkspaceAccessRow(value !== undefined, `${rowLabel} ${fieldName} is required.`)
  return value
}

/** Reads a required and valid workspace-access timestamp field. */
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

/** Validates an optional workspace-access timestamp when it is present. */
function validateOptionalWorkspaceAccessTimestamp(
  item: Record<string, unknown>,
  fieldName: string,
  rowLabel: string,
) {
  if (item[fieldName] === undefined) return
  requireWorkspaceAccessTimestamp(item, fieldName, rowLabel)
}

/** Validates an optional workspace-access string when it is present. */
function validateOptionalWorkspaceAccessString(
  item: Record<string, unknown>,
  fieldName: string,
  rowLabel: string,
) {
  if (item[fieldName] === undefined) return
  requireWorkspaceAccessString(item, fieldName, rowLabel)
}

/** Validates optional identity ownership state on a workspace-access row. */
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

/** Validates and returns the required positive version of a workspace-access row. */
function requireWorkspaceAccessVersion(item: Record<string, unknown>, rowLabel: string) {
  const value = item.version

  assertWorkspaceAccessRow(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1,
    `${rowLabel} version is invalid.`,
  )
  return value
}

/** Normalizes and validates a workspace-access email or email-like identifier. */
function normalizeWorkspaceAccessEmail(value: string, fieldLabel: string) {
  const normalized = value.trim().toLowerCase()

  assertWorkspaceAccessRow(
    normalized.length > 0 && normalized.includes('@'),
    `${fieldLabel} is invalid.`,
  )
  return normalized
}

/** Throws when a workspace-access row invariant is false. */
function assertWorkspaceAccessRow(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invalid workspace-access source row: ${message}`)
  }
}

/**
 * Creates a schema-versioned backfill event without persisting the source key.
 *
 * @param input Event fields and the dedicated pseudonymization key.
 * @returns A deterministic audit event with a suppressed outbox status.
 */
function createAuditEvent(input: AuditEventInput): AuditEventV1 {
  const sourceKeyPseudonym = createSourceKeyPseudonym(
    input.sourcePseudonymKey,
    input.sourceName,
    input.sourceKey,
  )
  const context = createMutationAuditContext({
    workspaceId: input.directoryId,
    actor: {
      id: input.actorUserId,
      kind: input.actorUserId.startsWith('system:') ? 'system' : 'user',
      displayName: input.actorUserId,
    },
    idempotencyKey: `backfill:${sourceKeyPseudonym}`,
    request: {
      method: 'BACKFILL',
      path: `/audit/backfill/${input.sourceName}`,
    },
    source: {
      kind: input.source,
      method: 'BACKFILL',
      requestId: `backfill:${sourceKeyPseudonym.slice(0, 32)}`,
      route: `/audit/backfill/${input.sourceName}`,
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
    },
    outboxStatus: 'suppressed',
  })
}

/**
 * Creates a deterministic pseudonym for a source key using the dedicated audit key.
 *
 * @param key Dedicated workspace audit pseudonymization key.
 * @param sourceName Source table name used for domain separation.
 * @param sourceKey Source item key held only in memory during mapping.
 * @returns A hexadecimal HMAC-SHA-256 pseudonym that cannot be dictionary-matched without the key.
 */
function createSourceKeyPseudonym(
  key: string,
  sourceName: SourceName,
  sourceKey: string,
) {
  return createHmac('sha256', key)
    .update(`audit-backfill-source\0${sourceName}\0${sourceKey}`)
    .digest('hex')
}

/**
 * Builds redacted and non-redacted snapshot field changes from a source row.
 *
 * @param item Source row containing the snapshot values.
 * @param fields Field names paired with their redaction setting.
 * @returns Audit field changes for the selected fields.
 */
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

/**
 * Builds the canonical Work Item entity ID used by audit consumers.
 *
 * @param teamId Owning team ID.
 * @param issueId Work Item ID.
 * @returns A length-limited canonical Work Item entity ID.
 */
function createTeamIssueWorkItemId(teamId: string, issueId: string) {
  return limitBackfillText(`team/${teamId}/issue/${issueId}`)
}

/**
 * Normalizes a source timestamp or returns the audit unknown-time sentinel.
 *
 * @param value Candidate timestamp.
 * @returns An ISO timestamp or the unknown-time sentinel.
 */
function normalizeTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    return AUDIT_UNKNOWN_OCCURRED_AT
  }

  const timestamp = Date.parse(value)

  return Number.isNaN(timestamp) ? AUDIT_UNKNOWN_OCCURRED_AT : new Date(timestamp).toISOString()
}

/**
 * Reads and length-limits a required string field.
 *
 * @param item Source row.
 * @param fieldName Field to read.
 * @returns A trimmed value, or undefined when the field is absent or not a string.
 */
function readRequiredString(item: Record<string, unknown>, fieldName: string) {
  const value = item[fieldName]

  return typeof value === 'string' && value.trim()
    ? limitBackfillText(value.trim())
    : undefined
}

/**
 * Reads and length-limits an optional string field.
 *
 * @param item Source row.
 * @param fieldName Field to read.
 * @returns A trimmed value, or undefined when the field is absent or not a string.
 */
function readOptionalString(item: Record<string, unknown>, fieldName: string) {
  const value = item[fieldName]

  return typeof value === 'string' && value.trim()
    ? limitBackfillText(value.trim())
    : undefined
}

/** Limits persisted backfill text to the audit schema maximum. */
function limitBackfillText(value: string) {
  return value.length <= AUDIT_MAX_TEXT_LENGTH
    ? value
    : `${value.slice(0, AUDIT_MAX_TEXT_LENGTH - 1)}…`
}

/** Creates a hexadecimal SHA-256 digest for non-sensitive configuration values. */
function createDigest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Reads and normalizes the configured audit retention period in days. */
function readAuditRetentionDays() {
  const configured = Number(
    readEnvironment('MUKUROJI_AUDIT_RETENTION_DAYS') ??
      readEnvironment('AUDIT_RETENTION_DAYS') ??
      2555,
  )

  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 2555
}

/**
 * Reads a checkpoint and verifies that it matches the current configuration.
 *
 * @param path Checkpoint file path.
 * @param configurationHash Expected configuration hash.
 * @returns The existing checkpoint or a new empty checkpoint when the file is absent.
 * @throws When the file is invalid or belongs to a different configuration.
 */
async function readCheckpoint(path: string, configurationHash: string): Promise<CheckpointState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))

    if (!isCheckpointState(parsed)) {
      throw new Error(`Checkpoint file is invalid: ${path}`)
    }

    if (parsed.configurationHash !== configurationHash) {
      throw new Error(
        `Checkpoint table configuration does not match this run; checkpoints created before canonical-only audit backfill require a new v3 checkpoint path: ${path}`,
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

/** Creates an empty checkpoint for the current source set and configuration. */
function createEmptyCheckpoint(configurationHash: string): CheckpointState {
  return {
    version: checkpointVersion,
    configurationHash,
    updatedAt: new Date().toISOString(),
    sources: {
      'team-issues': createEmptySourceCheckpoint(),
      'project-directory': createEmptySourceCheckpoint(),
      'workspace-access': createEmptySourceCheckpoint(),
    },
  }
}

/** Creates zeroed counters for a new source checkpoint. */
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

/** Atomically writes a checkpoint file with restrictive file permissions. */
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

/** Narrows unknown checkpoint data to the current checkpoint schema. */
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

/** Narrows unknown source checkpoint data to the expected source schema. */
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

/** Prints counters for each source included in the current run. */
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

/** Narrows a string to one of the supported backfill source names. */
function isSourceName(value: string): value is SourceName {
  return sourceNames.some((sourceName) => sourceName === value)
}

/** Reads a trimmed environment variable, treating empty values as absent. */
function readEnvironment(name: string) {
  const value = process.env[name]

  return value?.trim() || undefined
}

/** Checks whether an unknown error has the requested name or filesystem code. */
function isNamedError(error: unknown, nameOrCode: string) {
  if (!isRecord(error)) {
    return false
  }

  const namedError = error as NamedError

  return namedError.name === nameOrCode || namedError.code === nameOrCode
}

/** Narrows an unknown value to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
