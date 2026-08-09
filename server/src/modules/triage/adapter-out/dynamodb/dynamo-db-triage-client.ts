import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  TRIAGE_BULK_ACTION_LIMIT,
  TRIAGE_CONFIGURATION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type CreateManualTriageEntryInput,
  type TriageActionInput,
  type TriageBulkActionInput,
  type TriageBulkActionResult,
  type TriageBulkOperation,
  type TriageBulkTarget,
  type TriageConfiguration,
  type TriageEntry,
  type TriageEntryListInput,
  type TriageEntryPage,
  type TriageMutationReceipt,
  type TriageOwnerRotation,
  type TriageOwnerStrategy,
  type TriagePermission,
  type TriageRoutingRule,
  type TriageSlaPolicy,
  type TriageSourceKind,
  type TriageWorkItemSourcePage,
  type UpdateTriageConfigurationInput,
} from '@mukuroji/contracts'
import { getConfiguredDynamoDbEndpoint } from '../../../audit'
import {
  createTriageCapabilities,
  evaluateTriageAdmission,
  projectTriageEntryForResponse,
  TriageError,
  type TriageSourceActivity,
} from '../../domain/triage-entry'
import {
  createTriageBulkTargetIdempotencyKey,
  createTriageInputFingerprint,
} from '../../triage'
import type {
  ResolveTriageWorkItemAction,
  TriageActor,
  TriageClient,
  TriageIdempotency,
} from '../../triage'
import {
  createTriageAcceptanceTransactionItems,
  createTriageActionTransactionItems,
  createTriageEntryKey,
  createTriageEntryTransactionItems,
  createTriageOperationReceiptTransactionPut,
  createTriageReceiptKey,
  createTriageSourceActivityTransactionItems,
  createTriageSourceClaimKey,
  createTriageWorkItemSourcePrefix,
  createWorkspaceScopeKey,
  decodeTriageEntryRow,
  DEFAULT_TRIAGE_WAKE_SHARD_COUNT,
  type TriageTransactionContribution,
  type TriageTransactionItems,
} from './triage-transactions'

/** Default Team activity GSI name. */
export const TRIAGE_TEAM_ACTIVITY_INDEX_NAME = 'triage-team-activity-index'

/** Default optional owner activity GSI name. */
export const TRIAGE_OWNER_ACTIVITY_INDEX_NAME = 'triage-owner-activity-index'

/** Maximum number of GSI pages inspected to fill one filtered queue page. */
const TRIAGE_QUEUE_QUERY_PAGE_LIMIT = 20

/** DynamoDB adapter construction options. */
export type DynamoDbTriageClientOptions = {
  /** Request Intake table name. */
  tableName?: string
  /** Required Team activity GSI name. */
  teamIndexName?: string
  /** Optional owner activity GSI name. */
  ownerIndexName?: string
  /** Caller-owned DocumentClient. */
  documentClient?: DynamoDBDocumentClient
  /** Low-level client used when no DocumentClient is supplied. */
  dynamoDbClient?: DynamoDBClient
  /** Number of deterministic sparse wake partitions. */
  wakeShardCount?: number
  /** Secret authenticating scope-bound pagination cursors. */
  cursorSecret?: string
  /** Work Item orchestration callback for accept and duplicate actions. */
  resolveWorkItemAction?: ResolveTriageWorkItemAction
  /** Live Project/member validation applied to every admission evaluation attempt. */
  validateAdmission?: TriageAdmissionValidator
  /** Test-replaceable clock. */
  now?: () => Date
  /** Test-replaceable entry ID generator. */
  id?: () => string
}

/** Admission contribution composed into a source-owned transaction. */
export type TriageAdmissionTransactionContribution = {
  /** Entry after current Team routing and service configuration is applied. */
  entry: TriageEntry
  /** Optional conditional configuration writes owned by Triage. */
  transactItems: TriageTransactionItems
  /** Relative item index whose conditional race may be retried with a fresh configuration. */
  retryableConflictItemIndex?: number
}

/** Validates the final entry references derived from one current configuration snapshot.
 *
 * @param entry Entry after routing, ownership, SLA, and retention evaluation.
 * @param configuration Configuration snapshot used for that evaluation.
 * @returns Completion after every live reference has been validated.
 */
export type TriageAdmissionValidator = (
  entry: TriageEntry,
  configuration: TriageConfiguration,
) => Promise<void>

/** A source claim returned after a uniqueness conflict. */
type StoredTriageSourceClaim = {
  /** Owning Workspace ID. */
  workspaceId: string
  /** Existing canonical entry ID. */
  entryId: string
  /** Fingerprint of the immutable initial payload. */
  inputFingerprint: string
}

/** A decoded replay receipt. */
type StoredTriageReceipt = {
  /** Workspace owning the original operation. */
  workspaceId: string
  /** Fingerprint of the original semantic input. */
  inputFingerprint: string
  /** Canonical entry affected by the original operation. */
  entryId: string
  /** Entry revision committed by the original operation. */
  resultRevision: number
}

/** A decoded replay receipt for one Team configuration replacement. */
type StoredTriageConfigurationReceipt = {
  /** Workspace owning the original settings mutation. */
  workspaceId: string
  /** Team whose settings were replaced. */
  teamId: string
  /** Fingerprint of the original semantic settings input. */
  inputFingerprint: string
  /** Exact configuration snapshot committed with the receipt. */
  configuration: TriageConfiguration
}

/** Signed pagination payload. */
type TriageCursorPayload = {
  /** Scope fingerprint binding Workspace, Team, filters, and index. */
  scope: string
  /** Index or primary-query identity. */
  index: string
  /** DynamoDB ExclusiveStartKey. */
  key: Record<string, unknown>
}

/** Queue query execution result used to retry with the Team index. */
type QueueQueryResult = {
  /** Strongly read and filtered entries. */
  entries: TriageEntry[]
  /** Last evaluated DynamoDB key. */
  lastEvaluatedKey?: Record<string, unknown>
}

/** DynamoDB-backed triage application client using the Request Intake table. */
export class DynamoDbTriageClient implements TriageClient {
  /** Request Intake table name. */
  private readonly tableName: string

  /** Required Team activity GSI name. */
  private readonly teamIndexName: string

  /** Optional owner activity GSI name. */
  private readonly ownerIndexName: string

  /** Request Intake DocumentClient. */
  private readonly documentClient: DynamoDBDocumentClient

  /** Number of deterministic sparse wake partitions. */
  private readonly wakeShardCount: number

  /** HMAC secret for scope-bound pagination cursors. */
  private readonly cursorSecret: string

  /** Optional Work Item action resolver supplied by composition. */
  private readonly resolveWorkItemAction?: ResolveTriageWorkItemAction

  /** Optional live reference validator invoked for every admission attempt. */
  private readonly validateAdmission?: TriageAdmissionValidator

  /** Test-replaceable clock. */
  private readonly now: () => Date

  /** Test-replaceable ID generator. */
  private readonly id: () => string

  /** Runtime observation of whether the optional owner GSI is usable. */
  private ownerIndexAvailable: boolean | undefined

  /** Creates a DynamoDB triage client.
   *
   * @param options Persistence, orchestration, and deterministic test options.
   */
  constructor(options: DynamoDbTriageClientOptions = {}) {
    const endpoint = getConfiguredDynamoDbEndpoint()
    const dynamoDbClient = options.dynamoDbClient ?? new DynamoDBClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
            },
          }
        : {}),
    })
    this.documentClient = options.documentClient ?? DynamoDBDocumentClient.from(dynamoDbClient, {
      marshallOptions: { removeUndefinedValues: true },
    })
    this.tableName = requireText(
      options.tableName ?? readEnvironment('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
      'Request Intake table name',
      1_000,
    )
    this.teamIndexName = requireText(
      options.teamIndexName ?? readEnvironment('TRIAGE_TEAM_ACTIVITY_INDEX_NAME') ??
        TRIAGE_TEAM_ACTIVITY_INDEX_NAME,
      'Triage Team index name',
      255,
    )
    this.ownerIndexName = requireText(
      options.ownerIndexName ?? readEnvironment('TRIAGE_OWNER_ACTIVITY_INDEX_NAME') ??
        TRIAGE_OWNER_ACTIVITY_INDEX_NAME,
      'Triage owner index name',
      255,
    )
    this.wakeShardCount = requirePositiveInteger(
      options.wakeShardCount ?? Number(readEnvironment('TRIAGE_WAKE_SHARD_COUNT') ??
        DEFAULT_TRIAGE_WAKE_SHARD_COUNT),
      'Triage wake shard count',
      128,
    )
    this.cursorSecret = requireText(
      options.cursorSecret ?? readEnvironment('TRIAGE_CURSOR_SECRET') ??
        readEnvironment('REQUEST_TOKEN_HASH_SECRET') ?? 'local-triage-cursor-secret',
      'Triage cursor secret',
      4_096,
    )
    this.resolveWorkItemAction = options.resolveWorkItemAction
    this.validateAdmission = options.validateAdmission
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? (() => `triage_${randomUUID().replaceAll('-', '')}`)
  }

  /** Lists a Team queue through sparse activity indexes.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The Team queue ID.
   * @param input Validated filters, limit, and opaque cursor.
   * @returns A permission-projectable page and the current safe bulk-action policy.
   */
  async listEntries(
    workspaceId: string,
    teamId: string,
    input: TriageEntryListInput = {},
  ): Promise<TriageEntryPage> {
    requireWorkspaceId(workspaceId)
    requireIdentifier(teamId, 'Team ID')
    const limit = requirePositiveInteger(input.limit ?? 50, 'Triage queue limit', 100)
    const owner = input.ownerUserId === 'unowned' ? 'UNOWNED' : input.ownerUserId
    const preferOwnerIndex = owner !== undefined && this.ownerIndexAvailable !== false
    const configuration = await this.getConfiguration(workspaceId, teamId)

    try {
      const result = await this.queryQueue(
        workspaceId,
        teamId,
        input,
        limit,
        preferOwnerIndex ? 'owner' : 'team',
        owner,
      )
      if (preferOwnerIndex) this.ownerIndexAvailable = true
      return {
        allowedBulkActions: [...configuration.allowedBulkActions],
        entries: result.entries,
        ...(result.lastEvaluatedKey
          ? {
              nextCursor: this.encodeCursor(createQueueCursorScope(
                workspaceId,
                teamId,
                input,
                preferOwnerIndex ? 'owner' : 'team',
              ), preferOwnerIndex ? this.ownerIndexName : this.teamIndexName, result.lastEvaluatedKey),
            }
          : {}),
      }
    } catch (error) {
      if (!preferOwnerIndex || input.cursor || !isUnavailableIndexError(error)) throw error
      this.ownerIndexAvailable = false
      const result = await this.queryQueue(workspaceId, teamId, input, limit, 'team', owner)
      return {
        allowedBulkActions: [...configuration.allowedBulkActions],
        entries: result.entries,
        ...(result.lastEvaluatedKey
          ? {
              nextCursor: this.encodeCursor(
                createQueueCursorScope(workspaceId, teamId, input, 'team'),
                this.teamIndexName,
                result.lastEvaluatedKey,
              ),
            }
          : {}),
      }
    }
  }

  /** Strongly reads one Team entry.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param entryId The entry ID.
   * @returns The permission-safe canonical entry projection.
   */
  async getEntry(workspaceId: string, teamId: string, entryId: string): Promise<TriageEntry> {
    return projectTriageEntryForResponse(
      await this.getEntryForMutation(workspaceId, teamId, entryId),
    )
  }

  /** Strongly reads the canonical stored entry for trusted application composition.
   *
   * This method must never be returned directly from an HTTP adapter; callers must apply
   * `projectTriageEntryForResponse` before exposing the result.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param entryId The entry ID.
   * @returns The canonical stored entry used to build conditional transactions.
   */
  async getEntryForMutation(
    workspaceId: string,
    teamId: string,
    entryId: string,
  ): Promise<TriageEntry> {
    const entry = await this.readStoredEntry(workspaceId, entryId)
    if (entry.teamId !== teamId) {
      throw new TriageError(404, 'TriageEntryNotFound', 'The triage entry was not found.')
    }
    return entry
  }

  /** Looks up an existing fingerprint-bound action receipt.
   *
   * @param workspaceId The owning Workspace ID.
   * @param entryId The entry whose action may have committed.
   * @param idempotency The original key and semantic fingerprint.
   * @returns The current permission-safe result, or undefined before the first commit.
   */
  async getActionReceipt(
    workspaceId: string,
    entryId: string,
    idempotency: TriageIdempotency,
  ): Promise<TriageMutationReceipt | undefined> {
    return await this.readReceipt(workspaceId, entryId, 'action', idempotency)
  }

  /** Strongly reads one canonical stored entry without applying a response projection. */
  private async readStoredEntry(workspaceId: string, entryId: string): Promise<TriageEntry> {
    const key = createTriageEntryKey(workspaceId, entryId)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true,
    }))
    if (response.Item === undefined) {
      throw new TriageError(404, 'TriageEntryNotFound', 'The triage entry was not found.')
    }
    const entry = decodeTriageEntryRow(response.Item, key)
    if (!entry) {
      throw new TriageError(
        500,
        'InvalidTriageEntry',
        'The stored triage entry is invalid.',
      )
    }
    return entry
  }

  /** Applies one replay-safe action.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param entryId The target entry ID.
   * @param actor The authenticated actor.
   * @param action The validated revision-fenced transition.
   * @param idempotency Replay protection bound to the normalized action.
   * @returns The committed or replayed permission-safe receipt.
   */
  async applyAction(
    workspaceId: string,
    teamId: string,
    entryId: string,
    actor: TriageActor,
    action: TriageActionInput,
    idempotency: TriageIdempotency,
  ): Promise<TriageMutationReceipt> {
    const replay = await this.readReceipt(workspaceId, entryId, 'action', idempotency)
    if (replay) return replay
    const entry = await this.getEntryForMutation(workspaceId, teamId, entryId)
    const contribution = await this.createActionContribution(workspaceId, entry, actor, action, idempotency)
    if (contribution.transactItems.length > 100) {
      throw new TriageError(409, 'TriageTransactionTooLarge', 'The triage action is too large.')
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: contribution.transactItems,
      }))
      return { entry: projectTriageEntryForResponse(contribution.entry), replayed: false }
    } catch (error) {
      if (!isConditionalConflict(error)) throw error
      const concurrentReplay = await this.readReceipt(workspaceId, entryId, 'action', idempotency)
      if (concurrentReplay) return concurrentReplay
      throw new TriageError(409, 'TriageRevisionConflict', 'The triage entry changed.', {
        cause: error,
      })
    }
  }

  /** Applies a bounded bulk operation with independent conditional results.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param actor The authenticated actor.
   * @param input The targets, revisions, and allowed operation.
   * @param idempotencyKey The caller-selected key for the whole request.
   * @returns One independently classified result for each target.
   */
  async applyBulkAction(
    workspaceId: string,
    teamId: string,
    actor: TriageActor,
    input: TriageBulkActionInput,
    idempotencyKey: string,
  ): Promise<TriageBulkActionResult> {
    if (input.targets.length < 1 || input.targets.length > TRIAGE_BULK_ACTION_LIMIT) {
      throw new TriageError(400, 'InvalidTriageBulkAction', 'The bulk target count is invalid.')
    }
    const configuration = await this.getConfiguration(workspaceId, teamId)
    if (!configuration.allowedBulkActions.includes(input.operation.action)) {
      throw new TriageError(
        409,
        'TriageBulkActionDisabled',
        'This bulk action is disabled by the current Team Triage configuration.',
      )
    }
    const bulkIdempotencyKey = requireText(idempotencyKey, 'Bulk idempotency key', 160)
    const results: TriageBulkActionResult['results'] = []
    for (const target of input.targets) {
      const action = createBulkAction(target, input.operation)
      const idempotency = {
        key: createTriageBulkTargetIdempotencyKey(bulkIdempotencyKey, target.entryId),
        fingerprint: createTriageInputFingerprint({ target, operation: input.operation }),
      }
      try {
        const receipt = await this.applyAction(
          workspaceId,
          teamId,
          target.entryId,
          actor,
          action,
          idempotency,
        )
        results.push({ entryId: target.entryId, status: 'succeeded', entry: receipt.entry })
      } catch (error) {
        if (error instanceof TriageError && error.status === 409) {
          results.push({ entryId: target.entryId, status: 'conflict', errorCode: error.code })
        } else {
          results.push({
            entryId: target.entryId,
            status: 'failed',
            errorCode: error instanceof TriageError ? error.code : 'TriageBulkTargetFailed',
          })
        }
      }
    }
    return { results }
  }

  /** Reads Team settings or returns an explicit unpersisted revision-zero default.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The configured Team ID.
   * @returns Deeply validated stored settings or safe defaults for an absent row.
   */
  async getConfiguration(workspaceId: string, teamId: string): Promise<TriageConfiguration> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createConfigurationKey(workspaceId, teamId),
      ConsistentRead: true,
    }))
    const stored = decodeConfigurationRow(response.Item, workspaceId, teamId)
    return stored ?? createDefaultConfiguration(workspaceId, teamId, this.now().toISOString())
  }

  /** Applies current Team configuration before a source transaction creates an entry.
   *
   * @param entry The normalized source entry owned by the caller's transaction.
   * @returns The configured entry and optional conditional rotation cursor write.
   */
  async prepareEntryAdmission(
    entry: TriageEntry,
  ): Promise<TriageAdmissionTransactionContribution> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createConfigurationKey(entry.workspaceId, entry.teamId),
      ConsistentRead: true,
    }))
    const storedConfiguration = decodeConfigurationRow(
      response.Item,
      entry.workspaceId,
      entry.teamId,
    )
    const configuration = storedConfiguration ??
      createDefaultConfiguration(entry.workspaceId, entry.teamId, entry.createdAt)
    const evaluation = evaluateTriageAdmission(configuration, entry, entry.createdAt)
    await this.validateAdmission?.(evaluation.entry, configuration)
    if (!evaluation.rotationReservation) {
      return {
        entry: evaluation.entry,
        transactItems: [createConfigurationSnapshotCondition(
          this.tableName,
          entry.workspaceId,
          entry.teamId,
          storedConfiguration,
        )],
        retryableConflictItemIndex: 0,
      }
    }
    const reservation = evaluation.rotationReservation
    return {
      entry: evaluation.entry,
      transactItems: [{
        Put: {
          TableName: this.tableName,
          Item: {
            entryType: 'triage-configuration',
            ...createConfigurationKey(entry.workspaceId, entry.teamId),
            configuration: reservation.configuration,
            revision: reservation.configuration.revision,
            updatedBy: 'system:triage-admission',
          },
          ConditionExpression:
            '#revision = :expectedRevision AND ' +
            `#configuration.#rotations[${reservation.rotationIndex}].#nextIndex = :expectedNextIndex`,
          ExpressionAttributeNames: {
            '#configuration': 'configuration',
            '#nextIndex': 'nextIndex',
            '#revision': 'revision',
            '#rotations': 'rotations',
          },
          ExpressionAttributeValues: {
            ':expectedRevision': reservation.expectedRevision,
            ':expectedNextIndex': reservation.expectedNextIndex,
          },
        },
      }],
      retryableConflictItemIndex: 0,
    }
  }

  /** Reads the exact settings snapshot committed for an idempotency key.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The configured Team ID.
   * @param idempotency Replay protection bound to the settings replacement.
   * @returns The committed snapshot, or undefined when the key has not been used.
   */
  async getConfigurationUpdateReceipt(
    workspaceId: string,
    teamId: string,
    idempotency: TriageIdempotency,
  ): Promise<TriageConfiguration | undefined> {
    validateConfigurationIdempotency(idempotency)
    return await this.readConfigurationReceipt(workspaceId, teamId, idempotency)
  }

  /** Replaces or replays Team settings with revision concurrency.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The configured Team ID.
   * @param actor The authenticated settings manager.
   * @param input The validated replacement configuration.
   * @param idempotency Replay protection bound to the settings replacement.
   * @returns The newly committed or exactly replayed configuration.
   */
  async updateConfiguration(
    workspaceId: string,
    teamId: string,
    actor: TriageActor,
    input: UpdateTriageConfigurationInput,
    idempotency: TriageIdempotency,
  ): Promise<TriageConfiguration> {
    validateConfigurationInput(teamId, input)
    validateConfigurationIdempotency(idempotency)
    const replay = await this.readConfigurationReceipt(
      workspaceId,
      teamId,
      idempotency,
    )
    if (replay) return replay
    const currentResponse = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createConfigurationKey(workspaceId, teamId),
      ConsistentRead: true,
    }))
    const current = decodeConfigurationRow(currentResponse.Item, workspaceId, teamId)
    const currentRevision = current?.revision ?? 0
    if (currentRevision !== input.expectedRevision) {
      throw new TriageError(409, 'TriageConfigurationConflict', 'Triage settings changed.')
    }
    const now = this.now().toISOString()
    const next: TriageConfiguration = {
      schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
      workspaceId,
      teamId,
      rules: input.rules,
      rotations: input.rotations,
      slaPolicies: input.slaPolicies,
      allowedBulkActions: input.allowedBulkActions,
      retentionDays: input.retentionDays,
      revision: currentRevision + 1,
      updatedAt: now,
    }
    const condition = current
      ? { expression: 'revision = :expectedRevision', values: { ':expectedRevision': currentRevision } }
      : {
          expression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          values: undefined,
        }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                entryType: 'triage-configuration',
                ...createConfigurationKey(workspaceId, teamId),
                configuration: next,
                revision: next.revision,
                updatedBy: requireUserId(actor.id, 'Triage actor ID'),
              },
              ConditionExpression: condition.expression,
              ...(condition.values ? { ExpressionAttributeValues: condition.values } : {}),
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                entryType: 'triage-configuration-receipt',
                ...createConfigurationReceiptKey(workspaceId, teamId, idempotency.key),
                workspaceId,
                teamId,
                inputFingerprint: idempotency.fingerprint,
                configuration: next,
                createdAt: now,
                expiresAt: Math.floor(Date.parse(addDays(now, 90)) / 1_000),
              },
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      return next
    } catch (error) {
      if (isConditionalConflict(error)) {
        const concurrentReplay = await this.readConfigurationReceipt(
          workspaceId,
          teamId,
          idempotency,
        )
        if (concurrentReplay) return concurrentReplay
        throw new TriageError(409, 'TriageConfigurationConflict', 'Triage settings changed.', {
          cause: error,
        })
      }
      throw error
    }
  }

  /** Reads and validates one Team configuration update receipt.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The configured Team ID.
   * @param idempotency Replay protection bound to the settings replacement.
   * @returns The committed snapshot, or undefined when the receipt does not exist.
   */
  private async readConfigurationReceipt(
    workspaceId: string,
    teamId: string,
    idempotency: TriageIdempotency,
  ): Promise<TriageConfiguration | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createConfigurationReceiptKey(workspaceId, teamId, idempotency.key),
      ConsistentRead: true,
    }))
    const stored = decodeConfigurationReceipt(response.Item)
    if (!stored) {
      if (response.Item !== undefined) {
        throw new TriageError(
          500,
          'InvalidTriageReceipt',
          'The Triage configuration receipt is invalid.',
        )
      }
      return undefined
    }
    if (stored.inputFingerprint !== idempotency.fingerprint) {
      throw new TriageError(
        409,
        'TriageIdempotencyConflict',
        'The idempotency key was already used with different input.',
      )
    }
    if (stored.workspaceId !== workspaceId || stored.teamId !== teamId) {
      throw new TriageError(
        500,
        'InvalidTriageReceipt',
        'The Triage configuration receipt scope is invalid.',
      )
    }
    return stored.configuration
  }

  /** Creates or replays a source-unique manual handoff.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The receiving Team ID.
   * @param actor The authenticated internal actor.
   * @param input The normalized handoff source and server-derived routing snapshot.
   * @param idempotency Replay protection bound to the original semantic handoff.
   * @returns The newly committed or replayed permission-safe entry receipt.
   */
  async createManualHandoff(
    workspaceId: string,
    teamId: string,
    actor: TriageActor,
    input: CreateManualTriageEntryInput,
    idempotency: TriageIdempotency,
  ): Promise<TriageMutationReceipt> {
    const existing = await this.readSourceClaim(workspaceId, 'manual-handoff', input.sourceId)
    if (existing) return this.replaySourceClaim(existing, idempotency.fingerprint, teamId)
    const now = this.now().toISOString()
    const baseEntry = createManualEntry(workspaceId, teamId, actor, input, this.id(), now)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const admission = await this.prepareEntryAdmission(baseEntry)
      const entry = admission.entry
      requireSamePreparedManualProject(input, entry)
      const transactItems = createTriageEntryTransactionItems({
        tableName: this.tableName,
        entry,
        inputFingerprint: idempotency.fingerprint,
        wakeShardCount: this.wakeShardCount,
      })
      transactItems.push(createTriageOperationReceiptTransactionPut({
        tableName: this.tableName,
        entry,
        operation: 'manual-handoff',
        idempotency,
        expiresAt: addDays(now, 90),
      }))
      const retryableConflictItemIndex = admission.retryableConflictItemIndex === undefined
        ? undefined
        : transactItems.length + admission.retryableConflictItemIndex
      transactItems.push(...admission.transactItems)
      try {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
        return { entry: projectTriageEntryForResponse(entry), replayed: false }
      } catch (error) {
        if (
          retryableConflictItemIndex !== undefined &&
          isOnlyConditionalConflictAt(error, retryableConflictItemIndex)
        ) {
          if (attempt < 2) continue
          throw new TriageError(
            409,
            'TriageConfigurationConflict',
            'Triage settings changed while the handoff was created.',
            { cause: error },
          )
        }
        if (!isConditionalConflict(error)) throw error
        const concurrent = await this.readSourceClaim(workspaceId, 'manual-handoff', input.sourceId)
        if (concurrent) return this.replaySourceClaim(concurrent, idempotency.fingerprint, teamId)
        throw new TriageError(409, 'TriageSourceConflict', 'The triage source already exists.', {
          cause: error,
        })
      }
    }
    throw new TriageError(409, 'TriageConfigurationConflict', 'Triage settings changed.')
  }

  /** Lists reverse source associations under the Workspace partition.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The canonical Work Item Team ID.
   * @param workItemId The canonical Work Item ID.
   * @param limitValue Maximum number of associations to read.
   * @param cursor Opaque scope-bound continuation cursor.
   * @returns A bounded page of current permission-safe source entries.
   */
  async listWorkItemSources(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    limitValue = 50,
    cursor?: string,
  ): Promise<TriageWorkItemSourcePage> {
    const limit = requirePositiveInteger(limitValue, 'Triage source page limit', 100)
    const prefix = createTriageWorkItemSourcePrefix(teamId, workItemId)
    const scope = createTriageInputFingerprint({ workspaceId, teamId, workItemId, type: 'sources' })
    const exclusiveStartKey = cursor
      ? this.decodeCursor(cursor, scope, 'primary').key
      : undefined
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: {
        ':scopeKey': createWorkspaceScopeKey(workspaceId),
        ':prefix': prefix,
      },
      Limit: limit,
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))
    const entries: TriageEntry[] = []
    for (const item of response.Items ?? []) {
      const entryId = readAssociationEntryId(item)
      if (!entryId) continue
      entries.push(await this.getEntry(workspaceId, teamId, entryId))
    }
    return {
      entries,
      ...(response.LastEvaluatedKey
        ? { nextCursor: this.encodeCursor(scope, 'primary', response.LastEvaluatedKey) }
        : {}),
    }
  }

  /** Records source activity through a replay-safe resurface transaction.
   *
   * @param workspaceId The owning Workspace ID.
   * @param teamId The expected Team ID.
   * @param entryId The target entry ID.
   * @param activity The normalized provider activity.
   * @param idempotency Replay protection bound to the provider event.
   * @returns The updated or replayed entry receipt.
   */
  async recordSourceActivity(
    workspaceId: string,
    teamId: string,
    entryId: string,
    activity: TriageSourceActivity,
    idempotency: TriageIdempotency,
  ): Promise<TriageMutationReceipt> {
    const replay = await this.readReceipt(workspaceId, entryId, 'activity', idempotency)
    if (replay) return replay
    const current = await this.getEntryForMutation(workspaceId, teamId, entryId)
    const contribution = createTriageSourceActivityTransactionItems({
      tableName: this.tableName,
      entry: current,
      activity,
      idempotency,
      wakeShardCount: this.wakeShardCount,
    })
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: contribution.transactItems,
      }))
      return { entry: projectTriageEntryForResponse(contribution.entry), replayed: false }
    } catch (error) {
      if (!isConditionalConflict(error)) throw error
      const concurrent = await this.readReceipt(workspaceId, entryId, 'activity', idempotency)
      if (concurrent) return concurrent
      throw new TriageError(409, 'TriageRevisionConflict', 'The triage entry changed.', {
        cause: error,
      })
    }
  }

  /** Builds an action contribution after optional Work Item resolution. */
  private async createActionContribution(
    workspaceId: string,
    entry: TriageEntry,
    actor: TriageActor,
    action: TriageActionInput,
    idempotency: TriageIdempotency,
  ): Promise<TriageTransactionContribution> {
    const now = this.now().toISOString()
    if (action.action === 'accept' || action.action === 'duplicate') {
      if (!this.resolveWorkItemAction) {
        throw new TriageError(
          409,
          'TriageWorkItemOrchestrationRequired',
          'Work Item orchestration is required for this action.',
        )
      }
      const resolution = await this.resolveWorkItemAction(workspaceId, entry, actor, action, now)
      const triage = createTriageAcceptanceTransactionItems({
        tableName: this.tableName,
        entry,
        action,
        canonicalWorkItem: resolution.canonicalWorkItem,
        actorId: actor.id,
        now,
        idempotency,
        ...(resolution.mergeReceipt ? { mergeReceipt: resolution.mergeReceipt } : {}),
        wakeShardCount: this.wakeShardCount,
      })
      return {
        entry: triage.entry,
        transactItems: [...(resolution.transactItems ?? []), ...triage.transactItems],
      }
    }
    return createTriageActionTransactionItems({
      tableName: this.tableName,
      entry,
      action,
      actorId: actor.id,
      now,
      idempotency,
      wakeShardCount: this.wakeShardCount,
    })
  }

  /** Queries an index and strongly reads matching base rows. */
  private async queryQueue(
    workspaceId: string,
    teamId: string,
    input: TriageEntryListInput,
    limit: number,
    indexKind: 'team' | 'owner',
    ownerUserId: string | undefined,
  ): Promise<QueueQueryResult> {
    const indexName = indexKind === 'owner' ? this.ownerIndexName : this.teamIndexName
    const partitionAttribute = indexKind === 'owner' ? 'triageOwnerKey' : 'triageTeamKey'
    const partitionValue = indexKind === 'owner'
      ? `WORKSPACE#${workspaceId}#TEAM#${teamId}#OWNER#${ownerUserId}`
      : `WORKSPACE#${workspaceId}#TEAM#${teamId}`
    const scope = createQueueCursorScope(workspaceId, teamId, input, indexKind)
    let exclusiveStartKey = input.cursor
      ? this.decodeCursor(input.cursor, scope, indexName).key
      : undefined
    let pages = 0
    const entries: TriageEntry[] = []

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: indexName,
        KeyConditionExpression: `${partitionAttribute} = :partitionKey`,
        ExpressionAttributeValues: { ':partitionKey': partitionValue },
        Limit: Math.max(1, limit - entries.length),
        ScanIndexForward: false,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      pages += 1
      exclusiveStartKey = response.LastEvaluatedKey
      for (const item of response.Items ?? []) {
        const key = readPrimaryKey(item)
        if (!key) {
          throw new TriageError(
            500,
            'InvalidTriageIndexRow',
            'The triage queue index contains an invalid row.',
          )
        }
        const read = await this.documentClient.send(new GetCommand({
          TableName: this.tableName,
          Key: key,
          ConsistentRead: true,
        }))
        if (read.Item === undefined) continue
        const entry = decodeTriageEntryRow(read.Item, key)
        if (!entry) {
          throw new TriageError(
            500,
            'InvalidTriageEntry',
            'The stored triage entry is invalid.',
          )
        }
        if (entry.workspaceId !== workspaceId || entry.teamId !== teamId) {
          throw new TriageError(
            500,
            'InvalidTriageEntry',
            'The stored triage entry is outside the requested queue scope.',
          )
        }
        if (!matchesQueueFilter(entry, workspaceId, teamId, input, ownerUserId)) continue
        entries.push(projectTriageEntryForResponse(entry))
      }
    } while (
      entries.length < limit &&
      exclusiveStartKey !== undefined &&
      pages < TRIAGE_QUEUE_QUERY_PAGE_LIMIT
    )

    return {
      entries,
      ...(exclusiveStartKey ? { lastEvaluatedKey: exclusiveStartKey } : {}),
    }
  }

  /** Reads and validates an operation receipt. */
  private async readReceipt(
    workspaceId: string,
    entryId: string,
    operation: string,
    idempotency: TriageIdempotency,
  ): Promise<TriageMutationReceipt | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createTriageReceiptKey(workspaceId, entryId, operation, idempotency.key),
      ConsistentRead: true,
    }))
    const stored = decodeReceipt(response.Item)
    if (!stored) return undefined
    if (stored.inputFingerprint !== idempotency.fingerprint) {
      throw new TriageError(
        409,
        'TriageIdempotencyConflict',
        'The idempotency key was already used with different input.',
      )
    }
    if (stored.workspaceId !== workspaceId || stored.entryId !== entryId) {
      throw new TriageError(500, 'InvalidTriageReceipt', 'The triage receipt scope is invalid.')
    }
    const entry = await this.readStoredEntry(workspaceId, stored.entryId)
    if (entry.revision < stored.resultRevision) {
      throw new TriageError(
        500,
        'InvalidTriageReceipt',
        'The triage receipt references an unavailable entry revision.',
      )
    }
    return { entry: projectTriageEntryForResponse(entry), replayed: true }
  }

  /** Reads a unique source claim. */
  private async readSourceClaim(
    workspaceId: string,
    sourceKind: TriageEntry['source']['kind'],
    sourceId: string,
  ): Promise<StoredTriageSourceClaim | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: createTriageSourceClaimKey(workspaceId, sourceKind, sourceId),
      ConsistentRead: true,
    }))
    return decodeSourceClaim(response.Item)
  }

  /** Replays a source claim after verifying its payload fingerprint. */
  private async replaySourceClaim(
    claim: StoredTriageSourceClaim,
    inputFingerprint: string,
    teamId: string,
  ): Promise<TriageMutationReceipt> {
    if (claim.inputFingerprint !== inputFingerprint) {
      throw new TriageError(
        409,
        'TriageSourceConflict',
        'The source identifier was already used with different input.',
      )
    }
    return {
      entry: await this.getEntry(claim.workspaceId, teamId, claim.entryId),
      replayed: true,
    }
  }

  /** Encodes and authenticates a scope-bound cursor. */
  private encodeCursor(
    scope: string,
    index: string,
    key: Record<string, unknown>,
  ): string {
    const payload = Buffer.from(JSON.stringify({ scope, index, key })).toString('base64url')
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  /** Decodes and authenticates a scope-bound cursor. */
  private decodeCursor(cursor: string, scope: string, index: string): TriageCursorPayload {
    const [payload, signature, extra] = cursor.split('.')
    if (!payload || !signature || extra !== undefined) throw invalidCursor()
    const expected = createHmac('sha256', this.cursorSecret).update(payload).digest()
    let received: Buffer
    try {
      received = Buffer.from(signature, 'base64url')
    } catch (error) {
      throw new TriageError(400, 'InvalidTriageCursor', 'The triage cursor is invalid.', {
        cause: error,
      })
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw invalidCursor()
    }
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch (error) {
      throw new TriageError(400, 'InvalidTriageCursor', 'The triage cursor is invalid.', {
        cause: error,
      })
    }
    if (!isRecord(value) || value.scope !== scope || value.index !== index || !isRecord(value.key)) {
      throw invalidCursor()
    }
    return { scope: value.scope, index: value.index, key: value.key }
  }
}

/** Creates an initial manual handoff entry. */
function createManualEntry(
  workspaceId: string,
  teamId: string,
  actor: TriageActor,
  input: CreateManualTriageEntryInput,
  entryId: string,
  now: string,
): TriageEntry {
  const permission: TriagePermission = {
    visibility: 'full',
    canReply: false,
    guestVisible: false,
    checkedAt: now,
  }
  const entry: TriageEntry = {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: requireIdentifier(entryId, 'Triage entry ID'),
    workspaceId: requireWorkspaceId(workspaceId),
    source: { kind: 'manual-handoff', sourceId: requireText(input.sourceId, 'Source ID', 500) },
    sourcePreview: {
      title: requireText(input.title, 'Manual handoff title', 500),
      body: requireText(input.body, 'Manual handoff body', 8_000, true),
      attachmentCount: 0,
      commentCount: 0,
      watcherCount: 0,
      sanitized: true,
      truncated: false,
    },
    requester: {
      displayName: requireText(input.requesterDisplayName, 'Requester display name', 300),
      ...(input.requesterEmail
        ? { email: requireEmail(input.requesterEmail) }
        : {}),
      guest: false,
    },
    receivedAt: now,
    lastActivityAt: now,
    state: 'pending',
    routing: {
      reason: requireText(input.routingReason, 'Routing reason', 2_000),
      candidates: [{
        teamId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        reason: input.routingReason,
        permitted: true,
      }],
    },
    teamId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.ownerUserId ? { ownerUserId: requireUserId(input.ownerUserId, 'Owner user ID') } : {}),
    permission,
    ...(input.slaPolicyId && input.slaDueAt
      ? {
          sla: {
            policyId: input.slaPolicyId,
            dueAt: requireIsoInstant(input.slaDueAt, 'SLA due time'),
            ...(input.escalationDueAt
              ? { escalationDueAt: requireIsoInstant(input.escalationDueAt, 'Escalation due time') }
              : {}),
          },
        }
      : {}),
    retention: { expiresAt: requireIsoInstant(input.retentionExpiresAt, 'Retention deadline') },
    capabilities: createTriageCapabilities({ state: 'pending', permission }),
    events: [{
      id: `created:1:${now}`,
      type: 'created',
      actorId: requireUserId(actor.id, 'Triage actor ID'),
      summary: 'A manual handoff entered triage.',
      createdAt: now,
    }],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  return entry
}

/** Creates one operator action from a bulk operation and target revision. */
function createBulkAction(
  target: TriageBulkTarget,
  operation: TriageBulkOperation,
): TriageActionInput {
  if (operation.action === 'assign') {
    return {
      action: 'assign',
      expectedRevision: target.expectedRevision,
      ownerUserId: operation.ownerUserId,
      ...(operation.projectId === undefined ? {} : { projectId: operation.projectId }),
    }
  }
  if (operation.action === 'decline') {
    return {
      action: 'decline',
      expectedRevision: target.expectedRevision,
      reason: operation.reason,
    }
  }
  return {
    action: 'snooze',
    expectedRevision: target.expectedRevision,
    until: operation.until,
  }
}

/** Returns whether an entry matches post-read queue filters. */
function matchesQueueFilter(
  entry: TriageEntry,
  workspaceId: string,
  teamId: string,
  input: TriageEntryListInput,
  ownerUserId: string | undefined,
): boolean {
  if (entry.workspaceId !== workspaceId || entry.teamId !== teamId) return false
  if (input.state && entry.state !== input.state) return false
  if (input.sourceKind && entry.source.kind !== input.sourceKind) return false
  if (ownerUserId === 'UNOWNED' && entry.ownerUserId !== undefined) return false
  if (ownerUserId && ownerUserId !== 'UNOWNED' && entry.ownerUserId !== ownerUserId) return false
  return true
}

/** Creates a filter- and index-bound queue cursor scope. */
function createQueueCursorScope(
  workspaceId: string,
  teamId: string,
  input: TriageEntryListInput,
  indexKind: 'team' | 'owner',
): string {
  return createTriageInputFingerprint({
    workspaceId,
    teamId,
    indexKind,
    state: input.state,
    sourceKind: input.sourceKind,
    ownerUserId: input.ownerUserId,
  })
}

/** Creates a Team configuration primary key. */
function createConfigurationKey(
  workspaceId: string,
  teamId: string,
): { scopeKey: string; recordKey: string } {
  return {
    scopeKey: createWorkspaceScopeKey(workspaceId),
    recordKey: `TRIAGE_CONFIG#TEAM#${requireIdentifier(teamId, 'Team ID')}`,
  }
}

/** Creates the digest-based receipt key for one Team configuration replacement.
 *
 * @param workspaceId The owning Workspace ID.
 * @param teamId The configured Team ID.
 * @param idempotencyKey The caller-selected settings operation key.
 * @returns A bounded DynamoDB receipt primary key.
 */
function createConfigurationReceiptKey(
  workspaceId: string,
  teamId: string,
  idempotencyKey: string,
): { scopeKey: string; recordKey: 'RECEIPT' } {
  return createTriageReceiptKey(
    workspaceId,
    teamId,
    'configuration-update',
    idempotencyKey,
  )
}

/** Creates a transaction guard for one evaluated configuration snapshot.
 *
 * @param tableName Request Intake table containing Team configuration.
 * @param workspaceId Owning Workspace identifier.
 * @param teamId Configured Team identifier.
 * @param storedConfiguration Persisted snapshot, or undefined for a revision-zero default.
 * @returns A revision or non-existence condition for the source transaction.
 */
function createConfigurationSnapshotCondition(
  tableName: string,
  workspaceId: string,
  teamId: string,
  storedConfiguration: TriageConfiguration | undefined,
): TriageTransactionItems[number] {
  const key = createConfigurationKey(workspaceId, teamId)
  return storedConfiguration
    ? {
        ConditionCheck: {
          TableName: tableName,
          Key: key,
          ConditionExpression: '#configuration.#revision = :expectedRevision',
          ExpressionAttributeNames: {
            '#configuration': 'configuration',
            '#revision': 'revision',
          },
          ExpressionAttributeValues: {
            ':expectedRevision': storedConfiguration.revision,
          },
        },
      }
    : {
        ConditionCheck: {
          TableName: tableName,
          Key: key,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      }
}

/** Creates safe defaults before a Team has persisted settings. */
function createDefaultConfiguration(
  workspaceId: string,
  teamId: string,
  now: string,
): TriageConfiguration {
  return {
    schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
    workspaceId,
    teamId,
    rules: [],
    rotations: [],
    slaPolicies: [],
    allowedBulkActions: ['assign', 'decline', 'snooze'],
    retentionDays: 365,
    revision: 0,
    updatedAt: now,
  }
}

/** Rejects a manual retry that moved outside the Project authorized by the HTTP boundary. */
function requireSamePreparedManualProject(
  input: CreateManualTriageEntryInput,
  entry: TriageEntry,
): void {
  if (input.projectId !== entry.projectId) {
    throw new TriageError(
      409,
      'TriageConfigurationConflict',
      'Triage routing changed while the handoff was created. Retry the request.',
    )
  }
}

/** Validates configuration relationships and bounds. */
function validateConfigurationInput(
  teamId: string,
  input: UpdateTriageConfigurationInput,
): void {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TriageError(400, 'InvalidTriageConfiguration', 'The settings revision is invalid.')
  }
  if (
    !Array.isArray(input.allowedBulkActions) ||
    new Set(input.allowedBulkActions).size !== input.allowedBulkActions.length ||
    !input.allowedBulkActions.every(isTriageBulkActionName)
  ) {
    throw new TriageError(
      400,
      'InvalidTriageConfiguration',
      'Allowed bulk actions are invalid.',
    )
  }
  requirePositiveInteger(input.retentionDays, 'Retention days', 3_650)
  const ruleIds = new Set<string>()
  const rotationIds = new Set(input.rotations.map((rotation) => rotation.id))
  for (const rule of input.rules) {
    if (ruleIds.has(rule.id)) {
      throw new TriageError(400, 'InvalidTriageConfiguration', 'Routing rule IDs must be unique.')
    }
    ruleIds.add(rule.id)
    if (rule.teamId !== teamId) {
      throw new TriageError(400, 'InvalidTriageConfiguration', 'A routing rule targets another Team.')
    }
    if (rule.owner.type === 'rotation' && !rotationIds.has(rule.owner.rotationId)) {
      throw new TriageError(400, 'InvalidTriageConfiguration', 'A routing rotation is missing.')
    }
  }
  for (const rotation of input.rotations) {
    if (rotation.memberUserIds.length < 1 || new Set(rotation.memberUserIds).size !== rotation.memberUserIds.length) {
      throw new TriageError(400, 'InvalidTriageConfiguration', 'Rotation members are invalid.')
    }
    if (!Number.isSafeInteger(rotation.nextIndex) || rotation.nextIndex < 0 ||
      rotation.nextIndex >= rotation.memberUserIds.length) {
      throw new TriageError(400, 'InvalidTriageConfiguration', 'Rotation cursor is invalid.')
    }
    for (const memberUserId of rotation.memberUserIds) {
      requireUserId(memberUserId, 'Rotation member ID')
    }
  }
}

/** Decodes one Team configuration row and rejects corrupt or cross-scope state.
 *
 * @param value The untrusted DynamoDB item read from the expected primary key.
 * @param workspaceId The Workspace requested by the caller.
 * @param teamId The Team requested by the caller.
 * @returns The validated configuration, or undefined when no row exists.
 */
function decodeConfigurationRow(
  value: unknown,
  workspaceId: string,
  teamId: string,
): TriageConfiguration | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value.entryType !== 'triage-configuration') {
    throw invalidStoredConfiguration()
  }
  const configuration = decodeTriageConfiguration(value.configuration)
  if (
    !configuration ||
    configuration.workspaceId !== workspaceId ||
    configuration.teamId !== teamId ||
    value.revision !== configuration.revision
  ) {
    throw invalidStoredConfiguration()
  }
  return configuration
}

/** Decodes one immutable Team configuration replacement receipt.
 *
 * @param value The untrusted DynamoDB item.
 * @returns The validated receipt or undefined for malformed data.
 */
function decodeConfigurationReceipt(
  value: unknown,
): StoredTriageConfigurationReceipt | undefined {
  if (
    !isRecord(value) ||
    value.entryType !== 'triage-configuration-receipt' ||
    typeof value.workspaceId !== 'string' ||
    typeof value.teamId !== 'string' ||
    typeof value.inputFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.inputFingerprint) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 1
  ) return undefined
  const configuration = decodeTriageConfiguration(value.configuration)
  if (
    !configuration ||
    configuration.workspaceId !== value.workspaceId ||
    configuration.teamId !== value.teamId
  ) return undefined
  return {
    workspaceId: value.workspaceId,
    teamId: value.teamId,
    inputFingerprint: value.inputFingerprint,
    configuration,
  }
}

/** Deeply decodes one persisted Team configuration without trusting nested values.
 *
 * @param value The untrusted configuration attribute.
 * @returns A detached validated configuration, or undefined for malformed state.
 */
function decodeTriageConfiguration(value: unknown): TriageConfiguration | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== TRIAGE_CONFIGURATION_SCHEMA_VERSION ||
    !isWorkspaceId(value.workspaceId) ||
    !isIdentifier(value.teamId) ||
    !Array.isArray(value.rules) ||
    !Array.isArray(value.rotations) ||
    !Array.isArray(value.slaPolicies) ||
    !Array.isArray(value.allowedBulkActions) ||
    new Set(value.allowedBulkActions).size !== value.allowedBulkActions.length ||
    !value.allowedBulkActions.every(isTriageBulkActionName) ||
    !isPositiveInteger(value.retentionDays, 3_650) ||
    !isPositiveInteger(value.revision, Number.MAX_SAFE_INTEGER) ||
    !isIsoInstant(value.updatedAt)
  ) return undefined

  const rules: TriageRoutingRule[] = []
  for (const candidate of value.rules) {
    const rule = decodeRoutingRule(candidate)
    if (!rule) return undefined
    rules.push(rule)
  }
  const rotations: TriageOwnerRotation[] = []
  for (const candidate of value.rotations) {
    const rotation = decodeOwnerRotation(candidate)
    if (!rotation) return undefined
    rotations.push(rotation)
  }
  const slaPolicies: TriageSlaPolicy[] = []
  for (const candidate of value.slaPolicies) {
    const policy = decodeSlaPolicy(candidate)
    if (!policy) return undefined
    slaPolicies.push(policy)
  }
  const input: UpdateTriageConfigurationInput = {
    allowedBulkActions: [...value.allowedBulkActions],
    expectedRevision: value.revision - 1,
    retentionDays: value.retentionDays,
    rotations,
    rules,
    slaPolicies,
  }
  try {
    validateConfigurationInput(value.teamId, input)
  } catch {
    return undefined
  }
  return {
    schemaVersion: TRIAGE_CONFIGURATION_SCHEMA_VERSION,
    workspaceId: value.workspaceId,
    teamId: value.teamId,
    rules,
    rotations,
    slaPolicies,
    allowedBulkActions: [...value.allowedBulkActions],
    retentionDays: value.retentionDays,
    revision: value.revision,
    updatedAt: value.updatedAt,
  }
}

/** Decodes one persisted routing rule.
 *
 * @param value The untrusted rule value.
 * @returns A detached rule, or undefined when any nested field is invalid.
 */
function decodeRoutingRule(value: unknown): TriageRoutingRule | undefined {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    !isBoundedText(value.name, 200) ||
    typeof value.enabled !== 'boolean' ||
    !isNonNegativeInteger(value.order) ||
    !Array.isArray(value.sourceKinds) ||
    !value.sourceKinds.every(isTriageSourceKind) ||
    !Array.isArray(value.keywords) ||
    !value.keywords.every((keyword) => isBoundedText(keyword, 200)) ||
    !isIdentifier(value.teamId)
  ) return undefined
  const owner = decodeOwnerStrategy(value.owner)
  if (!owner || value.projectId !== undefined && !isIdentifier(value.projectId)) return undefined
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    order: value.order,
    sourceKinds: [...value.sourceKinds],
    keywords: [...value.keywords],
    teamId: value.teamId,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    owner,
  }
}

/** Decodes one persisted routing owner strategy.
 *
 * @param value The untrusted owner strategy.
 * @returns A detached supported strategy, or undefined for malformed input.
 */
function decodeOwnerStrategy(value: unknown): TriageOwnerStrategy | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'unowned') return { type: 'unowned' }
  if (value.type === 'fixed' && isUserId(value.ownerUserId)) {
    return { type: 'fixed', ownerUserId: value.ownerUserId }
  }
  if (value.type === 'rotation' && isIdentifier(value.rotationId)) {
    return { type: 'rotation', rotationId: value.rotationId }
  }
  return undefined
}

/** Decodes one persisted owner rotation.
 *
 * @param value The untrusted rotation value.
 * @returns A detached bounded rotation, or undefined for malformed input.
 */
function decodeOwnerRotation(value: unknown): TriageOwnerRotation | undefined {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    !isBoundedText(value.name, 200) ||
    !Array.isArray(value.memberUserIds) ||
    value.memberUserIds.length < 1 ||
    !value.memberUserIds.every(isUserId) ||
    !isNonNegativeInteger(value.nextIndex) ||
    value.nextIndex >= value.memberUserIds.length
  ) return undefined
  return {
    id: value.id,
    name: value.name,
    memberUserIds: [...value.memberUserIds],
    nextIndex: value.nextIndex,
  }
}

/** Decodes one persisted response and escalation policy.
 *
 * @param value The untrusted SLA policy value.
 * @returns A detached bounded policy, or undefined for malformed input.
 */
function decodeSlaPolicy(value: unknown): TriageSlaPolicy | undefined {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    !isBoundedText(value.name, 200) ||
    !Array.isArray(value.sourceKinds) ||
    !value.sourceKinds.every(isTriageSourceKind) ||
    !isPositiveInteger(value.responseMinutes, 525_600) ||
    value.escalationMinutes !== undefined &&
      !isPositiveInteger(value.escalationMinutes, 525_600) ||
    value.escalationOwnerUserId !== undefined && !isUserId(value.escalationOwnerUserId)
  ) return undefined
  return {
    id: value.id,
    name: value.name,
    sourceKinds: [...value.sourceKinds],
    responseMinutes: value.responseMinutes,
    ...(value.escalationMinutes === undefined
      ? {}
      : { escalationMinutes: value.escalationMinutes }),
    ...(value.escalationOwnerUserId === undefined
      ? {}
      : { escalationOwnerUserId: value.escalationOwnerUserId }),
  }
}

/** Creates a stable storage-corruption error for persisted Team settings.
 *
 * @returns A fail-closed internal configuration error.
 */
function invalidStoredConfiguration(): TriageError {
  return new TriageError(
    500,
    'InvalidTriageConfiguration',
    'The stored Triage configuration is invalid.',
  )
}

/** Returns whether a persisted source-kind value is supported.
 *
 * @param value The untrusted source-kind value.
 * @returns Whether the value belongs to the provider-neutral source union.
 */
function isTriageSourceKind(value: unknown): value is TriageSourceKind {
  return value === 'form' || value === 'chat' || value === 'email' ||
    value === 'webhook' || value === 'manual-handoff'
}

/** Returns whether a persisted value is a bounded non-empty string.
 *
 * @param value The untrusted value.
 * @param maximumLength The maximum accepted UTF-16 length.
 * @returns Whether the value is already normalized and within the bound.
 */
function isBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 &&
    value.length <= maximumLength
}

/** Returns whether a persisted value is a conservative identifier.
 *
 * @param value The untrusted identifier value.
 * @returns Whether the value matches the persisted identifier grammar.
 */
function isIdentifier(value: unknown): value is string {
  return isBoundedText(value, 200) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}

/** Returns whether a persisted value is a Workspace member identifier.
 *
 * @param value The untrusted member identifier.
 * @returns Whether the value supports the email-shaped member-key grammar.
 */
function isUserId(value: unknown): value is string {
  return isBoundedText(value, 320) && /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(value)
}

/** Returns whether a persisted value is a canonical Workspace partition identifier.
 *
 * @param value The untrusted Workspace identifier.
 * @returns Whether the value is bounded and free of control characters.
 */
function isWorkspaceId(value: unknown): value is string {
  return isBoundedText(value, 500) && ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}

/** Returns whether a persisted value is a bounded positive integer.
 *
 * @param value The untrusted numeric value.
 * @param maximum The inclusive upper bound.
 * @returns Whether the value is a positive safe integer within the bound.
 */
function isPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 1 && value <= maximum
}

/** Returns whether a persisted value is a non-negative integer.
 *
 * @param value The untrusted numeric value.
 * @returns Whether the value is a non-negative safe integer.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Returns whether a persisted value is a parseable ISO 8601 instant.
 *
 * @param value The untrusted timestamp value.
 * @returns Whether the value is bounded and parseable as an instant.
 */
function isIsoInstant(value: unknown): value is string {
  return isBoundedText(value, 100) && Number.isFinite(Date.parse(value))
}

/** Returns whether an unknown value names one supported bulk operation.
 *
 * @param value The untrusted action name.
 * @returns Whether the value is a supported bulk action name.
 */
function isTriageBulkActionName(
  value: unknown,
): value is TriageBulkOperation['action'] {
  return value === 'assign' || value === 'decline' || value === 'snooze'
}

/** Validates replay protection for one Team configuration replacement.
 *
 * @param value The key and semantic fingerprint supplied by an adapter.
 */
function validateConfigurationIdempotency(value: TriageIdempotency): void {
  requireText(value.key, 'Triage idempotency key', 200)
  if (!/^[a-f0-9]{64}$/u.test(value.fingerprint)) {
    throw new TriageError(
      400,
      'InvalidTriageIdempotency',
      'The Triage input fingerprint is invalid.',
    )
  }
}

/** Decodes a source uniqueness claim. */
function decodeSourceClaim(value: unknown): StoredTriageSourceClaim | undefined {
  if (!isRecord(value) || value.entryType !== 'triage-source-claim' ||
    typeof value.workspaceId !== 'string' || typeof value.entryId !== 'string' ||
    typeof value.inputFingerprint !== 'string') return undefined
  return {
    workspaceId: value.workspaceId,
    entryId: value.entryId,
    inputFingerprint: value.inputFingerprint,
  }
}

/** Decodes an operation receipt and its embedded entry. */
function decodeReceipt(value: unknown): StoredTriageReceipt | undefined {
  if (!isRecord(value) || value.entryType !== 'triage-operation-receipt' ||
    typeof value.workspaceId !== 'string' || typeof value.inputFingerprint !== 'string' ||
    typeof value.entryId !== 'string' ||
    typeof value.resultRevision !== 'number' || !Number.isSafeInteger(value.resultRevision) ||
    value.resultRevision < 1) return undefined
  return {
    workspaceId: value.workspaceId,
    inputFingerprint: value.inputFingerprint,
    entryId: value.entryId,
    resultRevision: value.resultRevision,
  }
}

/** Reads a base-table key from a KEYS_ONLY GSI item. */
function readPrimaryKey(value: unknown): { scopeKey: string; recordKey: string } | undefined {
  if (!isRecord(value) || typeof value.scopeKey !== 'string' || typeof value.recordKey !== 'string') {
    return undefined
  }
  return { scopeKey: value.scopeKey, recordKey: value.recordKey }
}

/** Reads an entry ID from a reverse source association. */
function readAssociationEntryId(value: unknown): string | undefined {
  return isRecord(value) && value.entryType === 'triage-work-item-source' &&
    typeof value.entryId === 'string' ? value.entryId : undefined
}

/** Classifies a conditional DynamoDB conflict. */
function isConditionalConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'ConditionalCheckFailedException') return true
  if (error.name !== 'TransactionCanceledException') return false
  const cancellationReasons = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(cancellationReasons) || cancellationReasons.length === 0) return false
  let hasConditionalFailure = false
  for (const reason of cancellationReasons) {
    const code = isRecord(reason) ? reason.Code : undefined
    if (code === 'ConditionalCheckFailed') {
      hasConditionalFailure = true
      continue
    }
    if (code !== 'None') return false
  }
  return hasConditionalFailure
}

/** Classifies a transaction cancellation caused only by one expected CAS item. */
function isOnlyConditionalConflictAt(error: unknown, itemIndex: number): boolean {
  if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 ||
    !(error instanceof Error) || error.name !== 'TransactionCanceledException') {
    return false
  }
  const cancellationReasons = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(cancellationReasons) || itemIndex >= cancellationReasons.length) return false
  return cancellationReasons.every((reason, index) => {
    const code = isRecord(reason) ? reason.Code : undefined
    return index === itemIndex ? code === 'ConditionalCheckFailed' : code === 'None'
  })
}

/** Classifies an optional index that is absent or still backfilling. */
function isUnavailableIndexError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'ResourceNotFoundException') return true
  return error.name === 'ValidationException' &&
    /(?:does not have the specified index|specified index.*(?:does not exist|not found)|index.*(?:not found|backfilling|not active)|backfilling global secondary index)/iu.test(error.message)
}

/** Creates a stable invalid-cursor error. */
function invalidCursor(): TriageError {
  return new TriageError(400, 'InvalidTriageCursor', 'The triage cursor is invalid.')
}

/** Reads an optional non-empty environment variable. */
function readEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

/** Requires a conservative identifier. */
function requireIdentifier(value: string, label: string): string {
  const identifier = requireText(value, label, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identifier)) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return identifier
}

/** Validates a canonical Workspace identifier that may contain Cognito delimiters. */
function requireWorkspaceId(value: string): string {
  const workspaceId = requireText(value, 'Workspace ID', 500)
  if ([...workspaceId].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })) {
    throw new TriageError(400, 'InvalidTriageInput', 'Workspace ID is invalid.')
  }
  return workspaceId
}

/** Requires a stable Workspace user identifier, including email-shaped member keys. */
function requireUserId(value: string, label: string): string {
  const identifier = requireText(value, label, 320)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(identifier)) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return identifier
}

/** Requires bounded text, optionally allowing empty content. */
function requireText(
  value: string,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  const normalized = value.trim()
  if ((!allowEmpty && !normalized) || normalized.length > maximumLength) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return normalized
}

/** Requires one bounded positive integer. */
function requirePositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return value
}

/** Requires a parseable ISO 8601 instant. */
function requireIsoInstant(value: string, label: string): string {
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime())) {
    throw new TriageError(400, 'InvalidTriageInput', `${label} is invalid.`)
  }
  return instant.toISOString()
}

/** Requires a conservative email address for display and trace only. */
function requireEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new TriageError(400, 'InvalidTriageInput', 'Requester email is invalid.')
  }
  return email
}

/** Adds whole UTC days to an instant. */
function addDays(value: string, days: number): string {
  const instant = new Date(value)
  instant.setUTCDate(instant.getUTCDate() + days)
  return instant.toISOString()
}

/** Checks whether an untrusted value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
