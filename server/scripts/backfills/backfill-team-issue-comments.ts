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
  createWorkspaceSearchWriterDynamoDbDocumentClient,
} from '../../src/infrastructure/aws/dynamodb-client'
import {
  loadServerConfig,
  readServerEnvironment,
} from '../../src/infrastructure/config/server-config'
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
import { createTeamIssueCommentEventOrder } from '../../src/modules/work-items'
import {
  createCommentWorkspaceSearchDocument,
  createCommentWorkspaceSearchEntityId,
  ensureLocalWorkspaceSearchTable,
  type WorkspaceSearchClient,
} from '../../src/modules/workspace-search'
import { DynamoDbWorkspaceSearchClient } from '../../src/modules/workspace-search/workspace-search'
import {
  runWithWorkspaceSearchWriterFenceInvocation,
} from '../../src/infrastructure/runtime/workspace-search-writer-fence-invocation'
import {
  ScanCommand,
  UpdateCommand,
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
  /** Number of rows reconciled because their canonical parent was deleted. */
  reconciledDeletedParents?: number
  /** Number of current canonical comments projected into Workspace Search. */
  searchProjected?: number
  /** Number of stale or deleted comment Search documents removed. */
  searchDeleted?: number
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
  /** Number of rows reconciled because their canonical parent was deleted. */
  reconciledDeletedParents?: number
  /** Number of current canonical comments projected into Workspace Search. */
  searchProjected?: number
  /** Number of stale or deleted comment Search documents removed. */
  searchDeleted?: number
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
  /** Workspace Search table used for canonical comment projections. */
  workspaceSearch: string
}

/** Minimal canonical snapshot reader used to build a current Search projection. */
type BackfillCommentSnapshotReader = Pick<DynamoDbCollaborationClient, 'getCommentSnapshot'>

/** Minimal Search writer used by the resumable comment migration. */
type BackfillSearchProjectionClient = Pick<
  WorkspaceSearchClient,
  'upsertDocument' | 'deleteDocument'
> & Pick<
  DynamoDbWorkspaceSearchClient,
  'upsertDocumentWithCommentSourceFence' | 'deleteDocumentWithResult'
>

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
  const serverConfig = loadServerConfig({
    ...readServerEnvironment(),
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    DYNAMODB_ENDPOINT: endpoint,
    AWS_ENDPOINT_URL_DYNAMODB: undefined,
    AWS_ENDPOINT_URL: undefined,
  }, { localBun: false })
  const dynamoDbClient = createDynamoDbClient(serverConfig)
  const sourceClient = createDynamoDbDocumentClient(dynamoDbClient)
  const writerDocumentClient = createWorkspaceSearchWriterDynamoDbDocumentClient(
    dynamoDbClient,
    serverConfig,
  )
  const localDynamoDb = endpoint !== undefined && isLocalDynamoDbEndpoint(endpoint)
  if (!options.dryRun && localDynamoDb) {
    await ensureLocalWorkspaceSearchTable(tables.workspaceSearch, dynamoDbClient)
  }
  const auditEvents = new DynamoDbAuditEventsClient(
    sourceClient,
    tables.auditEvents,
    undefined,
    dynamoDbClient,
    localDynamoDb,
  )
  const collaboration = new DynamoDbCollaborationClient(
    tables.target,
    tables.workItems,
    undefined,
    writerDocumentClient,
    dynamoDbClient,
    undefined,
    tables.source,
  )
  const workspaceSearch = options.dryRun
    ? undefined
    : new DynamoDbWorkspaceSearchClient(
        tables.workspaceSearch,
        writerDocumentClient,
        dynamoDbClient,
        false,
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
    workspaceSearch,
    auditEvents,
    tables.source,
    tables.target,
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
export function parseArguments(args: string[]): BackfillOptions {
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
      const workspaceId = requireText(value, '--workspace-id')
      if (workspaceId === TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES) {
        throw new Error('--workspace-id cannot use the reserved all-workspaces marker.')
      }
      options.workspaceIds.push(workspaceId)
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
  TEAM_ISSUE_EVENTS_TABLE_NAME, COLLABORATION_TABLE_NAME, WORK_ITEMS_TABLE_NAME,
  AUDIT_EVENTS_TABLE_NAME, WORKSPACE_SEARCH_TABLE_NAME

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
      readEnvironment('WORK_ITEMS_TABLE_NAME'),
      'WORK_ITEMS_TABLE_NAME',
      allowLocalDefaults ? 'mukuroji-team-issues-local' : undefined,
    ),
    auditEvents: resolveTableName(
      readEnvironment('MUKUROJI_AUDIT_EVENTS_TABLE') ?? readEnvironment('AUDIT_EVENTS_TABLE_NAME'),
      'AUDIT_EVENTS_TABLE_NAME',
      allowLocalDefaults ? 'mukuroji-audit-events' : undefined,
    ),
    workspaceSearch: resolveTableName(
      readEnvironment('MUKUROJI_WORKSPACE_SEARCH_TABLE') ??
        readEnvironment('WORKSPACE_SEARCH_TABLE_NAME'),
      'WORKSPACE_SEARCH_TABLE_NAME',
      allowLocalDefaults ? 'mukuroji-workspace-search-local' : undefined,
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
        reconciledDeletedParents: 0,
        searchProjected: 0,
        searchDeleted: 0,
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
 * @param workspaceSearch - Canonical Workspace Search projection writer.
 * @param auditEvents - Operational audit event writer.
 * @param sourceTableName - Legacy event table name.
 * @param targetTableName - Collaboration table containing canonical comments.
 * @param checkpoint - Mutable resumable scan state.
 * @param options - Validated run options.
 */
async function runBackfill(
  sourceClient: DynamoDBDocumentClient,
  collaboration: DynamoDbCollaborationClient,
  workspaceSearch: BackfillSearchProjectionClient | undefined,
  auditEvents: DynamoDbAuditEventsClient,
  sourceTableName: string,
  targetTableName: string,
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
      workspaceCounts.set(workspaceId, {
        scanned: 0,
        backfilled: 0,
        reconciledDeletedParents: 0,
        searchProjected: 0,
        searchDeleted: 0,
      })
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
      // Count every filtered source row before validation so malformed rows
      // cannot make a bounded dry-run scan past its requested limit.
      processedThisRun += 1
      if (options.workspaceIds.length > 0) {
        const rawWorkspaceId = readLegacyWorkspaceId(item)
        if (rawWorkspaceId !== undefined && !options.workspaceIds.includes(rawWorkspaceId)) {
          continue
        }
      }
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
      const input = createBackfillInput(legacy)
      let outcome: 'validated' | 'projected' | 'unchanged' | 'deleted' | 'deleted-parent' | undefined
      try {
        if (options.dryRun) {
          const validation = await collaboration.validateBackfillTeamIssueComment(input)
          outcome = validation === 'parent-deleted' ? 'deleted-parent' : 'validated'
        } else {
          if (!workspaceSearch) {
            throw new Error('Workspace Search projection is unavailable for a write run.')
          }
          await normalizeLegacyCommentIndex(sourceClient, sourceTableName, legacy)
          try {
            await collaboration.backfillTeamIssueCommentWithResult(input)
            const projection = await projectBackfilledComment(
              workspaceSearch,
              collaboration,
              legacy,
              targetTableName,
            )
            outcome = projection
          } catch (error) {
            if (!isDeletedParentBackfillError(error)) throw error
            await collaboration.reconcileDeletedBackfillTeamIssueComment(input)
            await workspaceSearch.deleteDocumentWithResult(
              legacy.workspaceId,
              'comment',
              createCommentWorkspaceSearchEntityId(legacy.teamId, legacy.issueId, legacy.eventId),
            )
            outcome = 'deleted-parent'
          }
        }
      } catch (error) {
        if (!options.dryRun) throw error
        validationFailures.push(`event ${legacy.eventId}: ${readErrorMessage(error)}`)
      }
      if (outcome === undefined) continue

      workspaceIds.add(legacy.workspaceId)
      const counts = workspaceCounts.get(legacy.workspaceId) ?? {
        scanned: 0,
        backfilled: 0,
        searchProjected: 0,
        searchDeleted: 0,
      }
      checkpoint.scanned += 1
      counts.scanned += 1
      if (options.dryRun) {
        if (outcome === 'deleted-parent') {
          counts.reconciledDeletedParents = (counts.reconciledDeletedParents ?? 0) + 1
        }
      } else {
        if (outcome !== 'deleted-parent') {
          checkpoint.backfilled += 1
          counts.backfilled += 1
        }
        if (outcome === 'projected' || outcome === 'unchanged') {
          checkpoint.searchProjected = (checkpoint.searchProjected ?? 0) + 1
          counts.searchProjected = (counts.searchProjected ?? 0) + 1
        } else if (outcome === 'deleted' || outcome === 'deleted-parent') {
          checkpoint.searchDeleted = (checkpoint.searchDeleted ?? 0) + 1
          counts.searchDeleted = (counts.searchDeleted ?? 0) + 1
          if (outcome === 'deleted-parent') {
            checkpoint.reconciledDeletedParents =
              (checkpoint.reconciledDeletedParents ?? 0) + 1
            counts.reconciledDeletedParents = (counts.reconciledDeletedParents ?? 0) + 1
          }
        }
      }
      workspaceCounts.set(legacy.workspaceId, counts)
      if (!options.dryRun) {
        checkpoint.lastEvaluatedKey = createLegacyCommentSourceKey(legacy)
        checkpoint.workspaceIds = [...workspaceIds].sort()
        checkpoint.updatedAt = new Date().toISOString()
        checkpoint.workspaceCounts = Object.fromEntries(
          [...workspaceCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
        )
        await writeCheckpoint(options.checkpointPath, checkpoint)
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
 * Projects a current canonical comment snapshot behind a version fence.
 *
 * @param workspaceSearch - Search projection writer with canonical source fencing.
 * @param collaboration - Strong canonical comment snapshot reader.
 * @param legacy - Validated legacy event identifying the comment.
 * @param sourceTableName - Collaboration table containing the canonical comment.
 * @returns Whether the projection represents a live or deleted comment.
 */
async function projectBackfilledComment(
  workspaceSearch: BackfillSearchProjectionClient,
  collaboration: BackfillCommentSnapshotReader,
  legacy: LegacyCommentEvent,
  sourceTableName: string,
): Promise<'projected' | 'unchanged' | 'deleted'> {
  const entityKey = createWorkItemCollaborationEntityKey(
    legacy.workspaceId,
    legacy.teamId,
    legacy.issueId,
  )
  const entityId = createCommentWorkspaceSearchEntityId(
    legacy.teamId,
    legacy.issueId,
    legacy.eventId,
  )
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const comment = await collaboration.getCommentSnapshot({
      entityKey,
      commentId: legacy.eventId,
    })
    if (!comment || comment.deletedAt) {
      await workspaceSearch.deleteDocumentWithResult(
        legacy.workspaceId,
        'comment',
        entityId,
        comment?.version === undefined ? undefined : { sourceRevision: comment.version },
      )
      return 'deleted'
    }

    const document = createCommentWorkspaceSearchDocument({
      workspaceId: legacy.workspaceId,
      teamId: legacy.teamId,
      issueId: legacy.issueId,
      commentId: comment.id,
      rootCommentId: comment.rootCommentId,
      body: comment.bodyMarkdown,
      creatorUserId: comment.authorMemberKey,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      sourceRevision: comment.version,
    })
    const projection = await workspaceSearch.upsertDocumentWithCommentSourceFence(
      document,
      {
        sourceTableName,
        sourceEntityKey: entityKey,
        sourceCommentId: comment.id,
        sourceRevision: comment.version,
      },
    )
    if (projection === 'projected') return 'projected'
    if (projection === 'unchanged') return 'unchanged'
  }

  throw new Error('Canonical comment changed repeatedly while projecting Workspace Search.')
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

/** Creates the source-table key used to make one successful row checkpoint durable.
 *
 * @param legacy - Validated legacy comment source row.
 * @returns Source table primary key for the row.
 */
function createLegacyCommentSourceKey(legacy: LegacyCommentEvent): DynamoKey {
  return {
    directoryTeamIssueId: `${legacy.workspaceId}#team#${legacy.teamId}#issue#${legacy.issueId}`,
    eventId: legacy.eventId,
  }
}

/** Adds the canonical chronological index key to one immutable legacy comment row.
 *
 * @param sourceClient - Document client for the legacy event table.
 * @param sourceTableName - Legacy event table name.
 * @param legacy - Validated legacy comment source row.
 * @returns Resolves after the source row has been conditionally normalized.
 */
async function normalizeLegacyCommentIndex(
  sourceClient: DynamoDBDocumentClient,
  sourceTableName: string,
  legacy: LegacyCommentEvent,
): Promise<void> {
  await sourceClient.send(new UpdateCommand({
    TableName: sourceTableName,
    Key: {
      directoryTeamIssueId: `${legacy.workspaceId}#team#${legacy.teamId}#issue#${legacy.issueId}`,
      eventId: legacy.eventId,
    },
    UpdateExpression: 'SET commentCreatedAtOrder = :commentCreatedAtOrder',
    ConditionExpression:
      'attribute_exists(directoryTeamIssueId) AND attribute_exists(eventId) ' +
      'AND eventType = :eventType AND createdAt = :createdAt',
    ExpressionAttributeValues: {
      ':commentCreatedAtOrder': createTeamIssueCommentEventOrder(legacy.createdAt, legacy.eventId),
      ':eventType': 'commented',
      ':createdAt': legacy.createdAt,
    },
  }))
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
  const affectedWorkspaceIds = [...workspaceIds].sort()
  const requestedWorkspaceCount = options.workspaceIds.length
  const requestedWorkspaceDigest = createDigest(
    (options.workspaceIds.length > 0 ? options.workspaceIds : ['*']).join('\0'),
  )
  const affectedWorkspaceCount = affectedWorkspaceIds.length
  const affectedWorkspaceDigest = createDigest(affectedWorkspaceIds.join('\0'))
  const auditWorkspaceIds = new Set(workspaceIds)
  if (options.workspaceIds.length === 0) {
    auditWorkspaceIds.add(TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES)
  }

  for (const workspaceId of [...auditWorkspaceIds].sort()) {
    const environmentScope = workspaceId === TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES
    const counts = environmentScope
      ? {
          scanned: checkpoint.scanned,
          backfilled: checkpoint.backfilled,
          reconciledDeletedParents: checkpoint.reconciledDeletedParents ?? 0,
          searchProjected: checkpoint.searchProjected ?? 0,
          searchDeleted: checkpoint.searchDeleted ?? 0,
        }
      : workspaceCounts.get(workspaceId) ?? {
          scanned: 0,
          backfilled: 0,
          reconciledDeletedParents: 0,
          searchProjected: 0,
          searchDeleted: 0,
        }
    const receiptAffectedWorkspaceCount = environmentScope ? affectedWorkspaceCount : 1
    const receiptAffectedWorkspaceDigest = environmentScope
      ? affectedWorkspaceDigest
      : createDigest(workspaceId)
    const reconciledDeletedParents = counts.reconciledDeletedParents ?? 0
    const searchProjected = counts.searchProjected ?? 0
    const searchDeleted = counts.searchDeleted ?? 0
    const context = createMutationAuditContext({
      workspaceId,
      actor: {
        id: `system:backfill:${runContext.operatorId}`,
        kind: 'system',
        displayName: 'system:backfill',
      },
      // The v2 audit key separates the expanded environment-scope payload from
      // receipts written by the earlier workspace-only audit contract.
      idempotencyKey: `team-issue-comment-backfill-v2:${createDigest(
        `${runContext.configurationHash}\0${workspaceId}`,
      )}`,
      request: {
        method: 'BACKFILL',
        path: '/backfills/team-issue-comments/v1',
        query: {
          workspaceId: environmentScope ? '*' : workspaceId,
          scope,
          ...(environmentScope ? { environmentScope: 'all-workspaces' } : {}),
        },
        body: {
          version: 1,
          accountId: runContext.accountId,
          configurationHash: runContext.configurationHash,
          requestedWorkspaceCount,
          requestedWorkspaceDigest,
          affectedWorkspaceCount: receiptAffectedWorkspaceCount,
          affectedWorkspaceDigest: receiptAffectedWorkspaceDigest,
          sourceRowsScanned: counts.scanned,
          canonicalRowsBackfilled: counts.backfilled,
          reconciledDeletedParents,
          searchDocumentsProjected: searchProjected,
          searchDocumentsDeleted: searchDeleted,
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
          reconciledDeletedParents,
          searchDocumentsProjected: searchProjected,
          searchDocumentsDeleted: searchDeleted,
          completed: checkpoint.completed,
        },
        [
          'sourceRowsScanned',
          'canonicalRowsBackfilled',
          'reconciledDeletedParents',
          'searchDocumentsProjected',
          'searchDocumentsDeleted',
          'completed',
        ],
      ),
      summary: 'Completed Team Issue comment canonical backfill.',
      metadata: {
        migration: 'team-issue-comments-v1',
        operatorId: runContext.operatorId,
        ...(runContext.operatorLabel ? { operatorLabel: runContext.operatorLabel } : {}),
        accountId: runContext.accountId,
        scope,
        requestedWorkspaceCount,
        requestedWorkspaceDigest,
        affectedWorkspaceCount: receiptAffectedWorkspaceCount,
        affectedWorkspaceDigest: receiptAffectedWorkspaceDigest,
        sourceRowsScanned: counts.scanned,
        canonicalRowsBackfilled: counts.backfilled,
        reconciledDeletedParents,
        searchDocumentsProjected: searchProjected,
        searchDocumentsDeleted: searchDeleted,
        configurationHash: runContext.configurationHash,
        ...(environmentScope ? { environmentScope: 'all-workspaces' } : {}),
      },
      expiresAt: calculateAuditExpiresAt(occurredAt, retentionDays),
      outboxStatus: 'suppressed',
    })
    await auditEvents.putEvent(event)
  }
}

/**
 * Reads the raw workspace scope needed for an early filtered-scan decision.
 *
 * The partition-key prefix is checked with the redundant directory ID so a
 * malformed scope still falls through to the fail-closed full validator.
 *
 * @param value - Untrusted DynamoDB source item.
 * @returns Established workspace ID, or undefined when scope cannot be trusted.
 */
function readLegacyWorkspaceId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.directoryId !== 'string' ||
      typeof value.directoryTeamIssueId !== 'string') {
    return undefined
  }
  const workspaceId = value.directoryId.trim()
  const directoryTeamIssueId = value.directoryTeamIssueId.trim()
  if (!workspaceId || !directoryTeamIssueId.startsWith(`${workspaceId}#team#`)) {
    return undefined
  }
  return workspaceId
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

/** Detects the explicit parent-deleted result that is safe to reconcile. */
function isDeletedParentBackfillError(error: unknown): boolean {
  return isRecord(error) && error.code === 'CollaborationBackfillParentDeleted'
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
      `reconciledDeletedParents=${checkpoint.reconciledDeletedParents ?? 0} ` +
      `searchProjected=${checkpoint.searchProjected ?? 0} ` +
      `searchDeleted=${checkpoint.searchDeleted ?? 0} ` +
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
    value.backfilled <= value.scanned &&
    (value.reconciledDeletedParents === undefined || (
      typeof value.reconciledDeletedParents === 'number' &&
      Number.isSafeInteger(value.reconciledDeletedParents) &&
      value.reconciledDeletedParents >= 0 &&
      value.reconciledDeletedParents <= value.scanned
    )) &&
    (value.searchProjected === undefined || (
      typeof value.searchProjected === 'number' &&
      Number.isSafeInteger(value.searchProjected) &&
      value.searchProjected >= 0 &&
      value.searchProjected <= value.scanned
    )) &&
    (value.searchDeleted === undefined || (
      typeof value.searchDeleted === 'number' &&
      Number.isSafeInteger(value.searchDeleted) &&
      value.searchDeleted >= 0 &&
      value.searchDeleted <= value.scanned
    )) &&
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
    value.backfilled <= value.scanned &&
    (value.reconciledDeletedParents === undefined || (
      typeof value.reconciledDeletedParents === 'number' &&
      Number.isSafeInteger(value.reconciledDeletedParents) &&
      value.reconciledDeletedParents >= 0 &&
      value.reconciledDeletedParents <= value.scanned
    )) &&
    (value.searchProjected === undefined || (
      typeof value.searchProjected === 'number' &&
      Number.isSafeInteger(value.searchProjected) &&
      value.searchProjected >= 0 &&
      value.searchProjected <= value.scanned
    )) &&
    (value.searchDeleted === undefined || (
      typeof value.searchDeleted === 'number' &&
      Number.isSafeInteger(value.searchDeleted) &&
      value.searchDeleted >= 0 &&
      value.searchDeleted <= value.scanned
    ))
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
