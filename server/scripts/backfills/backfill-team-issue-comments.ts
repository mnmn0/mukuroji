import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  GetCallerIdentityCommand,
  STSClient,
} from '@aws-sdk/client-sts'
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
  TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES,
  createWorkItemCollaborationEntityKey,
} from '../../src/modules/collaboration'
import { DynamoDbCollaborationClient } from '../../src/modules/collaboration/collaboration'
import {
  runWithWorkspaceSearchWriterFenceInvocation,
} from '../../src/infrastructure/runtime/workspace-search-writer-fence-invocation'
import {
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { isLocalDynamoDbEndpoint } from './backfill-endpoint'

const checkpointVersion = 2
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
  version: 2
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
  /** Cumulative source and canonical counts per workspace. */
  workspaceCounts: Record<string, WorkspaceBackfillCounts>
}

/** Cumulative source and canonical counters for one workspace. */
type WorkspaceBackfillCounts = {
  /** Number of matching legacy rows scanned for the workspace. */
  scanned: number
  /** Number of canonical rows written or replayed for the workspace. */
  backfilled: number
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
  /** Authenticated STS caller ARN, or the local-only sentinel, recorded in audit metadata. */
  operatorId: string
  /** Optional operator label supplied by the invocation environment. */
  operatorLabel?: string
  /** AWS account returned by the authenticated STS caller identity. */
  accountId: string
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

/** Authenticated identity used to bind one backfill run to its AWS caller. */
export type BackfillIdentity = {
  /** AWS account returned by STS GetCallerIdentity. */
  accountId: string
  /** Authenticated STS caller ARN, or the local-only sentinel. */
  operatorId: string
  /** Optional operator label supplied by the invocation environment. */
  operatorLabel?: string
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
  const identity = await resolveBackfillIdentity(endpoint, region)
  const configurationHash = createDigest(JSON.stringify({
    endpoint: endpoint ?? 'aws-default',
    region,
    profile: readEnvironment('AWS_PROFILE') ?? 'default-provider-chain',
    account: identity.accountId,
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
    endpoint !== undefined && isLocalDynamoDbEndpoint(endpoint),
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
    operatorId: identity.operatorId,
    ...(identity.operatorLabel ? { operatorLabel: identity.operatorLabel } : {}),
    accountId: identity.accountId,
    correlationId: randomUUID(),
    configurationHash,
  }

  console.info(
    `Team Issue comment backfill started: source=${tables.source} target=${tables.target} ` +
      `dryRun=${options.dryRun} limit=${options.limit ?? 'unlimited'} ` +
      `checkpoint=${options.checkpointPath}`,
  )
  await runWithWorkspaceSearchWriterFenceInvocation(() => runBackfill(
    sourceClient,
    collaboration,
    auditEvents,
    tables.source,
    checkpoint,
    options,
    runContext,
  ))
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
    checkpointPath: resolve(process.cwd(), 'team-issue-comment-backfill-v2.checkpoint.json'),
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
  --checkpoint <path>      Checkpoint JSON path (default: ./team-issue-comment-backfill-v2.checkpoint.json).
  --limit <count>          Maximum matching source rows processed in this run.
  --workspace-id <id>      Restrict the scan and marker publication to this workspace; repeatable.
  --help, -h               Show this help.

Required in AWS environments:
  TEAM_ISSUE_EVENTS_TABLE_NAME, COLLABORATION_TABLE_NAME, TEAM_ISSUES_TABLE_NAME,
  AUDIT_EVENTS_TABLE_NAME

MUKUROJI_BACKFILL_OPERATOR_ID is an optional operator label. In AWS, the audit
operator identity is always taken from the authenticated STS caller ARN. Local
runs use the local:backfill audit sentinel.

AWS_ACCOUNT_ID is optional and, when supplied, is checked against the account
returned by STS GetCallerIdentity. The checkpoint and audit principal use the
verified account rather than this optional expectation.

The per-workspace marker is written only after the source Scan reaches its end.
An unfiltered run also writes an environment-wide marker so workspaces with no
legacy comments can switch to canonical-only reads. A repeated run is safe
because comment, provenance, and discussion rows use the legacy event ID and
conditional writes.`)
}

/** Resolves source, target, and parent table names for one migration run.
 *
 * @param endpoint - Configured DynamoDB endpoint, if any.
 * @returns Validated table names.
 */
function resolveTableNames(endpoint: string | undefined): TableNames {
  const allowLocalDefaults = endpoint !== undefined && isLocalDynamoDbEndpoint(endpoint)
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

/** Resolves the authenticated account and operator identity for one backfill run.
 *
 * @param endpoint - Configured DynamoDB endpoint, if any.
 * @param region - AWS region used for the STS identity lookup.
 * @returns The authenticated account, caller ARN or local sentinel, and optional operator label.
 */
export async function resolveBackfillIdentity(
  endpoint: string | undefined,
  region: string,
): Promise<BackfillIdentity> {
  const configured = readEnvironment('AWS_ACCOUNT_ID')
  const operatorLabel = readEnvironment('MUKUROJI_BACKFILL_OPERATOR_ID')
  if (endpoint !== undefined && isLocalDynamoDbEndpoint(endpoint)) {
    return {
      accountId: configured ? requireAwsAccountId(configured) : 'local-account',
      operatorId: 'local:backfill',
      ...(operatorLabel
        ? { operatorLabel: requireText(operatorLabel, 'MUKUROJI_BACKFILL_OPERATOR_ID') }
        : {}),
    }
  }

  const sts = new STSClient({ region })
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}))
    const accountId = requireAwsAccountId(identity.Account)
    if (configured && requireAwsAccountId(configured) !== accountId) {
      throw new Error('AWS_ACCOUNT_ID does not match the authenticated AWS account.')
    }
    const operatorId = requireText(identity.Arn ?? '', 'STS caller ARN')
    return {
      accountId,
      operatorId,
      ...(operatorLabel
        ? { operatorLabel: requireText(operatorLabel, 'MUKUROJI_BACKFILL_OPERATOR_ID') }
        : {}),
    }
  } finally {
    sts.destroy()
  }
}

/** Resolves only the authenticated account for callers that need the account binding.
 *
 * @param endpoint - Configured DynamoDB endpoint, if any.
 * @param region - AWS region used for the STS identity lookup.
 * @returns The authenticated AWS account or a local-only sentinel.
 */
export async function resolveAccountId(endpoint: string | undefined, region: string) {
  return (await resolveBackfillIdentity(endpoint, region)).accountId
}

/** Validates an AWS account identifier obtained from configuration or STS. */
function requireAwsAccountId(value: string | undefined) {
  if (value === undefined || !/^\d{12}$/.test(value)) {
    throw new Error('AWS account identity must be a 12-digit account ID.')
  }
  return value
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
        workspaceCounts: {},
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
  const validationFailures: string[] = []
  const workspaceIds = new Set([...checkpoint.workspaceIds, ...options.workspaceIds])
  const workspaceCounts = new Map<string, WorkspaceBackfillCounts>(
    Object.entries(checkpoint.workspaceCounts).map(([workspaceId, counts]) => [
      workspaceId,
      { ...counts },
    ]),
  )
  for (const workspaceId of options.workspaceIds) {
    if (!workspaceCounts.has(workspaceId)) {
      workspaceCounts.set(workspaceId, { scanned: 0, backfilled: 0 })
    }
  }

  while (!checkpoint.completed && (options.limit === undefined || processedThisRun < options.limit)) {
    const remaining = options.limit === undefined ? scanPageSize : Math.max(1, options.limit - processedThisRun)
    const response = await sourceClient.send(new ScanCommand({
      TableName: sourceTableName,
      FilterExpression: 'eventType = :eventType',
      ExpressionAttributeValues: { ':eventType': 'commented' },
      ConsistentRead: true,
      ExclusiveStartKey: checkpoint.lastEvaluatedKey,
      Limit: Math.min(scanPageSize, remaining),
    }))
    const items = response.Items ?? []
    for (const item of items) {
      let legacy: LegacyCommentEvent
      try {
        legacy = readLegacyCommentEvent(item)
      } catch (error) {
        if (!options.dryRun) throw error
        validationFailures.push(readErrorMessage(error))
        continue
      }
      if (options.workspaceIds.length > 0 && !options.workspaceIds.includes(legacy.workspaceId)) {
        continue
      }
      processedThisRun += 1
      checkpoint.scanned += 1
      workspaceIds.add(legacy.workspaceId)
      const counts = workspaceCounts.get(legacy.workspaceId) ?? { scanned: 0, backfilled: 0 }
      counts.scanned += 1
      workspaceCounts.set(legacy.workspaceId, counts)
      const input = createBackfillInput(legacy)
      try {
        if (options.dryRun) {
          await collaboration.validateBackfillTeamIssueComment(input)
        } else {
          await collaboration.backfillTeamIssueComment(input)
          checkpoint.backfilled += 1
          counts.backfilled += 1
        }
      } catch (error) {
        if (!options.dryRun) throw error
        validationFailures.push(`event ${legacy.eventId}: ${readErrorMessage(error)}`)
      }
    }

    checkpoint.lastEvaluatedKey = response.LastEvaluatedKey
    checkpoint.workspaceIds = [...workspaceIds].sort()
    checkpoint.updatedAt = new Date().toISOString()
    if (!response.LastEvaluatedKey) {
      checkpoint.completed = true
    }
    checkpoint.workspaceCounts = Object.fromEntries(
      [...workspaceCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    )
    if (!options.dryRun) {
      await writeCheckpoint(options.checkpointPath, checkpoint)
    }
    if (items.length === 0 && response.LastEvaluatedKey) {
      continue
    }
  }

  if (checkpoint.completed && !options.dryRun) {
    // Persist the audit receipt first. If marker publication fails, the receipt
    // makes the incomplete marker state observable and the retry remains idempotent.
    await writeBackfillAuditEvents(
      auditEvents,
      workspaceIds,
      workspaceCounts,
      checkpoint,
      options,
      runContext,
    )
    for (const workspaceId of workspaceIds) {
      await collaboration.markTeamIssueCommentBackfillComplete(workspaceId)
    }
    if (options.workspaceIds.length === 0) {
      await collaboration.markTeamIssueCommentBackfillComplete(
        TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES,
      )
    }
  }

  if (options.dryRun && validationFailures.length > 0) {
    const preview = validationFailures.slice(0, 20).join('\n')
    throw new Error(
      `Dry-run found ${validationFailures.length} invalid legacy comment row(s).\n${preview}`,
    )
  }
}

/**
 * Builds the canonical backfill input from one validated legacy event.
 *
 * @param legacy - Validated source event.
 * @returns Canonical collaboration backfill input.
 */
function createBackfillInput(legacy: LegacyCommentEvent) {
  return {
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
  }
}

/** Writes one suppressed operational audit receipt per affected workspace.
 *
 * @param auditEvents - Audit event writer.
 * @param workspaceIds - Workspaces selected or observed by the scan.
 * @param workspaceCounts - Cumulative counters keyed by workspace.
 * @param checkpoint - Cumulative migration counters and completion state.
 * @param options - Scope filter used by the invocation.
 * @param runContext - Authenticated operator and environment binding.
 */
async function writeBackfillAuditEvents(
  auditEvents: DynamoDbAuditEventsClient,
  workspaceIds: Set<string>,
  workspaceCounts: Map<string, WorkspaceBackfillCounts>,
  checkpoint: CheckpointState,
  options: BackfillOptions,
  runContext: BackfillRunContext,
) {
  const occurredAt = new Date().toISOString()
  const retentionDays = getConfiguredAuditRetentionDays()
  const scope = options.workspaceIds.length > 0 ? 'explicit-workspaces' : 'all-workspaces'
  const requestedWorkspaceIds = options.workspaceIds.length > 0 ? options.workspaceIds : ['*']

  for (const workspaceId of [...workspaceIds].sort()) {
    const counts = workspaceCounts.get(workspaceId) ?? { scanned: 0, backfilled: 0 }
    const context = createMutationAuditContext({
      workspaceId,
      actor: {
        id: `system:backfill:${runContext.operatorId}`,
        kind: 'system',
        displayName: 'system:backfill',
      },
      idempotencyKey: `team-issue-comment-backfill-v1:${createDigest(
        `${runContext.configurationHash}\0${workspaceId}`,
      )}`,
      request: {
        method: 'BACKFILL',
        path: '/backfills/team-issue-comments/v1',
        query: { workspaceId, scope },
        body: {
          version: 1,
          accountId: runContext.accountId,
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
          sourceRowsScanned: counts.scanned,
          canonicalRowsBackfilled: counts.backfilled,
          completed: checkpoint.completed,
        },
        ['sourceRowsScanned', 'canonicalRowsBackfilled', 'completed'],
      ),
      summary: 'Completed Team Issue comment canonical backfill.',
      metadata: {
        migration: 'team-issue-comments-v1',
        operatorId: runContext.operatorId,
        ...(runContext.operatorLabel ? { operatorLabel: runContext.operatorLabel } : {}),
        accountId: runContext.accountId,
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

/**
 * Converts an unknown validation failure into a concise dry-run diagnostic.
 *
 * @param error - Failure raised while validating one source row.
 * @returns Human-readable failure message.
 */
function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown validation failure.'
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
    ) &&
    isRecord(value.workspaceCounts) &&
    Object.entries(value.workspaceCounts).every(([workspaceId, counts]) =>
      workspaceId.length > 0 && isWorkspaceBackfillCounts(counts),
    )
}

/** Validates one persisted workspace counter pair. */
function isWorkspaceBackfillCounts(value: unknown): value is WorkspaceBackfillCounts {
  return isRecord(value) &&
    typeof value.scanned === 'number' &&
    Number.isSafeInteger(value.scanned) &&
    value.scanned >= 0 &&
    typeof value.backfilled === 'number' &&
    Number.isSafeInteger(value.backfilled) &&
    value.backfilled >= 0 &&
    value.backfilled <= value.scanned
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
  try {
    await main()
  } catch (error) {
    console.error(
      `Team Issue comment backfill failed: ${readErrorMessage(error)}`,
    )
    process.exitCode = 1
  }
}
