import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../src/infrastructure/aws/dynamodb-client'
import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditFieldChanges,
  createMutationAuditContext,
  DynamoDbAuditEventsClient,
  getConfiguredAuditRetentionDays,
} from '../../src/modules/audit'
import {
  createWorkItemCollaborationEntityKey,
} from '../../src/modules/collaboration'
import { DynamoDbCollaborationClient } from '../../src/modules/collaboration/collaboration'
import {
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'

const checkpointVersion = 1
const scanPageSize = 100

/** A validated legacy Team Issue comment event. */
type LegacyCommentEvent = {
  /** Workspace directory identifier. */
  workspaceId: string
  /** Owning Team identifier. */
  teamId: string
  /** Canonical Work Item identifier. */
  issueId: string
  /** Stable legacy event identifier reused as the comment identifier. */
  eventId: string
  /** Legacy event actor identifier. */
  actorUserId: string
  /** Legacy comment body. */
  body: string
  /** Original event timestamp. */
  createdAt: string
}

/** CLI options for the resumable comment backfill. */
type BackfillOptions = {
  /** Whether to scan and validate without writing data or checkpoint state. */
  dryRun: boolean
  /** Whether to print usage and exit. */
  help: boolean
  /** JSON checkpoint path. */
  checkpointPath: string
  /** Maximum number of matching source rows processed in this invocation. */
  limit?: number
  /** Optional workspace filter and completion-marker scope. */
  workspaceIds: string[]
}

/** DynamoDB key retained by a resumable scan checkpoint. */
type DynamoKey = Record<string, unknown>

/** Durable state for one source-table scan. */
type CheckpointState = {
  /** Checkpoint schema version. */
  version: 1
  /** Configuration digest binding the checkpoint to one environment. */
  configurationHash: string
  /** Last checkpoint update time. */
  updatedAt: string
  /** Whether the complete source table has been scanned. */
  completed: boolean
  /** DynamoDB key from which the next scan resumes. */
  lastEvaluatedKey?: DynamoKey
  /** Number of validated matching source rows seen. */
  scanned: number
  /** Number of source rows copied or replayed idempotently. */
  backfilled: number
  /** Workspaces observed in the source rows. */
  workspaceIds: string[]
}

/** Resolved table names for one migration environment. */
type TableNames = {
  /** Legacy Team Issue event table. */
  source: string
  /** Canonical Collaboration table. */
  target: string
  /** Canonical Work Item table used by the parent condition. */
  workItems: string
  /** Audit table used for the operational backfill receipt. */
  auditEvents: string
}

/** Operator and correlation context for one backfill invocation. */
type BackfillRunContext = {
  /** Stable operator identity recorded in private audit metadata. */
  operatorId: string
  /** Process-generated correlation identifier shared by completion receipts. */
  correlationId: string
  /** Digest that binds the checkpoint and audit receipt to one environment. */
  configurationHash: string
}

/** Minimal named error shape used for filesystem error narrowing. */
type NamedError = {
  /** Node error code. */
  code?: string
}

/** Runs the CLI entrypoint for the resumable legacy comment migration. */
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
  const account = resolveAccountId(endpoint)
  const operatorId = resolveOperatorId(endpoint)
  const configurationHash = createDigest(JSON.stringify({
    endpoint: endpoint ?? 'aws-default',
    region,
    profile: readEnvironment('AWS_PROFILE') ?? 'default-provider-chain',
    account,
    tables,
    requestedWorkspaceIds: options.workspaceIds,
    migration: 'team-issue-comments-v1',
  }))
  const checkpoint = await readCheckpoint(options.checkpointPath, configurationHash)
  const dynamoDbClient = createDynamoDbClient()
  const sourceClient = createDynamoDbDocumentClient(dynamoDbClient)
  const auditEvents = new DynamoDbAuditEventsClient(
    sourceClient,
    tables.auditEvents,
    undefined,
    dynamoDbClient,
    endpoint !== undefined && isLocalEndpoint(endpoint),
  )
  const collaboration = new DynamoDbCollaborationClient(
    tables.target,
    tables.workItems,
    undefined,
    undefined,
    dynamoDbClient,
    undefined,
    tables.source,
  )
  const runContext: BackfillRunContext = {
    operatorId,
    correlationId: randomUUID(),
    configurationHash,
  }

  console.info(
    `Team Issue comment backfill started: source=${tables.source} target=${tables.target} ` +
      `dryRun=${options.dryRun} limit=${options.limit ?? 'unlimited'} ` +
      `checkpoint=${options.checkpointPath}`,
  )
  await runBackfill(
    sourceClient,
    collaboration,
    auditEvents,
    tables.source,
    checkpoint,
    options,
    runContext,
  )
  printSummary(checkpoint, options)
}

/** Parses and validates command-line options for the migration runner.
 *
 * @param args - Arguments excluding the Bun executable and script path.
 * @returns Validated migration options.
 */
function parseArguments(args: string[]): BackfillOptions {
  const options: BackfillOptions = {
    dryRun: false,
    help: false,
    checkpointPath: resolve(process.cwd(), 'team-issue-comment-backfill-v1.checkpoint.json'),
    workspaceIds: [],
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
    if (argument === '--workspace-id' || argument.startsWith('--workspace-id=')) {
      const value = readOptionValue(argument, args[index + 1], '--workspace-id')
      options.workspaceIds.push(requireText(value, '--workspace-id'))
      index += argument === '--workspace-id' ? 1 : 0
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  options.workspaceIds = [...new Set(options.workspaceIds)].sort()
  return options
}

/** Reads a value supplied either after an option or after an equals sign.
 *
 * @param argument - Current command-line argument.
 * @param following - Following argument, when the option has no equals sign.
 * @param optionName - Name used in validation errors.
 * @returns The non-empty option value.
 */
function readOptionValue(argument: string, following: string | undefined, optionName: string) {
  const equalsIndex = argument.indexOf('=')
  const value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : following
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`)
  }
  return value
}

/** Parses a strictly positive safe integer option.
 *
 * @param value - Untrusted numeric option value.
 * @param optionName - Name used in validation errors.
 * @returns The validated positive integer.
 */
function parsePositiveInteger(value: string, optionName: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`)
  }
  return parsed
}

/** Prints command usage and the environment contract. */
function printHelp() {
  console.info(`Usage: bun server/scripts/backfills/backfill-team-issue-comments.ts [options]

Options:
  --dry-run                 Scan and validate without writing rows or checkpoint state.
  --checkpoint <path>      Checkpoint JSON path (default: ./team-issue-comment-backfill-v1.checkpoint.json).
  --limit <count>          Maximum matching source rows processed in this run.
  --workspace-id <id>      Restrict the scan and marker publication to this workspace; repeatable.
  --help, -h               Show this help.

Required in AWS environments:
  AWS_ACCOUNT_ID, MUKUROJI_BACKFILL_OPERATOR_ID,
  TEAM_ISSUE_EVENTS_TABLE_NAME, COLLABORATION_TABLE_NAME, TEAM_ISSUES_TABLE_NAME,
  AUDIT_EVENTS_TABLE_NAME

The marker is written only after the source Scan reaches its end. A repeated run
is safe because comment and discussion rows use the legacy event ID and conditional writes.`)
}

/** Resolves source, target, and parent table names for one migration run.
 *
 * @param endpoint - Configured DynamoDB endpoint, if any.
 * @returns Validated table names.
 */
function resolveTableNames(endpoint: string | undefined): TableNames {
  const allowLocalDefaults = endpoint !== undefined && isLocalEndpoint(endpoint)
  return {
    source: resolveTableName(
      readEnvironment('MUKUROJI_TEAM_ISSUE_EVENTS_TABLE') ?? readEnvironment('TEAM_ISSUE_EVENTS_TABLE_NAME'),
      'TEAM_ISSUE_EVENTS_TABLE_NAME',
      allowLocalDefaults ? 'mukuroji-team-issue-events-local' : undefined,
    ),
    target: resolveTableName(
      readEnvironment('MUKUROJI_COLLABORATION_TABLE') ?? readEnvironment('COLLABORATION_TABLE_NAME'),
      'COLLABORATION_TABLE_NAME',
      allowLocalDefaults ? 'mukuroji-collaboration-local' : undefined,
    ),
    workItems: resolveTableName(
      readEnvironment('MUKUROJI_WORK_ITEMS_TABLE') ??
        readEnvironment('WORK_ITEMS_TABLE_NAME') ??
        readEnvironment('TEAM_ISSUES_TABLE_NAME'),
      'TEAM_ISSUES_TABLE_NAME',
      allowLocalDefaults ? 'mukuroji-team-issues-local' : undefined,
    ),
    auditEvents: resolveTableName(
      readEnvironment('MUKUROJI_AUDIT_EVENTS_TABLE') ?? readEnvironment('AUDIT_EVENTS_TABLE_NAME'),
      'AUDIT_EVENTS_TABLE_NAME',
      allowLocalDefaults ? 'mukuroji-audit-events' : undefined,
    ),
  }
}

/** Resolves the account binding used to reject a checkpoint from another AWS account.
 *
 * @param endpoint - Configured DynamoDB endpoint, if any.
 * @returns The explicit AWS account or a local-only sentinel.
 */
function resolveAccountId(endpoint: string | undefined) {
  const configured = readEnvironment('AWS_ACCOUNT_ID')
  if (configured) return requireText(configured, 'AWS_ACCOUNT_ID')
  if (endpoint !== undefined && isLocalEndpoint(endpoint)) return 'local-account'
  throw new Error('AWS_ACCOUNT_ID is required when DynamoDB is not a loopback endpoint.')
}

/** Resolves the authenticated operator identity stored with the completion audit.
 *
 * @param endpoint - Configured DynamoDB endpoint, if any.
 * @returns The explicit operator identity or a local-only sentinel.
 */
function resolveOperatorId(endpoint: string | undefined) {
  const configured = readEnvironment('MUKUROJI_BACKFILL_OPERATOR_ID')
  if (configured) return requireText(configured, 'MUKUROJI_BACKFILL_OPERATOR_ID')
  if (endpoint !== undefined && isLocalEndpoint(endpoint)) return 'local:backfill'
  throw new Error('MUKUROJI_BACKFILL_OPERATOR_ID is required in AWS environments.')
}

/** Resolves one table name while allowing defaults only for local DynamoDB.
 *
 * @param value - Explicit environment value.
 * @param variableName - Required variable name used in the error message.
 * @param fallback - Local-only fallback table name.
 * @returns The selected table name.
 */
function resolveTableName(value: string | undefined, variableName: string, fallback: string | undefined) {
  if (value) return value
  if (fallback) return fallback
  throw new Error(`${variableName} is required.`)
}

/** Returns whether an endpoint targets a loopback host.
 *
 * @param endpoint - Endpoint URL to inspect.
 * @returns Whether local table defaults are safe to use.
 */
function isLocalEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  } catch {
    return false
  }
}

/** Loads a checkpoint and rejects it when it belongs to another environment.
 *
 * @param path - JSON checkpoint path.
 * @param configurationHash - Digest of the current migration configuration.
 * @returns Existing compatible state, or a fresh initial state.
 */
async function readCheckpoint(path: string, configurationHash: string): Promise<CheckpointState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isCheckpointState(parsed)) {
      throw new Error('Checkpoint schema is invalid.')
    }
    if (parsed.configurationHash !== configurationHash) {
      throw new Error('Checkpoint configuration does not match this environment.')
    }
    return parsed
  } catch (error) {
    if (isNamedError(error) && error.code === 'ENOENT') {
      return {
        version: checkpointVersion,
        configurationHash,
        updatedAt: new Date().toISOString(),
        completed: false,
        scanned: 0,
        backfilled: 0,
        workspaceIds: [],
      }
    }
    throw error
  }
}

/** Scans the legacy table, replays canonical rows, and publishes completion markers.
 *
 * @param sourceClient - Document client used to read the legacy event table.
 * @param collaboration - Canonical Collaboration writer.
 * @param sourceTableName - Legacy event table name.
 * @param checkpoint - Mutable resumable scan state.
 * @param options - Validated run options.
 */
async function runBackfill(
  sourceClient: DynamoDBDocumentClient,
  collaboration: DynamoDbCollaborationClient,
  auditEvents: DynamoDbAuditEventsClient,
  sourceTableName: string,
  checkpoint: CheckpointState,
  options: BackfillOptions,
  runContext: BackfillRunContext,
) {
  let processedThisRun = 0
  const workspaceIds = new Set([...checkpoint.workspaceIds, ...options.workspaceIds])

  while (!checkpoint.completed && (options.limit === undefined || processedThisRun < options.limit)) {
    const remaining = options.limit === undefined ? scanPageSize : Math.max(1, options.limit - processedThisRun)
    const filterExpressions = ['eventType = :eventType']
    const expressionAttributeValues: Record<string, string> = { ':eventType': 'commented' }
    if (options.workspaceIds.length > 0) {
      const workspacePlaceholders = options.workspaceIds.map((workspaceId, index) => {
        const placeholder = `:workspaceId${index}`
        expressionAttributeValues[placeholder] = workspaceId
        return placeholder
      })
      filterExpressions.push(`directoryId IN (${workspacePlaceholders.join(', ')})`)
    }
    const response = await sourceClient.send(new ScanCommand({
      TableName: sourceTableName,
      FilterExpression: filterExpressions.join(' AND '),
      ExpressionAttributeValues: expressionAttributeValues,
      ConsistentRead: true,
      ExclusiveStartKey: checkpoint.lastEvaluatedKey,
      Limit: Math.min(scanPageSize, remaining),
    }))
    const items = response.Items ?? []
    for (const item of items) {
      const legacy = readLegacyCommentEvent(item)
      processedThisRun += 1
      checkpoint.scanned += 1
      workspaceIds.add(legacy.workspaceId)
      if (!options.dryRun) {
        await collaboration.backfillTeamIssueComment({
          workspaceId: legacy.workspaceId,
          teamId: legacy.teamId,
          issueId: legacy.issueId,
          entityKey: createWorkItemCollaborationEntityKey(
            legacy.workspaceId,
            legacy.teamId,
            legacy.issueId,
          ),
          commentId: legacy.eventId,
          actorMemberKey: legacy.actorUserId,
          bodyMarkdown: legacy.body,
          occurredAt: legacy.createdAt,
        })
        checkpoint.backfilled += 1
      }
    }

    checkpoint.lastEvaluatedKey = response.LastEvaluatedKey
    checkpoint.workspaceIds = [...workspaceIds].sort()
    checkpoint.updatedAt = new Date().toISOString()
    if (!response.LastEvaluatedKey) {
      checkpoint.completed = true
    }
    if (!options.dryRun) {
      await writeCheckpoint(options.checkpointPath, checkpoint)
    }
    if (items.length === 0 && response.LastEvaluatedKey) {
      continue
    }
  }

  if (checkpoint.completed && !options.dryRun) {
    for (const workspaceId of workspaceIds) {
      await collaboration.markTeamIssueCommentBackfillComplete(workspaceId)
    }
    await writeBackfillAuditEvents(auditEvents, workspaceIds, checkpoint, options, runContext)
  }
}

/** Writes one suppressed operational audit receipt per affected workspace.
 *
 * @param auditEvents - Audit event writer.
 * @param workspaceIds - Workspaces selected or observed by the scan.
 * @param checkpoint - Cumulative migration counters and completion state.
 * @param options - Scope filter used by the invocation.
 * @param runContext - Authenticated operator and environment binding.
 */
async function writeBackfillAuditEvents(
  auditEvents: DynamoDbAuditEventsClient,
  workspaceIds: Set<string>,
  checkpoint: CheckpointState,
  options: BackfillOptions,
  runContext: BackfillRunContext,
) {
  const occurredAt = new Date().toISOString()
  const retentionDays = getConfiguredAuditRetentionDays()
  const scope = options.workspaceIds.length > 0 ? 'explicit-workspaces' : 'all-workspaces'
  const requestedWorkspaceIds = options.workspaceIds.length > 0 ? options.workspaceIds : ['*']

  for (const workspaceId of [...workspaceIds].sort()) {
    const context = createMutationAuditContext({
      workspaceId,
      actor: {
        id: 'system:backfill',
        kind: 'system',
        displayName: 'system:backfill',
      },
      idempotencyKey: `team-issue-comment-backfill-v1:${runContext.correlationId}:${workspaceId}`,
      request: {
        method: 'BACKFILL',
        path: '/backfills/team-issue-comments/v1',
        query: { workspaceId, scope },
        body: {
          version: 1,
          configurationHash: runContext.configurationHash,
          requestedWorkspaceIds,
        },
      },
      source: {
        kind: 'backfill',
        method: 'BACKFILL',
        requestId: runContext.correlationId,
        route: '/backfills/team-issue-comments/v1',
      },
      correlationId: `${runContext.correlationId}:${workspaceId}`,
      occurredAt,
    })
    const event = createAuditEvent({
      context,
      eventType: 'collaboration.comment-backfill.completed',
      entity: { type: 'migration', id: 'team-issue-comments/v1' },
      action: 'backfilled',
      changes: createAuditFieldChanges(
        undefined,
        {
          sourceRowsScanned: checkpoint.scanned,
          canonicalRowsBackfilled: checkpoint.backfilled,
          completed: checkpoint.completed,
        },
        ['sourceRowsScanned', 'canonicalRowsBackfilled', 'completed'],
      ),
      summary: 'Completed Team Issue comment canonical backfill.',
      metadata: {
        migration: 'team-issue-comments-v1',
        operatorId: runContext.operatorId,
        scope,
        requestedWorkspaceIds,
        configurationHash: runContext.configurationHash,
      },
      expiresAt: calculateAuditExpiresAt(occurredAt, retentionDays),
      outboxStatus: 'suppressed',
    })
    await auditEvents.putEvent(event)
  }
}

/** Validates and projects one raw legacy comment event.
 *
 * @param value - Untrusted DynamoDB source item.
 * @returns A validated legacy comment event.
 */
function readLegacyCommentEvent(value: unknown): LegacyCommentEvent {
  if (!isRecord(value) || value.eventType !== 'commented') {
    throw new Error('Legacy comment event has an invalid event type.')
  }
  const workspaceId = requireTextValue(value.directoryId, 'directoryId')
  const teamId = requireTextValue(value.teamId, 'teamId')
  const issueId = requireTextValue(value.issueId, 'issueId')
  const directoryTeamIssueId = requireTextValue(value.directoryTeamIssueId, 'directoryTeamIssueId')
  const expectedDirectoryTeamIssueId = `${workspaceId}#team#${teamId}#issue#${issueId}`
  if (directoryTeamIssueId !== expectedDirectoryTeamIssueId) {
    throw new Error('Legacy comment event scope does not match its partition key.')
  }
  const createdAt = requireTextValue(value.createdAt, 'createdAt')
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Legacy comment event timestamp is invalid.')
  }
  return {
    workspaceId,
    teamId,
    issueId,
    eventId: requireTextValue(value.eventId, 'eventId'),
    actorUserId: requireTextValue(value.actorUserId, 'actorUserId'),
    body: requireTextValue(value.body, 'body'),
    createdAt,
  }
}

/** Requires a non-empty string from an untrusted source row.
 *
 * @param value - Untrusted value.
 * @param label - Source field name used in the error message.
 * @returns A trimmed non-empty string.
 */
function requireTextValue(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Legacy comment ${label} is invalid.`)
  }
  return value.trim()
}

/** Requires a non-empty CLI or environment string.
 *
 * @param value - Candidate string.
 * @param label - Value label used in the error message.
 * @returns A trimmed non-empty string.
 */
function requireText(value: string, label: string) {
  if (!value.trim()) {
    throw new Error(`${label} requires a non-empty value.`)
  }
  return value.trim()
}

/** Atomically writes a private checkpoint file.
 *
 * @param path - Destination checkpoint path.
 * @param checkpoint - State to persist.
 */
async function writeCheckpoint(path: string, checkpoint: CheckpointState) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporaryPath, path)
}

/** Prints the cumulative migration counters after one invocation.
 *
 * @param checkpoint - Current cumulative state.
 * @param options - Run options used for the summary.
 */
function printSummary(checkpoint: CheckpointState, options: BackfillOptions) {
  console.info(
    `Team Issue comment backfill ${checkpoint.completed ? 'complete' : 'paused'}: ` +
      `scanned=${checkpoint.scanned} backfilled=${checkpoint.backfilled} ` +
      `workspaces=${checkpoint.workspaceIds.length} dryRun=${options.dryRun}`,
  )
}

/** Creates a stable configuration digest for checkpoint binding.
 *
 * @param value - Canonical configuration JSON.
 * @returns Hexadecimal SHA-256 digest.
 */
function createDigest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Validates the persisted checkpoint schema without trusting its contents.
 *
 * @param value - Parsed JSON value.
 * @returns Whether the value is a supported checkpoint.
 */
function isCheckpointState(value: unknown): value is CheckpointState {
  return isRecord(value) &&
    value.version === checkpointVersion &&
    typeof value.configurationHash === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.completed === 'boolean' &&
    (value.lastEvaluatedKey === undefined || isDynamoKey(value.lastEvaluatedKey)) &&
    typeof value.scanned === 'number' &&
    Number.isSafeInteger(value.scanned) &&
    value.scanned >= 0 &&
    typeof value.backfilled === 'number' &&
    Number.isSafeInteger(value.backfilled) &&
    value.backfilled >= 0 &&
    Array.isArray(value.workspaceIds) &&
    value.workspaceIds.every((workspaceId): workspaceId is string =>
      typeof workspaceId === 'string' && workspaceId.length > 0,
    )
}

/** Validates the scalar-only key shape accepted by the DocumentClient.
 *
 * @param value - Untrusted checkpoint key.
 * @returns Whether the value can be used as an ExclusiveStartKey.
 */
function isDynamoKey(value: unknown): value is DynamoKey {
  return isRecord(value) && Object.values(value).every((entry) =>
    typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || entry === null,
  )
}

/** Narrows an unknown value to a plain record.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrows an unknown thrown value to an optional-code error shape.
 *
 * @param value - Unknown thrown value.
 * @returns Whether the value has a string or absent code field.
 */
function isNamedError(value: unknown): value is NamedError {
  return isRecord(value) && (value.code === undefined || typeof value.code === 'string')
}

/** Reads one process environment variable without exposing the whole environment.
 *
 * @param name - Environment variable name.
 * @returns The configured value, when present.
 */
function readEnvironment(name: string) {
  return process.env[name]
}

if (import.meta.main) {
  await main()
}
