import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type GetCommandOutput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import type {
  AiAssistancePolicy,
  AiAssistancePreference,
  DecideAiAssistanceGenerationRequest,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import { z } from 'zod'
import type {
  AiAssistanceStore,
  AiAssistanceGenerationAttemptAuditEnvelope,
  AiAssistanceAuthorizationCondition,
  AiAssistanceDecisionCommitFence,
  AiAssistanceFeedbackCommitFence,
  AiAssistanceGenerationCommitFence,
  AiAssistanceGenerationReservation,
  AiAssistancePolicyAuthorizationFence,
  CompleteAiAssistanceGenerationReservationInput,
  FailAiAssistanceGenerationReservationInput,
  FinalizeAiAssistanceGenerationAttemptInput,
  ReadAiAssistanceGenerationReservationInput,
  ReserveAiAssistanceGenerationInput,
  StartAiAssistanceGenerationAttemptInput,
  StoredAiAssistanceFeedback,
  StoredAiAssistanceGeneration,
} from '../../application/ports/ai-assistance-ports'
import {
  createAuditTransactPut,
  type AuditEventV1,
} from '../../../audit'
import {
  parseAiAssistanceGeneration,
  parseAiAssistancePolicy,
  parseAiAssistancePreference,
  parseCreateAiAssistanceFeedbackRequest,
  parseGenerateAiAssistanceRequest,
} from '../../application/validation/ai-assistance-schema'
import {
  redactAiAssistanceCitation,
  redactAiAssistanceText,
  redactGenerateAiAssistanceRequest,
} from '../../domain/ai-assistance-redaction'
import { AiAssistanceError } from '../../errors'

const POLICY_RECORD_KEY = 'AI_POLICY#WORKSPACE'
const PREFERENCE_RECORD_PREFIX = 'AI_PREF#MEMBER#'
const GENERATION_RECORD_PREFIX = 'AI_GENERATION#'
const FEEDBACK_RECORD_PREFIX = 'AI_FEEDBACK#'
const IDEMPOTENCY_RECORD_PREFIX = 'AI_IDEMPOTENCY#MEMBER#'
const BUDGET_RECORD_PREFIX = 'AI_BUDGET#MINUTE#'
const GENERATION_BUDGET_WINDOW_MS = 60_000
const MAX_STORED_GENERATION_SERIALIZED_BYTES = 350 * 1_024
const MAX_MEMBER_IDENTIFIER_LENGTH = 320

const aiAssistanceErrorCategorySchema = z.enum([
  'validation',
  'authentication',
  'authorization',
  'not-found',
  'conflict',
  'rate-limit',
  'upstream',
  'timeout',
])

const aiAssistanceErrorCodeSchema = z.enum([
  'InvalidAiAssistanceRequest',
  'InvalidAiAssistanceOutput',
  'AiAssistanceOutputNotAllowed',
  'AiAssistanceCitationInvalid',
  'AiAssistanceAuthenticationRequired',
  'AiAssistanceDisabled',
  'AiAssistancePreferenceDisabled',
  'AiAssistanceTaskDisabled',
  'AiAssistanceModelNotAllowed',
  'AiAssistanceAuthorizationChanged',
  'AiAssistanceSourceChanged',
  'AiAssistanceGenerationNotFound',
  'AiAssistanceRevisionConflict',
  'AiAssistanceIdempotencyKeyRequired',
  'AiAssistanceIdempotencyConflict',
  'AiAssistanceGenerationInProgress',
  'AiAssistanceRateLimitExceeded',
  'AiAssistanceDecisionAlreadyRecorded',
  'AiAssistanceAttemptFailed',
  'AiAssistancePersistenceError',
  'AiAssistanceProviderError',
  'AiAssistanceProviderTimeout',
  'InvalidAiAssistanceRecord',
])

const aiAssistanceUsageBaseSchema = z.object({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  latencyMs: z.number().int().min(0),
}).strict()

const aiAssistanceUsageSchema = z.union([
  aiAssistanceUsageBaseSchema.extend({
    costUsd: z.number().min(0).finite(),
  }).strict(),
  aiAssistanceUsageBaseSchema.extend({
    costUnavailableReason: z.enum([
      'provider-not-reported',
      'pricing-not-configured',
    ]),
  }).strict(),
])

const generationAttemptAuditCitationSchema = z.object({
  id: z.string().trim().min(1).max(256),
  sourceType: z.enum([
    'triage-entry',
    'request-submission',
    'work-item',
    'document',
    'planning-target',
  ]),
  label: z.string().trim().min(1).max(500),
  href: z.string().trim().min(1).max(2_000).refine(isSafeApplicationHref),
  excerpt: z.string().trim().max(2_000).optional(),
  capturedRevision: z.number().int().min(0),
}).strict()

const generationAttemptAuditSchema = z.object({
  request: z.unknown(),
  auditedInput: z.string().min(1).max(100_000),
  citations: z.array(generationAttemptAuditCitationSchema).max(100).refine(
    (citations) => new Set(citations.map((citation) => citation.id)).size === citations.length,
  ),
}).strict().superRefine((value, context) => {
  let request: GenerateAiAssistanceRequest
  try {
    request = parseGenerateAiAssistanceRequest(value.request)
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid attempt request audit.' })
    return
  }
  if (
    !equalJsonValues(request, redactGenerateAiAssistanceRequest(request)) ||
    value.auditedInput !== redactAiAssistanceText(value.auditedInput) ||
    value.citations.some((citation) =>
      !equalJsonValues(citation, redactAiAssistanceCitation(citation)))
  ) {
    context.addIssue({ code: 'custom', message: 'Attempt audit is not redacted.' })
  }
})

const generationAttemptSchema = z.object({
  task: z.enum(['triage', 'summary', 'search', 'planning']),
  modelId: z.string().min(1).max(256),
  promptVersion: z.string().min(1).max(256),
  traceId: z.string().min(1).max(256),
  startedAt: z.string().datetime({ offset: true }),
  audit: generationAttemptAuditSchema,
  status: z.enum(['started', 'succeeded', 'failed']),
  endedAt: z.string().datetime({ offset: true }).optional(),
  latencyMs: z.number().int().min(0).optional(),
  usage: aiAssistanceUsageSchema.optional(),
  usageUnavailableReason: z.literal('provider-did-not-report').optional(),
  providerTraceId: z.string().min(1).max(256).optional(),
  failureCategory: aiAssistanceErrorCategorySchema.optional(),
  failureCode: aiAssistanceErrorCodeSchema.optional(),
}).strict()

/**
 * One DynamoDB transaction operation used by an idempotency and budget write.
 *
 * @remarks The alias keeps transaction item construction type-safe without
 * exposing the AWS SDK input type through the application port.
 */
type AiAssistanceBudgetTransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

/**
 * Values used to build one scope-specific fixed-window counter update.
 *
 * @remarks The counter update is conditional on both the logical scope and
 * the configured generation/token limits.
 */
type CreateBudgetCounterTransactionItemInput = {
  /** Workspace Search table physical name. */
  tableName: string
  /** Workspace partition that owns the counter. */
  workspaceId: string
  /** Scope- and window-specific record key. */
  recordKey: string
  /** Exact logical scope protected against malformed preexisting rows. */
  scopeKey: string
  /** Inclusive fixed-window start in epoch milliseconds. */
  windowStartedAt: number
  /** Exclusive fixed-window end in epoch milliseconds. */
  windowExpiresAt: number
  /** Conservative tokens added for this unique generation key. */
  reservedTokens: number
  /** Maximum accepted unique keys in this scope and window. */
  generationLimit: number
  /** Maximum accepted token reservations in this scope and window. */
  tokenLimit: number
}

const baseStoredGenerationItemSchema = z.object({
  workspaceId: z.string().min(1),
  recordKey: z.string().min(1),
  recordType: z.literal('ai-assistance-generation'),
  memberId: z.string().min(1),
  generation: z.unknown(),
  request: z.unknown(),
  authorizationToken: z.string().min(1).max(8_192),
  auditedInput: z.string().max(100_000),
  expiresAt: z.number().int().min(0),
}).strict()

const policyItemSchema = z.object({
  workspaceId: z.string().min(1),
  recordKey: z.literal(POLICY_RECORD_KEY),
  recordType: z.literal('ai-assistance-policy'),
  policy: z.unknown(),
  mutationFingerprint: z.string().length(64).optional(),
}).strict()

const preferenceItemSchema = z.object({
  workspaceId: z.string().min(1),
  recordKey: z.string().startsWith(PREFERENCE_RECORD_PREFIX),
  recordType: z.literal('ai-assistance-preference'),
  memberId: z.string().min(1),
  preference: z.unknown(),
}).strict()

const idempotencyItemSchema = z.object({
  workspaceId: z.string().min(1),
  recordKey: z.string().startsWith(IDEMPOTENCY_RECORD_PREFIX),
  recordType: z.literal('ai-assistance-generation-idempotency'),
  memberId: z.string().min(1),
  inputFingerprint: z.string().length(64),
  generationId: z.string().min(1).max(256),
  status: z.enum(['pending', 'completed', 'failed']),
  leaseExpiresAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  attempt: generationAttemptSchema.optional(),
  failedAt: z.string().datetime({ offset: true }).optional(),
  failureCategory: aiAssistanceErrorCategorySchema.optional(),
  failureCode: aiAssistanceErrorCodeSchema.optional(),
}).strict().superRefine((value, context) => {
  const attempt = value.attempt
  const hasOuterFailure = value.failedAt !== undefined &&
    value.failureCategory !== undefined && value.failureCode !== undefined
  const hasPartialOuterFailure = [
    value.failedAt,
    value.failureCategory,
    value.failureCode,
  ].some((entry) => entry !== undefined) && !hasOuterFailure
  if (hasPartialOuterFailure) {
    context.addIssue({ code: 'custom', message: 'Incomplete receipt failure.' })
  }
  if (
    (value.status === 'pending' && (hasOuterFailure ||
      (attempt !== undefined && attempt.status !== 'started'))) ||
    (value.status === 'completed' && (hasOuterFailure ||
      attempt === undefined || attempt.status !== 'succeeded')) ||
    (value.status === 'failed' && (!hasOuterFailure ||
      (attempt !== undefined && (
        attempt.status !== 'failed' ||
        attempt.failureCategory !== value.failureCategory ||
        attempt.failureCode !== value.failureCode
      ))))
  ) {
    context.addIssue({ code: 'custom', message: 'Receipt outcome is inconsistent.' })
  }
  if (attempt === undefined) return
  const hasUsage = attempt.usage !== undefined
  const hasUsageUnavailableReason = attempt.usageUnavailableReason !== undefined
  const hasAttemptFailure = attempt.failureCategory !== undefined &&
    attempt.failureCode !== undefined
  if (
    (attempt.status === 'started' && (
      attempt.endedAt !== undefined ||
      attempt.latencyMs !== undefined ||
      hasUsage ||
      hasUsageUnavailableReason ||
      hasAttemptFailure
    )) ||
    (attempt.status === 'succeeded' && (
      attempt.endedAt === undefined ||
      attempt.latencyMs === undefined ||
      !hasUsage ||
      hasUsageUnavailableReason ||
      hasAttemptFailure
    )) ||
    (attempt.status === 'failed' && (
      attempt.endedAt === undefined ||
      attempt.latencyMs === undefined ||
      hasUsage === hasUsageUnavailableReason ||
      !hasAttemptFailure
    ))
  ) {
    context.addIssue({ code: 'custom', message: 'Attempt outcome is inconsistent.' })
  }
})

const feedbackItemSchema = z.object({
  workspaceId: z.string().min(1),
  recordKey: z.string().startsWith(FEEDBACK_RECORD_PREFIX),
  recordType: z.literal('ai-assistance-feedback'),
  generationId: z.string().min(1).max(256),
  feedbackId: z.string().min(1).max(256),
  memberId: z.string().min(1),
  feedback: z.unknown(),
  inputFingerprint: z.string().length(64),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.number().int().min(0),
}).strict()

/** DynamoDB adapter that reuses the WorkspaceSearchTable partition and TTL contract. */
export class DynamoDbAiAssistanceStore implements AiAssistanceStore {
  /** WorkspaceSearchTable document client. */
  readonly #documentClient: DynamoDBDocumentClient

  /** WorkspaceSearchTable physical name supplied by composition. */
  readonly #tableName: string
  /** Existing immutable Audit table used by policy mutation transactions. */
  readonly #auditTableName?: string
  /** Workspace Access table containing the actor membership condition row. */
  readonly #workspaceAccessTableName: string
  /** Enterprise Identity table containing the optional CONTROL revision row. */
  readonly #enterpriseIdentityTableName?: string

  /**
   * Creates a WorkspaceSearchTable-backed AI assistance store.
   *
   * @param documentClient - Configured DynamoDB document client.
   * @param tableName - Existing WorkspaceSearchTable name.
   * @param auditTableName - Existing immutable Audit table name for policy transactions.
   * @param workspaceAccessTableName - Workspace Access table name for commit-time member checks.
   * @param enterpriseIdentityTableName - Optional Enterprise Identity table name for control checks.
   */
  constructor(
    documentClient: DynamoDBDocumentClient,
    tableName: string,
    auditTableName?: string,
    workspaceAccessTableName = 'mukuroji-workspace-access-local',
    enterpriseIdentityTableName?: string,
  ) {
    if (!tableName.trim()) {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceRequest',
        'AI assistance table name is required.',
      )
    }
    if (auditTableName !== undefined && !auditTableName.trim()) {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceRequest',
        'AI assistance audit table name is invalid.',
      )
    }
    if (!workspaceAccessTableName.trim()) {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceRequest',
        'AI assistance Workspace Access table name is invalid.',
      )
    }
    if (enterpriseIdentityTableName !== undefined && !enterpriseIdentityTableName.trim()) {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceRequest',
        'AI assistance Enterprise Identity table name is invalid.',
      )
    }
    this.#documentClient = documentClient
    this.#tableName = tableName
    this.#auditTableName = auditTableName?.trim()
    this.#workspaceAccessTableName = workspaceAccessTableName.trim()
    this.#enterpriseIdentityTableName = enterpriseIdentityTableName?.trim()
  }

  /**
   * Reads one Workspace Search table item with a stable application error boundary.
   *
   * @param workspaceId - Workspace partition containing the item.
   * @param recordKey - Server-built record key to read.
   * @returns The strongly consistent DynamoDB response.
   * @throws AiAssistancePersistenceError when DynamoDB rejects or times out the read.
   */
  async #readItem(
    workspaceId: string,
    recordKey: string,
  ): Promise<GetCommandOutput> {
    try {
      return await this.#documentClient.send(new GetCommand({
        TableName: this.#tableName,
        Key: { workspaceId, recordKey },
        ConsistentRead: true,
      }))
    } catch (error) {
      throw mapDynamoReadError(error)
    }
  }

  /**
   * Reads an existing receipt without charging a new generation budget.
   *
   * @param input - Workspace, member, idempotency, and fingerprint identity.
   * @returns A replayable, pending-attempt, or terminal failure reservation; undefined for a missing or not-yet-started receipt.
   * @throws A stable persistence or idempotency error when the receipt is malformed or mismatched.
   */
  async readGenerationReservation(
    input: ReadAiAssistanceGenerationReservationInput,
  ): Promise<AiAssistanceGenerationReservation | undefined> {
    const recordKey = createIdempotencyRecordKey(input.memberId, input.idempotencyKey)
    const response = await this.#readItem(input.workspaceId, recordKey)
    if (!response.Item) return undefined
    const parsed = idempotencyItemSchema.safeParse(response.Item)
    if (
      !parsed.success ||
      parsed.data.workspaceId !== input.workspaceId ||
      parsed.data.recordKey !== recordKey ||
      parsed.data.memberId !== input.memberId
    ) {
      throw invalidRecordError()
    }
    if (parsed.data.inputFingerprint !== input.inputFingerprint) {
      throw idempotencyConflictError()
    }
    if (parsed.data.status === 'completed') {
      return { status: 'replay', generationId: parsed.data.generationId }
    }
    if (parsed.data.status === 'failed') {
      if (parsed.data.failureCategory === undefined || parsed.data.failureCode === undefined) {
        throw invalidRecordError()
      }
      return {
        status: 'failed',
        generationId: parsed.data.generationId,
        failureCategory: parsed.data.failureCategory,
        failureCode: parsed.data.failureCode,
      }
    }
    // A started attempt has already consumed the durable budget and may have
    // persisted its generation before the terminal receipt update. Return the
    // pending state so the application can reconcile that generation before
    // applying new-generation policy gates. Pending receipts without an
    // attempt remain invisible here so an expired lease can still be taken
    // over by reserveGeneration.
    return parsed.data.attempt === undefined
      ? undefined
      : { status: 'pending', generationId: parsed.data.generationId }
  }

  /** Atomically reserves a member and input-bound generation idempotency key. */
  async reserveGeneration(
    input: ReserveAiAssistanceGenerationInput,
  ): Promise<AiAssistanceGenerationReservation> {
    const recordKey = createIdempotencyRecordKey(input.memberId, input.idempotencyKey)
    const requestedAt = toEpochMilliseconds(input.requestedAt)
    const leaseExpiresAt = toEpochMilliseconds(input.leaseExpiresAt)
    const windowStartedAt = toEpochMilliseconds(input.budget.windowStartedAt)
    const windowExpiresAt = toEpochMilliseconds(input.budget.windowExpiresAt)
    if (leaseExpiresAt <= requestedAt) throw invalidRecordError()
    validateBudgetReservation(input, requestedAt, windowStartedAt, windowExpiresAt)
    try {
      await this.#documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#tableName,
              Item: {
                workspaceId: input.workspaceId,
                recordKey,
                recordType: 'ai-assistance-generation-idempotency',
                memberId: input.memberId,
                inputFingerprint: input.inputFingerprint,
                generationId: input.generationId,
                status: 'pending',
                leaseExpiresAt,
                expiresAt: toTtlEpochSeconds(input.expiresAt),
              },
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          },
          createBudgetCounterTransactionItem({
            tableName: this.#tableName,
            workspaceId: input.workspaceId,
            recordKey: createWorkspaceBudgetRecordKey(windowStartedAt),
            scopeKey: 'workspace',
            windowStartedAt,
            windowExpiresAt,
            reservedTokens: input.budget.reservedTokens,
            generationLimit: input.budget.workspaceGenerationLimit,
            tokenLimit: input.budget.workspaceTokenLimit,
          }),
          createBudgetCounterTransactionItem({
            tableName: this.#tableName,
            workspaceId: input.workspaceId,
            recordKey: createMemberBudgetRecordKey(windowStartedAt, input.memberId),
            scopeKey: `member:${input.memberId}`,
            windowStartedAt,
            windowExpiresAt,
            reservedTokens: input.budget.reservedTokens,
            generationLimit: input.budget.memberGenerationLimit,
            tokenLimit: input.budget.memberTokenLimit,
          }),
        ],
      }))
      return { status: 'reserved', generationId: input.generationId }
    } catch (error) {
      if (isTransactionConditionalFailureAt(error, 0)) {
        return await this.#reserveExistingGeneration(
          input,
          recordKey,
          requestedAt,
          leaseExpiresAt,
        )
      }
      if (
        isTransactionConditionalFailureAt(error, 1) ||
        isTransactionConditionalFailureAt(error, 2)
      ) {
        throw generationBudgetExceededError()
      }
      throw mapDynamoWriteError(error)
    }
  }

  /** Takes over or classifies an existing idempotency receipt without charging budget again. */
  async #reserveExistingGeneration(
    input: ReserveAiAssistanceGenerationInput,
    recordKey: string,
    requestedAt: number,
    leaseExpiresAt: number,
  ): Promise<AiAssistanceGenerationReservation> {
    try {
      await this.#documentClient.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { workspaceId: input.workspaceId, recordKey },
        UpdateExpression:
          'SET #generationId = :generationId, #leaseExpiresAt = :leaseExpiresAt, ' +
          '#expiresAt = :expiresAt',
        ConditionExpression:
          '#memberId = :memberId AND #inputFingerprint = :inputFingerprint AND ' +
          '#status = :pending AND #leaseExpiresAt <= :requestedAt AND ' +
          'attribute_not_exists(#attempt)',
        ExpressionAttributeNames: {
          '#memberId': 'memberId',
          '#inputFingerprint': 'inputFingerprint',
          '#generationId': 'generationId',
          '#status': 'status',
          '#leaseExpiresAt': 'leaseExpiresAt',
          '#expiresAt': 'expiresAt',
          '#attempt': 'attempt',
        },
        ExpressionAttributeValues: {
          ':memberId': input.memberId,
          ':inputFingerprint': input.inputFingerprint,
          ':generationId': input.generationId,
          ':pending': 'pending',
          ':requestedAt': requestedAt,
          ':leaseExpiresAt': leaseExpiresAt,
          ':expiresAt': toTtlEpochSeconds(input.expiresAt),
        },
      }))
      return { status: 'reserved', generationId: input.generationId }
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw mapDynamoWriteError(error)
    }

    const response = await this.#readItem(input.workspaceId, recordKey)
    const parsed = idempotencyItemSchema.safeParse(response.Item)
    if (
      !parsed.success ||
      parsed.data.workspaceId !== input.workspaceId ||
      parsed.data.recordKey !== recordKey ||
      parsed.data.memberId !== input.memberId
    ) {
      throw invalidRecordError()
    }
    if (parsed.data.inputFingerprint !== input.inputFingerprint) {
      throw new AiAssistanceError(
        'conflict',
        'AiAssistanceIdempotencyConflict',
        'The Idempotency-Key was already used with different AI assistance input.',
      )
    }
    if (parsed.data.status === 'failed') {
      if (!parsed.data.failureCategory || !parsed.data.failureCode) {
        throw invalidRecordError()
      }
      return {
        status: 'failed',
        generationId: parsed.data.generationId,
        failureCategory: parsed.data.failureCategory,
        failureCode: parsed.data.failureCode,
      }
    }
    return {
      status: parsed.data.status === 'completed' ? 'replay' : 'pending',
      generationId: parsed.data.generationId,
    }
  }

  /** Persists a safe provider-attempt envelope before the model call begins. */
  async startGenerationAttempt(
    input: StartAiAssistanceGenerationAttemptInput,
  ): Promise<void> {
    const recordKey = createIdempotencyRecordKey(input.memberId, input.idempotencyKey)
    toEpochMilliseconds(input.startedAt)
    const audit = createGenerationAttemptAuditEnvelope(input.audit)
    const attempt = {
      task: input.task,
      modelId: requireIdentifier(input.modelId),
      promptVersion: requireIdentifier(input.promptVersion),
      traceId: requireIdentifier(input.traceId),
      startedAt: input.startedAt,
      audit,
      status: 'started',
    }
    const currentResponse = await this.#readItem(input.workspaceId, recordKey)
    const current = idempotencyItemSchema.safeParse(currentResponse.Item)
    if (
      !current.success ||
      !receiptIdentityMatches(current.data, input, recordKey)
    ) {
      throw invalidRecordError()
    }
    if (current.data.status !== 'pending') throw idempotencyConflictError()
    if (current.data.attempt !== undefined) {
      requireStoredAiAssistanceItemSize(current.data)
      if (generationAttemptStartMatches(current.data.attempt, attempt)) return
      throw idempotencyConflictError()
    }
    requireStoredAiAssistanceItemSize({ ...current.data, attempt })
    try {
      await this.#documentClient.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { workspaceId: input.workspaceId, recordKey },
        UpdateExpression: 'SET #attempt = :attempt',
        ConditionExpression:
          '#memberId = :memberId AND #inputFingerprint = :inputFingerprint AND ' +
          '#generationId = :generationId AND #status = :pending AND ' +
          '#recordType = :recordType AND #leaseExpiresAt = :leaseExpiresAt AND ' +
          '#expiresAt = :expiresAt AND ' +
          'attribute_not_exists(#attempt)',
        ExpressionAttributeNames: {
          '#memberId': 'memberId',
          '#inputFingerprint': 'inputFingerprint',
          '#generationId': 'generationId',
          '#status': 'status',
          '#recordType': 'recordType',
          '#leaseExpiresAt': 'leaseExpiresAt',
          '#expiresAt': 'expiresAt',
          '#attempt': 'attempt',
        },
        ExpressionAttributeValues: {
          ':memberId': input.memberId,
          ':inputFingerprint': input.inputFingerprint,
          ':generationId': input.generationId,
          ':pending': 'pending',
          ':recordType': 'ai-assistance-generation-idempotency',
          ':leaseExpiresAt': current.data.leaseExpiresAt,
          ':expiresAt': current.data.expiresAt,
          ':attempt': attempt,
        },
      }))
    } catch (error) {
      let response: GetCommandOutput
      try {
        response = await this.#readItem(input.workspaceId, recordKey)
      } catch {
        throw mapDynamoWriteError(error)
      }
      const parsed = idempotencyItemSchema.safeParse(response.Item)
      if (
        parsed.success &&
        receiptIdentityMatches(parsed.data, input, recordKey) &&
        parsed.data.status === 'pending' &&
        generationAttemptStartMatches(parsed.data.attempt, attempt)
      ) return
      if (!isConditionalCheckFailed(error)) throw mapDynamoWriteError(error)
      throw idempotencyConflictError()
    }
  }

  /** Finalizes the provider attempt and the owning receipt in one conditional update. */
  async finalizeGenerationAttempt(
    input: FinalizeAiAssistanceGenerationAttemptInput,
  ): Promise<void> {
    validateGenerationAttemptCompletion(input)
    const recordKey = createIdempotencyRecordKey(input.memberId, input.idempotencyKey)
    const receiptStatus = input.outcome === 'succeeded' ? 'completed' : 'failed'
    const updateParts = [
      '#status = :receiptStatus',
      '#attempt.#attemptStatus = :attemptStatus',
      '#attempt.#endedAt = :endedAt',
      '#attempt.#latencyMs = :latencyMs',
    ]
    const expressionAttributeNames: Record<string, string> = {
      '#memberId': 'memberId',
      '#inputFingerprint': 'inputFingerprint',
      '#generationId': 'generationId',
      '#status': 'status',
      '#attempt': 'attempt',
      '#attemptStatus': 'status',
      '#endedAt': 'endedAt',
      '#latencyMs': 'latencyMs',
    }
    const expressionAttributeValues: Record<string, unknown> = {
      ':memberId': input.memberId,
      ':inputFingerprint': input.inputFingerprint,
      ':generationId': input.generationId,
      ':pending': 'pending',
      ':started': 'started',
      ':receiptStatus': receiptStatus,
      ':attemptStatus': input.outcome,
      ':endedAt': input.endedAt,
      ':latencyMs': input.latencyMs,
    }
    if (input.usage) {
      updateParts.push('#attempt.#usage = :usage')
      expressionAttributeNames['#usage'] = 'usage'
      expressionAttributeValues[':usage'] = input.usage
    }
    if (input.usageUnavailableReason) {
      updateParts.push('#attempt.#usageUnavailableReason = :usageUnavailableReason')
      expressionAttributeNames['#usageUnavailableReason'] = 'usageUnavailableReason'
      expressionAttributeValues[':usageUnavailableReason'] = input.usageUnavailableReason
    }
    if (input.providerTraceId) {
      updateParts.push('#attempt.#providerTraceId = :providerTraceId')
      expressionAttributeNames['#providerTraceId'] = 'providerTraceId'
      expressionAttributeValues[':providerTraceId'] = requireIdentifier(input.providerTraceId)
    }
    if (input.outcome === 'failed') {
      updateParts.push(
        '#failedAt = :endedAt',
        '#failureCategory = :failureCategory',
        '#failureCode = :failureCode',
        '#attempt.#failureCategory = :failureCategory',
        '#attempt.#failureCode = :failureCode',
      )
      expressionAttributeNames['#failedAt'] = 'failedAt'
      expressionAttributeNames['#failureCategory'] = 'failureCategory'
      expressionAttributeNames['#failureCode'] = 'failureCode'
      expressionAttributeValues[':failureCategory'] = input.failureCategory
      expressionAttributeValues[':failureCode'] = input.failureCode
    }
    const updateInput = {
      TableName: this.#tableName,
      Key: { workspaceId: input.workspaceId, recordKey },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ConditionExpression:
        '#memberId = :memberId AND #inputFingerprint = :inputFingerprint AND ' +
        '#generationId = :generationId AND #status = :pending AND ' +
        '#attempt.#attemptStatus = :started',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }
    try {
      await this.#documentClient.send(new UpdateCommand(updateInput))
    } catch (error) {
      let response: GetCommandOutput
      try {
        response = await this.#readItem(input.workspaceId, recordKey)
      } catch {
        throw mapDynamoWriteError(error)
      }
      if (isFinalizedAttemptReceipt(response.Item, input, recordKey, receiptStatus)) {
        return
      }
      if (isConditionalCheckFailed(error)) {
        throw idempotencyConflictError()
      }
      if (!isPendingAttemptReceipt(response.Item, input, recordKey)) {
        throw mapDynamoWriteError(error)
      }

      // A transport failure can occur after DynamoDB committed the update but
      // before the client received its response. If the strong read still sees
      // the started receipt, retry the exact terminal CAS once and reconcile the
      // result instead of leaving a provider-paid attempt pending until TTL.
      try {
        await this.#documentClient.send(new UpdateCommand(updateInput))
        return
      } catch (retryError) {
        let retryResponse: GetCommandOutput
        try {
          retryResponse = await this.#readItem(input.workspaceId, recordKey)
        } catch {
          throw mapDynamoWriteError(retryError)
        }
        if (isFinalizedAttemptReceipt(
          retryResponse.Item,
          input,
          recordKey,
          receiptStatus,
        )) return
        if (isConditionalCheckFailed(retryError)) {
          throw idempotencyConflictError()
        }
        throw mapDynamoWriteError(retryError)
      }
    }
  }

  /** Repairs a started receipt after a previous terminal write failed. */
  async recoverGenerationAttempt(
    input: FinalizeAiAssistanceGenerationAttemptInput,
  ): Promise<void> {
    if (input.outcome !== 'failed') {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceRequest',
        'AI assistance attempt recovery must finalize a failed attempt.',
      )
    }
    // Reuse the exact identity and conditional terminal update. This path is
    // deliberately provider-free and budget-free; a response-loss replay is
    // reconciled by the strong read in finalizeGenerationAttempt.
    await this.finalizeGenerationAttempt(input)
  }

  /** Finalizes a reservation that stopped before any provider attempt began. */
  async failGenerationReservation(
    input: FailAiAssistanceGenerationReservationInput,
  ): Promise<void> {
    toEpochMilliseconds(input.failedAt)
    const recordKey = createIdempotencyRecordKey(input.memberId, input.idempotencyKey)
    try {
      await this.#documentClient.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { workspaceId: input.workspaceId, recordKey },
        UpdateExpression:
          'SET #status = :failed, #failedAt = :failedAt, ' +
          '#failureCategory = :failureCategory, #failureCode = :failureCode',
        ConditionExpression:
          '#memberId = :memberId AND #inputFingerprint = :inputFingerprint AND ' +
          '#generationId = :generationId AND #status = :pending AND ' +
          'attribute_not_exists(#attempt)',
        ExpressionAttributeNames: {
          '#memberId': 'memberId',
          '#inputFingerprint': 'inputFingerprint',
          '#generationId': 'generationId',
          '#status': 'status',
          '#failedAt': 'failedAt',
          '#failureCategory': 'failureCategory',
          '#failureCode': 'failureCode',
          '#attempt': 'attempt',
        },
        ExpressionAttributeValues: {
          ':memberId': input.memberId,
          ':inputFingerprint': input.inputFingerprint,
          ':generationId': input.generationId,
          ':pending': 'pending',
          ':failed': 'failed',
          ':failedAt': input.failedAt,
          ':failureCategory': input.failureCategory,
          ':failureCode': input.failureCode,
        },
      }))
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw mapDynamoWriteError(error)
      const response = await this.#readItem(input.workspaceId, recordKey)
      const parsed = idempotencyItemSchema.safeParse(response.Item)
      if (
        parsed.success &&
        receiptIdentityMatches(parsed.data, input, recordKey) &&
        parsed.data.status === 'failed' &&
        parsed.data.failureCategory === input.failureCategory &&
        parsed.data.failureCode === input.failureCode
      ) return
      throw idempotencyConflictError()
    }
  }

  /** Reads the current Workspace policy with a strongly consistent read. */
  async getPolicy(workspaceId: string): Promise<AiAssistancePolicy | undefined> {
    const item = await this.#readPolicyItem(workspaceId)
    return item === undefined ? undefined : parseAiAssistancePolicy(item.policy)
  }

  /** Reads and validates the raw Workspace policy row for replay identity checks. */
  async #readPolicyItem(
    workspaceId: string,
  ): Promise<z.infer<typeof policyItemSchema> | undefined> {
    const response = await this.#readItem(workspaceId, POLICY_RECORD_KEY)
    if (!response.Item) return undefined
    const parsed = policyItemSchema.safeParse(response.Item)
    if (!parsed.success || parsed.data.workspaceId !== workspaceId) {
      throw invalidRecordError()
    }
    return parsed.data
  }

  /** Writes a Workspace policy using revision-fenced compare-and-swap. */
  async putPolicy(
    workspaceId: string,
    policy: AiAssistancePolicy,
    expectedRevision: number,
  ): Promise<AiAssistancePolicy> {
    try {
      await this.#putRevisionFencedItem(
        {
          workspaceId,
          recordKey: POLICY_RECORD_KEY,
          recordType: 'ai-assistance-policy',
          policy,
        },
        'policy',
        expectedRevision,
      )
      return policy
    } catch (error) {
      if (!isRevisionConflict(error)) throw error
      const current = await this.getPolicy(workspaceId)
      if (current && isPolicyReplay(current, policy, expectedRevision)) return current
      throw error
    }
  }

  /**
   * Writes a Workspace policy and its immutable audit event in one DynamoDB transaction.
   *
   * @param workspaceId - Workspace partition owning the policy.
   * @param memberId - Freshly authenticated manager member identifier.
   * @param policy - Validated next policy snapshot.
   * @param expectedRevision - Revision required by the policy CAS.
   * @param authorizationFence - Membership and Enterprise conditions checked at commit time.
   * @param auditEvent - Redacted immutable event written with the policy.
   * @returns The policy accepted by the transaction or an identical replay.
   */
  async putPolicyWithAudit(
    workspaceId: string,
    memberId: string,
    policy: AiAssistancePolicy,
    expectedRevision: number,
    authorizationFence: AiAssistancePolicyAuthorizationFence,
    auditEvent: AuditEventV1,
  ): Promise<AiAssistancePolicy> {
    const auditTableName = this.#auditTableName
    if (auditTableName === undefined) {
      throw new AiAssistanceError(
        'upstream',
        'AiAssistancePersistenceError',
        'AI assistance policy audit storage is not configured.',
      )
    }
    validatePolicyAuthorizationFence(authorizationFence)
    const mutationFingerprint = createPolicyMutationFingerprint({
      workspaceId,
      memberId,
      actorUserId: auditEvent.actorUserId,
      expectedRevision,
      policy,
    })
    const policyItem = {
      workspaceId,
      recordKey: POLICY_RECORD_KEY,
      recordType: 'ai-assistance-policy',
      policy,
      mutationFingerprint,
    }
    const policyPut = {
      Put: {
        TableName: this.#tableName,
        Item: policyItem,
        ConditionExpression: expectedRevision === 0
          ? 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)'
          : '#policy.#revision = :expectedRevision',
        ...(expectedRevision === 0
          ? {}
          : {
              ExpressionAttributeNames: {
                '#policy': 'policy',
                '#revision': 'revision',
              },
              ExpressionAttributeValues: {
                ':expectedRevision': expectedRevision,
              },
            }),
      },
    }
    const requiresWorkspaceMemberCondition =
      (authorizationFence.principalKind ?? 'member') === 'member'
    const workspaceMemberConditionItems = requiresWorkspaceMemberCondition
      ? [createWorkspaceMemberAuthorizationCondition(
          this.#workspaceAccessTableName,
          workspaceId,
          memberId,
          authorizationFence,
        )]
      : []
    const enterpriseConditionItems = authorizationFence.enterpriseControlRevision === undefined
      ? []
      : [createEnterpriseControlAuthorizationCondition(
          this.#enterpriseIdentityTableName,
          workspaceId,
          authorizationFence.enterpriseControlRevision,
        )]
    const workspaceMemberConditionIndex = requiresWorkspaceMemberCondition ? 1 : undefined
    const enterpriseConditionIndex = authorizationFence.enterpriseControlRevision === undefined
      ? undefined
      : 1 + workspaceMemberConditionItems.length
    try {
      await this.#documentClient.send(new TransactWriteCommand({
        TransactItems: [
          policyPut,
          ...workspaceMemberConditionItems,
          ...enterpriseConditionItems,
          createAuditTransactPut(auditTableName, auditEvent),
        ],
      }))
      return policy
    } catch (error) {
      if (
        (workspaceMemberConditionIndex !== undefined &&
          isTransactionConditionalFailureAt(error, workspaceMemberConditionIndex)) ||
        (enterpriseConditionIndex !== undefined &&
          isTransactionConditionalFailureAt(error, enterpriseConditionIndex))
      ) {
        throw new AiAssistanceError(
          'authorization',
          'AiAssistanceAuthorizationChanged',
          'AI assistance policy authorization is no longer current.',
        )
      }
      if (isTransactionConditionalFailureAt(error, 0)) {
        try {
          const currentItem = await this.#readPolicyItem(workspaceId)
          if (currentItem === undefined) throw revisionConflictError()
          const current = parseAiAssistancePolicy(currentItem.policy)
          if (isPolicyReplay(current, policy, expectedRevision, {
            expectedMutationFingerprint: mutationFingerprint,
            actualMutationFingerprint: currentItem.mutationFingerprint,
          })) return current
        } catch {
          // Preserve the compare-and-swap conflict when replay reconciliation is unavailable.
        }
        throw revisionConflictError()
      }
      const mappedError = mapDynamoWriteError(error)
      try {
        const currentItem = await this.#readPolicyItem(workspaceId)
        if (currentItem === undefined) throw mappedError
        const current = parseAiAssistancePolicy(currentItem.policy)
        if (isPolicyReplay(current, policy, expectedRevision, {
          expectedMutationFingerprint: mutationFingerprint,
          actualMutationFingerprint: currentItem.mutationFingerprint,
        })) return current
      } catch {
        // Preserve the original transaction error when reconciliation is unavailable.
      }
      throw mappedError
    }
  }

  /** Reads the current member preference with a strongly consistent read. */
  async getPreference(
    workspaceId: string,
    memberId: string,
  ): Promise<AiAssistancePreference | undefined> {
    const recordKey = createPreferenceRecordKey(memberId)
    const response = await this.#readItem(workspaceId, recordKey)
    if (!response.Item) return undefined
    const parsed = preferenceItemSchema.safeParse(response.Item)
    if (
      !parsed.success ||
      parsed.data.workspaceId !== workspaceId ||
      parsed.data.recordKey !== recordKey ||
      parsed.data.memberId !== memberId
    ) {
      throw invalidRecordError()
    }
    return parseAiAssistancePreference(parsed.data.preference)
  }

  /** Writes a current-member preference using revision-fenced compare-and-swap. */
  async putPreference(
    workspaceId: string,
    memberId: string,
    preference: AiAssistancePreference,
    expectedRevision: number,
  ): Promise<AiAssistancePreference> {
    try {
      await this.#putRevisionFencedItem(
        {
          workspaceId,
          recordKey: createPreferenceRecordKey(memberId),
          recordType: 'ai-assistance-preference',
          memberId,
          preference,
        },
        'preference',
        expectedRevision,
      )
      return preference
    } catch (error) {
      if (!isRevisionConflict(error)) throw error
      const current = await this.getPreference(workspaceId, memberId)
      if (current && isPreferenceReplay(current, preference, expectedRevision)) return current
      throw error
    }
  }

  /** Creates one generation exactly once. */
  async createGeneration(
    record: StoredAiAssistanceGeneration,
    commitFence?: AiAssistanceGenerationCommitFence,
  ): Promise<StoredAiAssistanceGeneration> {
    const recordKey = createGenerationRecordKey(record.generation.id)
    const item = createStoredGenerationItem(record, recordKey)
    requireStoredAiAssistanceItemSize(item)
    if (commitFence !== undefined) validateGenerationCommitFence(commitFence)
    if (
      commitFence !== undefined &&
      commitFence.authorizationToken !== record.authorizationToken
    ) {
      throw aiAssistanceAuthorizationChangedError(
        'AI assistance source authorization changed during generation.',
      )
    }
    try {
      if (commitFence === undefined) {
        await this.#documentClient.send(new PutCommand({
          TableName: this.#tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        }))
      } else {
        const authorizationConditionItems = createAiAssistanceAuthorizationConditionChecks(
          commitFence.authorizationConditions,
        )
        await this.#documentClient.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#tableName,
                Item: item,
                ConditionExpression:
                  'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
              },
            },
            createNestedRevisionConditionCheck(
              this.#tableName,
              record.workspaceId,
              POLICY_RECORD_KEY,
              'policy',
              commitFence.policyRevision,
            ),
            createNestedRevisionConditionCheck(
              this.#tableName,
              record.workspaceId,
              createPreferenceRecordKey(record.memberId),
              'preference',
              commitFence.preferenceRevision,
            ),
            ...authorizationConditionItems,
          ],
        }))
      }
      return record
    } catch (error) {
      if (
        commitFence !== undefined &&
        (isTransactionConditionalFailureAt(error, 1) ||
          isTransactionConditionalFailureAt(error, 2) ||
          isTransactionConditionalFailureAtOrAfter(error, 3))
      ) {
        throw aiAssistanceAuthorizationChangedError(
          'AI assistance policy or member preference changed during generation.',
        )
      }
      const mappedError = mapDynamoWriteError(error)
      try {
        const existing = await this.getGeneration(
          record.workspaceId,
          record.generation.id,
        )
        if (existing && isGenerationReplay(existing, record)) return existing
      } catch {
        // Preserve the original write error when the reconciliation read fails.
      }
      throw mappedError
    }
  }

  /** Strongly reads one generation and fails closed on malformed rows. */
  async getGeneration(
    workspaceId: string,
    generationId: string,
  ): Promise<StoredAiAssistanceGeneration | undefined> {
    const recordKey = createGenerationRecordKey(generationId)
    const response = await this.#readItem(workspaceId, recordKey)
    if (!response.Item) return undefined
    const parsed = baseStoredGenerationItemSchema.safeParse(response.Item)
    if (
      !parsed.success ||
      parsed.data.workspaceId !== workspaceId ||
      parsed.data.recordKey !== recordKey
    ) {
      throw invalidRecordError()
    }
    const generation = parseAiAssistanceGeneration(parsed.data.generation)
    if (generation.id !== generationId) throw invalidRecordError()
    return {
      workspaceId,
      memberId: parsed.data.memberId,
      generation,
      request: parseGenerateAiAssistanceRequest(parsed.data.request),
      authorizationToken: parsed.data.authorizationToken,
      auditedInput: parsed.data.auditedInput,
    }
  }

  /** Records one decision by revision, or replays an already durable identical outcome. */
  async decideGeneration(
    workspaceId: string,
    generationId: string,
    request: DecideAiAssistanceGenerationRequest,
    decidedAt: string,
    commitFence?: AiAssistanceDecisionCommitFence,
  ): Promise<StoredAiAssistanceGeneration> {
    if (commitFence !== undefined) validateDecisionCommitFence(commitFence, decidedAt)
    const current = await this.getGeneration(workspaceId, generationId)
    if (!current) {
      throw new AiAssistanceError(
        'not-found',
        'AiAssistanceGenerationNotFound',
        'The AI assistance generation was not found.',
      )
    }
    if (current.generation.decision?.outcome === request.outcome) {
      return current
    }
    if (current.generation.decision) {
      throw new AiAssistanceError(
        'conflict',
        'AiAssistanceDecisionAlreadyRecorded',
        'A decision has already been recorded for this generation.',
      )
    }
    if (current.generation.revision !== request.expectedRevision) {
      throw revisionConflictError()
    }
    const next: StoredAiAssistanceGeneration = {
      ...current,
      generation: {
        ...current.generation,
        revision: current.generation.revision + 1,
        decision: { outcome: request.outcome, decidedAt },
      },
    }
    const recordKey = createGenerationRecordKey(generationId)
    const item = createStoredGenerationItem(next, recordKey)
    requireStoredAiAssistanceItemSize(item)
    try {
      const generationPut = {
        Put: {
          TableName: this.#tableName,
          Item: item,
          ConditionExpression:
            '#generation.#revision = :expectedRevision AND ' +
            'attribute_not_exists(#generation.#decision)' +
            (commitFence === undefined
              ? ''
              : ' AND #authorizationToken = :authorizationToken AND ' +
                '#generation.#expiresAt > :commitAt'),
          ExpressionAttributeNames: {
            '#generation': 'generation',
            '#revision': 'revision',
            '#decision': 'decision',
            ...(commitFence === undefined
              ? {}
              : {
                  '#authorizationToken': 'authorizationToken',
                  '#expiresAt': 'expiresAt',
                }),
          },
          ExpressionAttributeValues: {
            ':expectedRevision': request.expectedRevision,
            ...(commitFence === undefined
              ? {}
              : {
                  ':authorizationToken': commitFence.authorizationToken,
                  ':commitAt': commitFence.commitAt,
                }),
          },
        },
      }
      if (commitFence === undefined) {
        await this.#documentClient.send(new PutCommand(generationPut.Put))
      } else {
        const authorizationConditionItems = createAiAssistanceAuthorizationConditionChecks(
          commitFence.authorizationConditions,
        )
        await this.#documentClient.send(new TransactWriteCommand({
          TransactItems: [
            generationPut,
            createNestedRevisionConditionCheck(
              this.#tableName,
              workspaceId,
              POLICY_RECORD_KEY,
              'policy',
              commitFence.policyRevision,
            ),
            createNestedRevisionConditionCheck(
              this.#tableName,
              workspaceId,
              createPreferenceRecordKey(current.memberId),
              'preference',
              commitFence.preferenceRevision,
            ),
            ...authorizationConditionItems,
          ],
        }))
      }
      return next
    } catch (error) {
      if (
        commitFence !== undefined &&
        (isTransactionConditionalFailureAt(error, 1) ||
          isTransactionConditionalFailureAt(error, 2) ||
          isTransactionConditionalFailureAtOrAfter(error, 3))
      ) {
        throw aiAssistanceAuthorizationChangedError(
          'AI assistance policy or member preference changed during decision.',
        )
      }
      const generationConditionFailed = isConditionalCheckFailed(error) ||
        (commitFence !== undefined && isTransactionConditionalFailureAt(error, 0))
      if (!generationConditionFailed) throw mapDynamoWriteError(error)
      let latest: StoredAiAssistanceGeneration | undefined
      try {
        latest = await this.getGeneration(workspaceId, generationId)
      } catch {
        // Preserve the original conditional conflict when reconciliation fails.
      }
      if (
        commitFence !== undefined &&
        latest !== undefined &&
        Date.parse(latest.generation.expiresAt) <= Date.parse(commitFence.commitAt)
      ) {
        throw new AiAssistanceError(
          'not-found',
          'AiAssistanceGenerationNotFound',
          'The AI assistance generation is no longer available for a decision.',
        )
      }
      if (
        commitFence !== undefined &&
        latest !== undefined &&
        latest.authorizationToken !== commitFence.authorizationToken
      ) {
        throw aiAssistanceAuthorizationChangedError(
          'AI assistance source authorization changed during decision.',
        )
      }
      if (latest?.generation.decision?.outcome === request.outcome) return latest
      throw revisionConflictError()
    }
  }

  /** Appends one immutable feedback item with inherited TTL. */
  async putFeedback(
    record: StoredAiAssistanceFeedback,
    commitFence?: AiAssistanceFeedbackCommitFence,
  ): Promise<void> {
    if (commitFence !== undefined) {
      validateFeedbackCommitFence(record, commitFence)
    }
    const recordKey = createFeedbackRecordKey(record.generationId, record.feedbackId)
    const feedbackPut = {
      Put: {
        TableName: this.#tableName,
        Item: {
          workspaceId: record.workspaceId,
          recordKey,
          recordType: 'ai-assistance-feedback',
          generationId: record.generationId,
          feedbackId: record.feedbackId,
          memberId: record.memberId,
          feedback: record.feedback,
          inputFingerprint: record.inputFingerprint,
          createdAt: record.createdAt,
          expiresAt: toTtlEpochSeconds(record.expiresAt),
        },
        ConditionExpression:
          'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      },
    }
    try {
      if (commitFence === undefined) {
        await this.#documentClient.send(new PutCommand(feedbackPut.Put))
      } else {
        await this.#documentClient.send(new TransactWriteCommand({
          TransactItems: [
            feedbackPut,
            createGenerationExpirationConditionCheck(
              this.#tableName,
              record.workspaceId,
              record.generationId,
              commitFence.commitAt,
            ),
            createNestedRevisionConditionCheck(
              this.#tableName,
              record.workspaceId,
              POLICY_RECORD_KEY,
              'policy',
              commitFence.policyRevision,
            ),
          ],
        }))
      }
    } catch (error) {
      if (
        commitFence !== undefined &&
        isTransactionConditionalFailureAt(error, 2)
      ) {
        throw aiAssistanceAuthorizationChangedError(
          'AI assistance retention policy changed during feedback.',
        )
      }
      if (
        commitFence !== undefined &&
        isTransactionConditionalFailureAt(error, 1)
      ) {
        throw new AiAssistanceError(
          'not-found',
          'AiAssistanceGenerationNotFound',
          'The AI assistance generation is no longer available for feedback.',
        )
      }
      const feedbackConditionFailed = isConditionalCheckFailed(error) ||
        (commitFence !== undefined && isTransactionConditionalFailureAt(error, 0))
      if (!feedbackConditionFailed) throw mapDynamoWriteError(error)
      const response = await this.#readItem(record.workspaceId, recordKey)
      const parsed = feedbackItemSchema.safeParse(response.Item)
      if (
        parsed.success &&
        parsed.data.workspaceId === record.workspaceId &&
        parsed.data.recordKey === recordKey &&
        parsed.data.memberId === record.memberId &&
        parsed.data.generationId === record.generationId &&
        parsed.data.feedbackId === record.feedbackId &&
        parsed.data.inputFingerprint === record.inputFingerprint
      ) {
        parseCreateAiAssistanceFeedbackRequest(parsed.data.feedback)
        return
      }
      throw idempotencyConflictError()
    }
  }

  /** Writes a policy or preference using its nested revision field. */
  async #putRevisionFencedItem(
    item: Record<string, unknown>,
    valueAttribute: 'policy' | 'preference',
    expectedRevision: number,
  ): Promise<void> {
    try {
      await this.#documentClient.send(new PutCommand({
        TableName: this.#tableName,
        Item: item,
        ConditionExpression: expectedRevision === 0
          ? 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)'
          : '#value.#revision = :expectedRevision',
        ...(expectedRevision === 0
          ? {}
          : {
              ExpressionAttributeNames: {
                '#value': valueAttribute,
                '#revision': 'revision',
              },
              ExpressionAttributeValues: {
                ':expectedRevision': expectedRevision,
              },
            }),
      }))
    } catch (error) {
      throw mapDynamoWriteError(error)
    }
  }
}

/**
 * Creates the physical preference key without trusting a client-supplied key.
 *
 * @param memberId - Canonical member identifier used for the preference row.
 * @returns The Workspace Search table record key for the member preference.
 */
export function createAiAssistancePreferenceRecordKey(memberId: string): string {
  return createPreferenceRecordKey(memberId)
}

/**
 * Creates the physical generation key without trusting a client-supplied key.
 *
 * @param generationId - Canonical generation identifier.
 * @returns The Workspace Search table record key for the generation row.
 */
export function createAiAssistanceGenerationRecordKey(generationId: string): string {
  return createGenerationRecordKey(generationId)
}

/**
 * Creates the physical generation receipt key while hashing the untrusted client key.
 *
 * @param memberId - Canonical member identifier that owns the receipt.
 * @param idempotencyKey - Client-supplied idempotency key to hash into the row key.
 * @returns The Workspace Search table record key for the idempotency receipt.
 */
export function createAiAssistanceIdempotencyRecordKey(
  memberId: string,
  idempotencyKey: string,
): string {
  return createIdempotencyRecordKey(memberId, idempotencyKey)
}

/** Creates a canonical preference record key. */
function createPreferenceRecordKey(memberId: string): string {
  return `${PREFERENCE_RECORD_PREFIX}${encodeURIComponent(requireMemberIdentifier(memberId))}`
}

/** Creates a canonical generation record key. */
function createGenerationRecordKey(generationId: string): string {
  return `${GENERATION_RECORD_PREFIX}${encodeURIComponent(requireIdentifier(generationId))}`
}

/** Creates a canonical immutable feedback record key. */
function createFeedbackRecordKey(generationId: string, feedbackId: string): string {
  return `${FEEDBACK_RECORD_PREFIX}${encodeURIComponent(requireIdentifier(generationId))}#${encodeURIComponent(requireIdentifier(feedbackId))}`
}

/** Creates a member-scoped idempotency key containing only a SHA-256 client-key digest. */
function createIdempotencyRecordKey(memberId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(requireIdentifier(idempotencyKey)).digest('hex')
  return `${IDEMPOTENCY_RECORD_PREFIX}${encodeURIComponent(requireMemberIdentifier(memberId))}#KEY#${digest}`
}

/** Creates a Workspace budget key for one exact UTC minute. */
function createWorkspaceBudgetRecordKey(windowStartedAt: number): string {
  return `${BUDGET_RECORD_PREFIX}${windowStartedAt}#WORKSPACE`
}

/** Creates a member budget key for one exact UTC minute. */
function createMemberBudgetRecordKey(
  windowStartedAt: number,
  memberId: string,
): string {
  return `${BUDGET_RECORD_PREFIX}${windowStartedAt}#MEMBER#${encodeURIComponent(requireMemberIdentifier(memberId))}`
}

/**
 * Creates one conditional counter update for the atomic generation reservation.
 *
 * @param input - Scope key, fixed window, conservative charge, and configured caps.
 * @returns DynamoDB transaction item that cannot exceed either cap.
 */
function createBudgetCounterTransactionItem(
  input: CreateBudgetCounterTransactionItemInput,
): AiAssistanceBudgetTransactionItem {
  return {
    Update: {
      TableName: input.tableName,
      Key: {
        workspaceId: input.workspaceId,
        recordKey: input.recordKey,
      },
      UpdateExpression:
        'SET #recordType = if_not_exists(#recordType, :recordType), ' +
        '#scopeKey = if_not_exists(#scopeKey, :scopeKey), ' +
        '#windowStartedAt = if_not_exists(#windowStartedAt, :windowStartedAt), ' +
        '#windowExpiresAt = if_not_exists(#windowExpiresAt, :windowExpiresAt), ' +
        '#expiresAt = if_not_exists(#expiresAt, :expiresAt) ' +
        'ADD #generationCount :one, #reservedTokens :reservedTokens',
      ConditionExpression:
        '(attribute_not_exists(#recordType) OR (' +
        '#recordType = :recordType AND #scopeKey = :scopeKey AND ' +
        '#windowStartedAt = :windowStartedAt AND #windowExpiresAt = :windowExpiresAt)) ' +
        'AND (attribute_not_exists(#generationCount) OR ' +
        '#generationCount <= :maximumPreviousGenerationCount) ' +
        'AND (attribute_not_exists(#reservedTokens) OR ' +
        '#reservedTokens <= :maximumPreviousReservedTokens)',
      ExpressionAttributeNames: {
        '#recordType': 'recordType',
        '#scopeKey': 'scopeKey',
        '#windowStartedAt': 'windowStartedAt',
        '#windowExpiresAt': 'windowExpiresAt',
        '#expiresAt': 'expiresAt',
        '#generationCount': 'generationCount',
        '#reservedTokens': 'reservedTokens',
      },
      ExpressionAttributeValues: {
        ':recordType': 'ai-assistance-generation-budget',
        ':scopeKey': input.scopeKey,
        ':windowStartedAt': input.windowStartedAt,
        ':windowExpiresAt': input.windowExpiresAt,
        ':expiresAt': Math.floor(input.windowExpiresAt / 1_000),
        ':one': 1,
        ':reservedTokens': input.reservedTokens,
        ':maximumPreviousGenerationCount': input.generationLimit - 1,
        ':maximumPreviousReservedTokens': input.tokenLimit - input.reservedTokens,
      },
    },
  }
}

/**
 * Validates one store-level budget reservation before constructing arithmetic expressions.
 *
 * @param input - Complete generation reservation input.
 * @param requestedAt - Parsed request instant in epoch milliseconds.
 * @param windowStartedAt - Parsed budget window start in epoch milliseconds.
 * @param windowExpiresAt - Parsed budget window end in epoch milliseconds.
 */
function validateBudgetReservation(
  input: ReserveAiAssistanceGenerationInput,
  requestedAt: number,
  windowStartedAt: number,
  windowExpiresAt: number,
): void {
  const values = [
    input.budget.reservedTokens,
    input.budget.workspaceGenerationLimit,
    input.budget.memberGenerationLimit,
    input.budget.workspaceTokenLimit,
    input.budget.memberTokenLimit,
  ]
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    windowStartedAt < 0 ||
    windowStartedAt % GENERATION_BUDGET_WINDOW_MS !== 0 ||
    windowExpiresAt - windowStartedAt !== GENERATION_BUDGET_WINDOW_MS ||
    requestedAt < windowStartedAt ||
    requestedAt >= windowExpiresAt ||
    input.budget.memberGenerationLimit > input.budget.workspaceGenerationLimit ||
    input.budget.memberTokenLimit > input.budget.workspaceTokenLimit ||
    input.budget.reservedTokens > input.budget.memberTokenLimit
  ) {
    throw invalidRecordError()
  }
}

/**
 * Validates the terminal attempt envelope before constructing a DynamoDB update.
 *
 * @param input - Attempt outcome and safe provider accounting metadata.
 */
function validateGenerationAttemptCompletion(
  input: FinalizeAiAssistanceGenerationAttemptInput,
): void {
  const hasUsage = input.usage !== undefined
  const hasUsageUnavailableReason = input.usageUnavailableReason !== undefined
  const hasFailure = input.failureCategory !== undefined && input.failureCode !== undefined
  const hasPartialFailure =
    (input.failureCategory === undefined) !== (input.failureCode === undefined)
  if (
    !Number.isSafeInteger(input.latencyMs) ||
    input.latencyMs < 0 ||
    !Number.isFinite(toEpochMilliseconds(input.endedAt)) ||
    hasUsage === hasUsageUnavailableReason ||
    (input.usage !== undefined && !aiAssistanceUsageSchema.safeParse(input.usage).success) ||
    (input.providerTraceId !== undefined && !input.providerTraceId.trim()) ||
    hasPartialFailure ||
    (input.outcome === 'succeeded' && (!hasUsage || hasFailure)) ||
    (input.outcome === 'failed' && !hasFailure) ||
    (input.failureCategory !== undefined &&
      !aiAssistanceErrorCategorySchema.safeParse(input.failureCategory).success) ||
    (input.failureCode !== undefined &&
      !aiAssistanceErrorCodeSchema.safeParse(input.failureCode).success)
  ) {
    throw invalidRecordError()
  }
}

/**
 * Creates a strictly bounded, defense-in-depth redacted attempt audit envelope.
 *
 * @param input - Application-provided request, context, and citations.
 * @returns Normalized evidence safe to retain on the attempt receipt.
 */
function createGenerationAttemptAuditEnvelope(
  input: AiAssistanceGenerationAttemptAuditEnvelope,
): AiAssistanceGenerationAttemptAuditEnvelope {
  try {
    const request = redactGenerateAiAssistanceRequest(
      parseGenerateAiAssistanceRequest(input.request),
    )
    const candidate = {
      request,
      auditedInput: redactAiAssistanceText(input.auditedInput),
      citations: input.citations.map((citation) =>
        redactAiAssistanceCitation(citation)),
    }
    const parsed = generationAttemptAuditSchema.safeParse(candidate)
    if (!parsed.success) throw invalidRecordError()
    return {
      request,
      auditedInput: parsed.data.auditedInput,
      citations: parsed.data.citations,
    }
  } catch {
    throw invalidRecordError()
  }
}

/** Returns whether a parsed receipt belongs to the exact reserved operation. */
function receiptIdentityMatches(
  receipt: z.infer<typeof idempotencyItemSchema>,
  input: CompleteAiAssistanceGenerationReservationInput,
  recordKey: string,
): boolean {
  return receipt.workspaceId === input.workspaceId &&
    receipt.recordKey === recordKey &&
    receipt.memberId === input.memberId &&
    receipt.inputFingerprint === input.inputFingerprint &&
    receipt.generationId === input.generationId
}

/** Returns whether a durable attempt is an exact replay of the provider start write. */
function generationAttemptStartMatches(
  value: unknown,
  expected: {
    task: StartAiAssistanceGenerationAttemptInput['task']
    modelId: string
    promptVersion: string
    traceId: string
    startedAt: string
    audit: AiAssistanceGenerationAttemptAuditEnvelope
  },
): boolean {
  const parsed = generationAttemptSchema.safeParse(value)
  return parsed.success &&
    parsed.data.status === 'started' &&
    parsed.data.task === expected.task &&
    parsed.data.modelId === expected.modelId &&
    parsed.data.promptVersion === expected.promptVersion &&
    parsed.data.traceId === expected.traceId &&
    parsed.data.startedAt === expected.startedAt &&
    equalJsonValues(parsed.data.audit, expected.audit)
}

/** Returns whether a receipt is the exact terminal outcome being finalized. */
function isFinalizedAttemptReceipt(
  value: unknown,
  input: FinalizeAiAssistanceGenerationAttemptInput,
  recordKey: string,
  receiptStatus: 'completed' | 'failed',
): boolean {
  const parsed = idempotencyItemSchema.safeParse(value)
  return parsed.success &&
    receiptIdentityMatches(parsed.data, input, recordKey) &&
    parsed.data.status === receiptStatus &&
    parsed.data.attempt?.status === input.outcome &&
    (input.outcome === 'succeeded' || (
      parsed.data.failureCategory === input.failureCategory &&
      parsed.data.failureCode === input.failureCode
    ))
}

/** Returns whether a receipt can safely receive the terminal CAS retry. */
function isPendingAttemptReceipt(
  value: unknown,
  input: FinalizeAiAssistanceGenerationAttemptInput,
  recordKey: string,
): boolean {
  const parsed = idempotencyItemSchema.safeParse(value)
  return parsed.success &&
    receiptIdentityMatches(parsed.data, input, recordKey) &&
    parsed.data.status === 'pending' &&
    parsed.data.attempt?.status === 'started'
}

/** Returns whether two JSON-compatible values contain the same fields and values. */
function equalJsonValues(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}

/** Returns whether a strongly read generation exactly matches an ambiguous write. */
function isGenerationReplay(
  current: StoredAiAssistanceGeneration,
  expected: StoredAiAssistanceGeneration,
): boolean {
  return equalJsonValues(current, expected)
}

/** Returns whether a citation target is an application-relative path without backslashes. */
function isSafeApplicationHref(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
}

/** Creates the exact DynamoDB generation item with a numeric TTL attribute. */
function createStoredGenerationItem(
  record: StoredAiAssistanceGeneration,
  recordKey: string,
): Record<string, unknown> {
  return {
    workspaceId: record.workspaceId,
    recordKey,
    recordType: 'ai-assistance-generation',
    memberId: record.memberId,
    generation: record.generation,
    request: record.request,
    authorizationToken: record.authorizationToken,
    auditedInput: record.auditedInput,
    expiresAt: toTtlEpochSeconds(record.generation.expiresAt),
  }
}

/**
 * Rejects an AI generation or attempt receipt before DynamoDB's 400 KiB hard limit.
 *
 * @param item - Exact document item passed to the DynamoDB document client.
 */
function requireStoredAiAssistanceItemSize(item: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(item)
  } catch {
    throw aiAssistanceItemSizeError()
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_GENERATION_SERIALIZED_BYTES) {
    throw aiAssistanceItemSizeError()
  }
}

/** Returns a stable persistence error without exposing the rejected row. */
function aiAssistanceItemSizeError(): AiAssistanceError {
  return new AiAssistanceError(
    'upstream',
    'AiAssistancePersistenceError',
    'AI assistance item exceeds the safe persistence size limit.',
  )
}

/** Converts an ISO retention deadline to DynamoDB TTL epoch seconds. */
function toTtlEpochSeconds(value: string): number {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw invalidRecordError()
  return Math.floor(milliseconds / 1_000)
}

/** Converts an ISO instant to an exact epoch-millisecond lease boundary. */
function toEpochMilliseconds(value: string): number {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw invalidRecordError()
  return milliseconds
}

/** Requires a bounded logical identifier before physical-key encoding. */
function requireIdentifier(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'AI assistance identifier is invalid.',
    )
  }
  return normalized
}

/** Requires a bounded canonical Workspace member identifier before physical-key encoding. */
function requireMemberIdentifier(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_MEMBER_IDENTIFIER_LENGTH) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'AI assistance member identifier is invalid.',
    )
  }
  return normalized
}

/** Maps a DynamoDB read failure to the stable persistence error contract. */
function mapDynamoReadError(error: unknown): AiAssistanceError {
  return new AiAssistanceError(
    'upstream',
    'AiAssistancePersistenceError',
    'AI assistance persistence read failed.',
    { cause: error },
  )
}

/** Maps conditional writes while keeping raw AWS error details behind the adapter boundary. */
function mapDynamoWriteError(error: unknown): AiAssistanceError {
  if (isConditionalCheckFailed(error)) {
    return revisionConflictError()
  }
  return new AiAssistanceError(
    'upstream',
    'AiAssistancePersistenceError',
    'AI assistance persistence failed.',
    { cause: error },
  )
}

/** Creates the stable conflict returned when a generation commit fence is stale. */
function aiAssistanceAuthorizationChangedError(message: string): AiAssistanceError {
  return new AiAssistanceError(
    'conflict',
    'AiAssistanceAuthorizationChanged',
    message,
  )
}

/** Validates the governance revisions and source authorization used for generation persistence. */
function validateGenerationCommitFence(
  fence: AiAssistanceGenerationCommitFence,
): void {
  if (
    !Number.isSafeInteger(fence.policyRevision) || fence.policyRevision < 0 ||
    !Number.isSafeInteger(fence.preferenceRevision) || fence.preferenceRevision < 0 ||
    !fence.authorizationToken.trim() || fence.authorizationToken.length > 8_192
  ) {
    throw aiAssistanceAuthorizationChangedError(
      'AI assistance policy, member preference, or source authorization is no longer current.',
    )
  }
}

/** Validates the policy revision and deadline captured for a decision write. */
function validateDecisionCommitFence(
  fence: AiAssistanceDecisionCommitFence,
  decidedAt: string,
): void {
  const expiresAt = Date.parse(fence.effectiveExpiresAt)
  const commitAt = Date.parse(fence.commitAt)
  if (
    !Number.isSafeInteger(fence.policyRevision) || fence.policyRevision < 0 ||
    !Number.isSafeInteger(fence.preferenceRevision) || fence.preferenceRevision < 0 ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(commitAt) ||
    new Date(expiresAt).toISOString() !== fence.effectiveExpiresAt ||
    new Date(commitAt).toISOString() !== fence.commitAt ||
    fence.commitAt !== decidedAt ||
    commitAt >= expiresAt ||
    !fence.authorizationToken.trim() || fence.authorizationToken.length > 8_192
  ) {
    throw aiAssistanceAuthorizationChangedError(
      'AI assistance retention policy is no longer current.',
    )
  }
}

/** Validates the policy revision and deadline captured for a feedback write. */
function validateFeedbackCommitFence(
  record: StoredAiAssistanceFeedback,
  fence: AiAssistanceFeedbackCommitFence,
): void {
  const expiresAt = Date.parse(fence.effectiveExpiresAt)
  const commitAt = Date.parse(fence.commitAt)
  const canonicalExpiresAt = Number.isFinite(expiresAt)
    ? new Date(expiresAt).toISOString()
    : undefined
  const canonicalCommitAt = Number.isFinite(commitAt)
    ? new Date(commitAt).toISOString()
    : undefined
  if (
    !Number.isSafeInteger(fence.policyRevision) || fence.policyRevision < 0 ||
    !Number.isFinite(expiresAt) || !Number.isFinite(commitAt) ||
    canonicalExpiresAt !== fence.effectiveExpiresAt ||
    canonicalCommitAt !== fence.commitAt ||
    commitAt >= expiresAt ||
    record.createdAt !== fence.commitAt ||
    record.expiresAt !== fence.effectiveExpiresAt
  ) {
    throw aiAssistanceAuthorizationChangedError(
      'AI assistance retention policy is no longer current.',
    )
  }
}

/** Builds a condition check that keeps feedback writes before its generation expires. */
function createGenerationExpirationConditionCheck(
  tableName: string,
  workspaceId: string,
  generationId: string,
  commitAt: string,
): AiAssistanceBudgetTransactionItem {
  const commitAtMilliseconds = Date.parse(commitAt)
  if (!Number.isFinite(commitAtMilliseconds)) {
    throw aiAssistanceAuthorizationChangedError(
      'AI assistance retention deadline is invalid.',
    )
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId,
        recordKey: createGenerationRecordKey(generationId),
      },
      ConditionExpression: '#generation.#expiresAt > :commitAt',
      ExpressionAttributeNames: {
        '#generation': 'generation',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':commitAt': commitAt,
      },
    },
  }
}

/** Builds a condition check for one nested policy or preference revision. */
function createNestedRevisionConditionCheck(
  tableName: string,
  workspaceId: string,
  recordKey: string,
  valueAttribute: 'policy' | 'preference',
  expectedRevision: number,
): AiAssistanceBudgetTransactionItem {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw aiAssistanceAuthorizationChangedError(
      'AI assistance policy or member preference is no longer current.',
    )
  }
  if (expectedRevision === 0) {
    return {
      ConditionCheck: {
        TableName: tableName,
        Key: { workspaceId, recordKey },
        ConditionExpression:
          'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      },
    }
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId, recordKey },
      ConditionExpression: '#value.#revision = :expectedRevision',
      ExpressionAttributeNames: {
        '#value': valueAttribute,
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':expectedRevision': expectedRevision,
      },
    },
  }
}

/**
 * Converts an application authorization condition into a DynamoDB transaction check.
 *
 * @param condition - Source-of-truth row and exact attributes captured by the resolver.
 * @returns A conditional transaction item that fails closed when the row changed or disappeared.
 */
function createAiAssistanceAuthorizationConditionCheck(
  condition: AiAssistanceAuthorizationCondition,
): AiAssistanceBudgetTransactionItem {
  if (
    !condition.tableName.trim() ||
    Object.keys(condition.key).length === 0 ||
    Object.keys(condition.expectedAttributes).length === 0
  ) {
    throw aiAssistanceAuthorizationChangedError(
      'AI assistance source authorization condition is invalid.',
    )
  }
  const keyEntries = Object.entries(condition.key)
  if (keyEntries.some(([, value]) => !value.trim())) {
    throw aiAssistanceAuthorizationChangedError(
      'AI assistance source authorization condition is invalid.',
    )
  }
  const expectedEntries = Object.entries(condition.expectedAttributes)
    .sort(([left], [right]) => left.localeCompare(right))
  const expressionAttributeNames = Object.fromEntries(
    expectedEntries.map(([attribute], index) => [`#authorization${index}`, attribute]),
  )
  const expressionAttributeValues = Object.fromEntries(
    expectedEntries.map(([, value], index) => [`:authorization${index}`, value]),
  )
  const expectedExpression = expectedEntries
    .map((_, index) => `#authorization${index} = :authorization${index}`)
    .join(' AND ')
  const missingKeyAttribute = keyEntries
    .map(([attribute]) => attribute)
    .sort()[0]
  if (condition.allowMissingWhenExpectedZero && missingKeyAttribute !== undefined) {
    expressionAttributeNames['#authorizationKey'] = missingKeyAttribute
  }
  const conditionExpression = condition.allowMissingWhenExpectedZero
    ? `(attribute_not_exists(#authorizationKey) OR (${expectedExpression}))`
    : expectedExpression
  return {
    ConditionCheck: {
      TableName: condition.tableName,
      Key: { ...condition.key },
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    },
  }
}

/** Creates all source-of-truth checks while preserving resolver order. */
function createAiAssistanceAuthorizationConditionChecks(
  conditions: readonly AiAssistanceAuthorizationCondition[] | undefined,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  if (conditions === undefined) return []
  const seen = new Set<string>()
  return conditions.flatMap((condition) => {
    const key = `${condition.tableName}:${JSON.stringify(condition.key)}`
    if (seen.has(key)) return []
    seen.add(key)
    return [createAiAssistanceAuthorizationConditionCheck(condition)]
  })
}

/** Validates the server-owned policy authorization values before building conditions. */
function validatePolicyAuthorizationFence(
  fence: AiAssistancePolicyAuthorizationFence,
): void {
  const principalKind = fence.principalKind ?? 'member'
  if (
    !Number.isSafeInteger(fence.workspaceMemberVersion) ||
    fence.workspaceMemberVersion < 0 ||
    !fence.workspaceRole.trim() ||
    !['member', 'service-account', 'break-glass'].includes(principalKind) ||
    (fence.enterpriseControlRevision !== undefined && (
      !Number.isSafeInteger(fence.enterpriseControlRevision) ||
      fence.enterpriseControlRevision < 0
    )) ||
    (principalKind !== 'member' && fence.enterpriseControlRevision === undefined)
  ) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceAuthorizationChanged',
      'AI assistance policy authorization is no longer current.',
    )
  }
}

/** Builds the active Workspace member condition used by a policy CAS transaction. */
function createWorkspaceMemberAuthorizationCondition(
  tableName: string,
  workspaceId: string,
  memberId: string,
  fence: AiAssistancePolicyAuthorizationFence,
): AiAssistanceBudgetTransactionItem {
  const normalizedMemberId = memberId.trim().toLowerCase()
  if (!normalizedMemberId || !normalizedMemberId.includes('@')) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceAuthorizationChanged',
      'AI assistance policy authorization is no longer current.',
    )
  }
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId, recordKey: `MEMBER#${normalizedMemberId}` },
      ConditionExpression:
        '#entryType = :memberEntryType AND #status = :active AND ' +
        '#memberKey = :memberKey AND #role = :role AND #version = :version',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#status': 'status',
        '#memberKey': 'memberKey',
        '#role': 'role',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':memberEntryType': 'workspace-member',
        ':active': 'active',
        ':memberKey': normalizedMemberId,
        ':role': fence.workspaceRole,
        ':version': fence.workspaceMemberVersion,
      },
    },
  }
}

/** Builds the optional Enterprise CONTROL revision condition for a policy CAS. */
function createEnterpriseControlAuthorizationCondition(
  tableName: string | undefined,
  workspaceId: string,
  controlRevision: number,
): AiAssistanceBudgetTransactionItem {
  if (tableName === undefined) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceAuthorizationChanged',
      'AI assistance Enterprise authorization is no longer current.',
    )
  }
  const names: Record<string, string> = {
    '#entryType': 'entryType',
    '#controlRevision': 'controlRevision',
  }
  const conditionExpression = controlRevision === 0
    ? '(attribute_not_exists(#scopeKey) OR (#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision))'
    : '#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision'
  if (controlRevision === 0) names['#scopeKey'] = 'scopeKey'
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' },
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ':controlEntryType': 'enterprise-identity-control',
        ':expectedControlRevision': controlRevision,
      },
    },
  }
}

/** Returns whether DynamoDB rejected a conditional compare-and-swap. */
function isConditionalCheckFailed(error: unknown): boolean {
  return readErrorName(error) === 'ConditionalCheckFailedException'
}

/** Returns whether a specific transaction item rejected its budget/idempotency condition. */
function isTransactionConditionalFailureAt(
  error: unknown,
  index: number,
): boolean {
  if (readErrorName(error) !== 'TransactionCanceledException') return false
  if (typeof error !== 'object' || error === null) return false
  const reasons = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  const reason = reasons[index]
  if (typeof reason !== 'object' || reason === null) return false
  return Reflect.get(reason, 'Code') === 'ConditionalCheckFailed'
}

/** Returns whether any transaction condition at or after an index failed. */
function isTransactionConditionalFailureAtOrAfter(
  error: unknown,
  startIndex: number,
): boolean {
  if (readErrorName(error) !== 'TransactionCanceledException') return false
  if (typeof error !== 'object' || error === null) return false
  const reasons = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  return reasons.some((reason, index) =>
    index >= startIndex &&
    typeof reason === 'object' &&
    reason !== null &&
    Reflect.get(reason, 'Code') === 'ConditionalCheckFailed'
  )
}

/** Returns whether an adapter error is the stable revision compare-and-swap conflict. */
function isRevisionConflict(error: unknown): boolean {
  return error instanceof AiAssistanceError &&
    error.code === 'AiAssistanceRevisionConflict'
}

/** Returns whether a policy write is a response-loss replay of the previous mutation. */
function isPolicyReplay(
  current: AiAssistancePolicy,
  desired: AiAssistancePolicy,
  expectedRevision: number,
  identity?: {
    expectedMutationFingerprint: string
    actualMutationFingerprint?: string
  },
): boolean {
  if (
    identity !== undefined &&
    identity.actualMutationFingerprint !== identity.expectedMutationFingerprint
  ) return false
  return current.revision === expectedRevision + 1 &&
    current.enabled === desired.enabled &&
    current.defaultModelId === desired.defaultModelId &&
    current.retentionDays === desired.retentionDays &&
    equalStrings(current.allowedModelIds, desired.allowedModelIds) &&
    equalStrings(current.enabledTasks, desired.enabledTasks)
}

/** Creates the actor-bound identity used to recognize an audited policy replay. */
function createPolicyMutationFingerprint(input: {
  workspaceId: string
  memberId: string
  actorUserId: string
  expectedRevision: number
  policy: AiAssistancePolicy
}): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    actorUserId: input.actorUserId,
    expectedRevision: input.expectedRevision,
    policy: {
      schemaVersion: input.policy.schemaVersion,
      enabled: input.policy.enabled,
      allowedModelIds: input.policy.allowedModelIds,
      defaultModelId: input.policy.defaultModelId,
      enabledTasks: input.policy.enabledTasks,
      retentionDays: input.policy.retentionDays,
      revision: input.policy.revision,
    },
  })).digest('hex')
}

/** Returns whether a preference write is a response-loss replay of the previous mutation. */
function isPreferenceReplay(
  current: AiAssistancePreference,
  desired: AiAssistancePreference,
  expectedRevision: number,
): boolean {
  return current.revision === expectedRevision + 1 && current.enabled === desired.enabled
}

/** Compares ordered string-valued contract arrays without coercion. */
function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Safely reads an Error-like name without trusting the thrown value. */
function readErrorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = Reflect.get(error, 'name')
  return typeof value === 'string' ? value : undefined
}

/** Creates the stable revision conflict returned by every CAS write. */
function revisionConflictError(): AiAssistanceError {
  return new AiAssistanceError(
    'conflict',
    'AiAssistanceRevisionConflict',
    'The AI assistance record changed before the update was applied.',
  )
}

/** Creates the fail-closed error returned for malformed persistence rows. */
function invalidRecordError(): AiAssistanceError {
  return new AiAssistanceError(
    'upstream',
    'InvalidAiAssistanceRecord',
    'The AI assistance record is invalid.',
  )
}

/** Creates the stable conflict for a key reused with different ownership or input. */
function idempotencyConflictError(): AiAssistanceError {
  return new AiAssistanceError(
    'conflict',
    'AiAssistanceIdempotencyConflict',
    'The AI assistance idempotency reservation no longer matches this request.',
  )
}

/** Creates the stable transport-safe error returned when either fixed-window cap is full. */
function generationBudgetExceededError(): AiAssistanceError {
  return new AiAssistanceError(
    'rate-limit',
    'AiAssistanceRateLimitExceeded',
    'AI assistance generation capacity is exhausted for this one-minute window.',
  )
}
