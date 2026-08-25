import { createHash } from 'node:crypto'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistanceDraft,
  type AiAssistanceGeneration,
  type AiAssistancePolicy,
  type AiAssistancePreference,
  type AiAssistanceTask,
  type CreateAiAssistanceFeedbackRequest,
  type DecideAiAssistanceGenerationRequest,
  type GenerateAiAssistanceRequest,
  type UpdateAiAssistancePolicyRequest,
  type UpdateAiAssistancePreferenceRequest,
  type WorkItemDependencyEndpoint,
} from '@mukuroji/contracts'
import {
  AiAssistanceError,
  type AiAssistanceErrorCategory,
  type AiAssistanceErrorCode,
} from '../../errors'
import {
  aliasAiAssistanceTextIdentifiers,
  createAiAssistancePrivateTextAliases,
  redactAiAssistanceCitation,
  redactAiAssistanceDraft,
  redactAiAssistanceText,
  redactAiAssistanceUncertainty,
  redactGenerateAiAssistanceRequest,
  type AiAssistanceTextAlias,
} from '../../domain/ai-assistance-redaction'
import {
  parseAiAssistanceModelOutput,
  parseCreateAiAssistanceFeedbackRequest,
  parseDecideAiAssistanceGenerationRequest,
  parseGenerateAiAssistanceRequest,
  parseUpdateAiAssistancePolicyRequest,
  parseUpdateAiAssistancePreferenceRequest,
} from '../validation/ai-assistance-schema'
import type {
  AiAssistanceActor,
  AiAssistanceAllowedValues,
  AiAssistanceAuthorizationCallbacks,
  AiAssistanceGenerationBudgetReservation,
  AiAssistancePrivateMemberIdentifiers,
  AiModelGenerationResult,
  AiAssistanceService,
  AiAssistanceServiceOptions,
  ResolvedAiAssistanceContext,
  StoredAiAssistanceGeneration,
} from '../ports/ai-assistance-ports'

const DEFAULT_MAX_PROMPT_CONTEXT_CHARACTERS = 100_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const DEFAULT_PROVIDER_TIMEOUT_MS = 12_000
const DEFAULT_RESERVATION_LEASE_MS = 30_000
const GENERATION_BUDGET_WINDOW_MS = 60_000
const DEFAULT_WORKSPACE_GENERATION_LIMIT_PER_MINUTE = 32
const DEFAULT_MEMBER_GENERATION_LIMIT_PER_MINUTE = 4
const DEFAULT_WORKSPACE_TOKEN_LIMIT_PER_MINUTE = 32_000_000
const DEFAULT_MEMBER_TOKEN_LIMIT_PER_MINUTE = 4_000_000
const DEFAULT_WORST_CASE_TOKENS_PER_GENERATION = 1_000_000
const DEFAULT_PREFERENCE_UPDATED_AT = '1970-01-01T00:00:00.000Z'
const MAX_STORED_GENERATION_SERIALIZED_BYTES = 350 * 1_024
const GENERATION_STORAGE_ENVELOPE_HEADROOM_BYTES = 16 * 1_024
const STRUCTURED_OUTPUT_UTF8_BYTES_PER_TOKEN = 64
const RETENTION_DAY_MS = 24 * 60 * 60 * 1_000
const MAX_PRIVATE_MEMBER_IDENTIFIER_GROUPS = 1_000
const PRIVATE_MEMBER_PROVIDER_ALIAS_PATTERN = /^U_[A-Za-z0-9_]{4,94}$/u

/** Validated fixed-window generation limits used by the reservation boundary. */
type GenerationBudgetConfiguration = {
  /** Maximum unique Workspace generation keys accepted per minute. */
  workspaceGenerationLimitPerMinute: number
  /** Maximum unique member generation keys accepted per minute. */
  memberGenerationLimitPerMinute: number
  /** Maximum Workspace token reservations accepted per minute. */
  workspaceTokenLimitPerMinute: number
  /** Maximum member token reservations accepted per minute. */
  memberTokenLimitPerMinute: number
  /** Conservative token reservation charged for one unique key. */
  worstCaseTokensPerGeneration: number
}

/** Generation budget configuration together with the provider output bound. */
type GenerationBudgetValidationInput = GenerationBudgetConfiguration & {
  /** Maximum provider output tokens configured for a call. */
  maxOutputTokens: number
}

/**
 * Creates the application service that owns AI generation policy and authorization fences.
 *
 * @param options - Model, persistence, deployment policy, and deterministic test hooks.
 * @returns AI assistance application service.
 */
export function createAiAssistanceService(
  options: AiAssistanceServiceOptions,
): AiAssistanceService {
  const deploymentAllowedModelIds = new Set(options.deploymentAllowedModelIds)
  const maxPromptContextCharacters = options.maxPromptContextCharacters ??
    DEFAULT_MAX_PROMPT_CONTEXT_CHARACTERS
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
  const reservationLeaseMs = options.reservationLeaseMs ?? Math.max(
    DEFAULT_RESERVATION_LEASE_MS,
    providerTimeoutMs + 5_000,
  )
  const workspaceGenerationLimitPerMinute =
    options.workspaceGenerationLimitPerMinute ??
      DEFAULT_WORKSPACE_GENERATION_LIMIT_PER_MINUTE
  const memberGenerationLimitPerMinute =
    options.memberGenerationLimitPerMinute ??
      DEFAULT_MEMBER_GENERATION_LIMIT_PER_MINUTE
  const workspaceTokenLimitPerMinute = options.workspaceTokenLimitPerMinute ??
    DEFAULT_WORKSPACE_TOKEN_LIMIT_PER_MINUTE
  const memberTokenLimitPerMinute = options.memberTokenLimitPerMinute ??
    DEFAULT_MEMBER_TOKEN_LIMIT_PER_MINUTE
  const worstCaseTokensPerGeneration = options.worstCaseTokensPerGeneration ??
    DEFAULT_WORST_CASE_TOKENS_PER_GENERATION
  const now = options.now ?? (() => new Date())
  const createId = options.createId ?? (() => crypto.randomUUID())

  if (!Number.isSafeInteger(reservationLeaseMs) || reservationLeaseMs <= providerTimeoutMs) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'The AI assistance reservation lease must exceed the provider timeout.',
    )
  }
  validateGenerationBudgetConfiguration({
    workspaceGenerationLimitPerMinute,
    memberGenerationLimitPerMinute,
    workspaceTokenLimitPerMinute,
    memberTokenLimitPerMinute,
    worstCaseTokensPerGeneration,
    maxOutputTokens,
  })

  validateEffectivePolicy(options.defaultPolicy, deploymentAllowedModelIds)

  /** Reads the explicit or deployment-default Workspace policy. */
  async function getPolicy(actor: AiAssistanceActor): Promise<AiAssistancePolicy> {
    return await options.store.getPolicy(actor.workspaceId) ?? options.defaultPolicy
  }

  /** Persists a manager-authorized Workspace policy update. */
  async function updatePolicy(
    actor: AiAssistanceActor,
    input: UpdateAiAssistancePolicyRequest,
  ): Promise<AiAssistancePolicy> {
    if (!actor.canManagePolicy) {
      throw new AiAssistanceError(
        'authorization',
        'AiAssistanceDisabled',
        'The current operator cannot manage AI assistance policy.',
      )
    }
    const request = parseUpdateAiAssistancePolicyRequest(input)
    const policy: AiAssistancePolicy = {
      schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
      enabled: request.enabled,
      allowedModelIds: [...request.allowedModelIds],
      defaultModelId: request.defaultModelId,
      enabledTasks: [...request.enabledTasks],
      retentionDays: request.retentionDays,
      revision: request.expectedRevision + 1,
      updatedAt: now().toISOString(),
    }
    validateEffectivePolicy(policy, deploymentAllowedModelIds)
    return await options.store.putPolicy(actor.workspaceId, policy, request.expectedRevision)
  }

  /** Reads the explicit or default-enabled current-member preference. */
  async function getPreference(
    actor: AiAssistanceActor,
  ): Promise<AiAssistancePreference> {
    return await options.store.getPreference(actor.workspaceId, actor.memberId) ?? {
      schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
      enabled: true,
      revision: 0,
      updatedAt: DEFAULT_PREFERENCE_UPDATED_AT,
    }
  }

  /** Persists the current member's revision-fenced preference. */
  async function updatePreference(
    actor: AiAssistanceActor,
    input: UpdateAiAssistancePreferenceRequest,
  ): Promise<AiAssistancePreference> {
    const request = parseUpdateAiAssistancePreferenceRequest(input)
    return await options.store.putPreference(
      actor.workspaceId,
      actor.memberId,
      {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        enabled: request.enabled,
        revision: request.expectedRevision + 1,
        updatedAt: now().toISOString(),
      },
      request.expectedRevision,
    )
  }

  /** Generates one permission-fenced structured draft. */
  async function generate(
    actor: AiAssistanceActor,
    input: GenerateAiAssistanceRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
    idempotencyKeyValue: string,
  ): Promise<AiAssistanceGeneration> {
    const request = parseGenerateAiAssistanceRequest(input)
    const [policy, preference] = await Promise.all([
      getPolicy(actor),
      getPreference(actor),
    ])
    requireGenerationEnabled(policy, preference, request.task)
    const modelId = selectModelId(request.modelId, policy, deploymentAllowedModelIds)
    const createdAt = now()
    const generationId = createId()
    const expiresAt = new Date(
      createdAt.getTime() + policy.retentionDays * RETENTION_DAY_MS,
    )
    const leaseExpiresAt = new Date(createdAt.getTime() + reservationLeaseMs)
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
    const inputFingerprint = createGenerationInputFingerprint(
      actor,
      request,
      modelId,
      options.promptVersion,
    )
    const reservation = await options.store.reserveGeneration({
      workspaceId: actor.workspaceId,
      memberId: actor.memberId,
      idempotencyKey,
      inputFingerprint,
      generationId,
      requestedAt: createdAt.toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      budget: createGenerationBudgetReservation(createdAt, {
        workspaceGenerationLimitPerMinute,
        memberGenerationLimitPerMinute,
        workspaceTokenLimitPerMinute,
        memberTokenLimitPerMinute,
        worstCaseTokensPerGeneration,
      }),
    })
    const completion = {
      workspaceId: actor.workspaceId,
      memberId: actor.memberId,
      idempotencyKey,
      inputFingerprint,
      generationId: reservation.generationId,
    }
    if (reservation.status === 'failed') {
      throw createSafeAttemptError(
        reservation.failureCategory,
        reservation.failureCode,
      )
    }
    if (reservation.status !== 'reserved') {
      const existing = await options.store.getGeneration(
        actor.workspaceId,
        reservation.generationId,
      )
      if (existing) {
        if (existing.memberId !== actor.memberId) {
          throw new AiAssistanceError(
            'upstream',
            'InvalidAiAssistanceRecord',
            'The AI assistance idempotency receipt references an invalid generation.',
          )
        }
        if (reservation.status === 'pending') {
          await options.store.finalizeGenerationAttempt({
            ...completion,
            outcome: 'succeeded',
            endedAt: now().toISOString(),
            latencyMs: existing.generation.details.usage.latencyMs,
            usage: existing.generation.details.usage,
          })
        }
        return await projectStoredGeneration(actor, existing, policy, authorization, now)
      }
      if (reservation.status === 'pending') {
        throw new AiAssistanceError(
          'conflict',
          'AiAssistanceGenerationInProgress',
          'An AI assistance generation with this idempotency key is in progress.',
        )
      }
      throw new AiAssistanceError(
        'upstream',
        'InvalidAiAssistanceRecord',
        'The completed AI assistance receipt has no generation.',
      )
    }

    let generationPersisted = false
    let attemptStartedAt: Date | undefined
    let modelResult: AiModelGenerationResult | undefined
    try {
      const resolvedContext = await authorization.resolveContext({ actor, request })
      validateResolvedContext(resolvedContext, maxPromptContextCharacters)
      const privateIdentifierAliases = createPrivateIdentifierAliases(
        resolvedContext.allowedValues,
        resolvedContext.privateMemberIdentifiers,
      )
      const aliasText = (value: string) => aliasAiAssistanceTextIdentifiers(
        value,
        privateIdentifierAliases.textAliases,
      )
      const context: ResolvedAiAssistanceContext = {
        ...resolvedContext,
        promptContext: redactAiAssistanceText(aliasText(resolvedContext.promptContext)),
        citations: resolvedContext.citations.map((citation) =>
          redactAiAssistanceCitation(citation, privateIdentifierAliases.textAliases)),
      }
      validateResolvedContext(context, maxPromptContextCharacters)
      const providerRequest = redactGenerateAiAssistanceRequest(
        request,
        privateIdentifierAliases.textAliases,
      )
      requireGenerationPersistenceBudget({
        workspaceId: actor.workspaceId,
        memberId: actor.memberId,
        generation: {
          schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
          id: reservation.generationId,
          task: request.task,
          revision: 1,
          content: {
            availability: 'available',
            citations: context.citations,
          },
          details: {
            provider: 'bedrock',
            modelId,
            promptVersion: options.promptVersion,
            traceId: actor.traceId,
          },
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        request: providerRequest,
        authorizationToken: context.authorizationToken,
        auditedInput: context.promptContext,
      }, maxOutputTokens)
      const providerStartedAt = now()
      await options.store.startGenerationAttempt({
        ...completion,
        task: request.task,
        modelId,
        promptVersion: options.promptVersion,
        traceId: actor.traceId,
        startedAt: providerStartedAt.toISOString(),
        audit: {
          request: providerRequest,
          auditedInput: context.promptContext,
          citations: [...context.citations],
        },
      })
      attemptStartedAt = providerStartedAt
      modelResult = await options.gateway.generate({
        modelId,
        task: request.task,
        locale: request.locale,
        promptVersion: options.promptVersion,
        request: providerRequest,
        promptContext: context.promptContext,
        citations: context.citations,
        allowedValues: privateIdentifierAliases.modelAllowedValues,
        traceId: actor.traceId,
        maxOutputTokens,
        timeoutMs: providerTimeoutMs,
      })
      const output = parseAiAssistanceModelOutput({
        draft: modelResult.draft,
        uncertainty: modelResult.uncertainty,
      })
      const aliasedDraft = redactAiAssistanceDraft(
        output.draft,
        privateIdentifierAliases.textAliases,
      )
      const aliasedUncertainty = redactAiAssistanceUncertainty(
        output.uncertainty,
        privateIdentifierAliases.textAliases,
      )
      validateDraftForTask(aliasedDraft, request.task)
      validateDraftReferences(aliasedDraft, {
        ...context,
        allowedValues: privateIdentifierAliases.modelAllowedValues,
      })
      const authorizationState = await authorization.isAuthorizationCurrent({
        actor,
        request: providerRequest,
        authorizationToken: context.authorizationToken,
      })
      if (!authorizationState.current) {
        throw authorizationChangedError(authorizationState.reason)
      }
      const safeDraft = redactAiAssistanceDraft(restorePrivateIdentifiers(
        aliasedDraft,
        privateIdentifierAliases,
      ), privateIdentifierAliases.disclosureTextAliases)
      const safeUncertainty = redactAiAssistanceUncertainty(
        aliasedUncertainty,
        privateIdentifierAliases.disclosureTextAliases,
      )
      const disclosureCitations = context.citations.map((citation) =>
        redactAiAssistanceCitation(
          citation,
          privateIdentifierAliases.disclosureTextAliases,
        ))
      validateDraftReferences(safeDraft, context)

      const generation: AiAssistanceGeneration = {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        id: reservation.generationId,
        task: request.task,
        revision: 1,
        content: {
          availability: 'available',
          draft: safeDraft,
          citations: disclosureCitations,
          uncertainty: safeUncertainty,
        },
        details: {
          provider: 'bedrock',
          modelId,
          promptVersion: options.promptVersion,
          traceId: modelResult.providerTraceId ?? actor.traceId,
          usage: modelResult.usage,
        },
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }
      const stored = await options.store.createGeneration({
        workspaceId: actor.workspaceId,
        memberId: actor.memberId,
        generation,
        request: providerRequest,
        authorizationToken: context.authorizationToken,
        auditedInput: context.promptContext,
      })
      generationPersisted = true
      await options.store.finalizeGenerationAttempt({
        ...completion,
        outcome: 'succeeded',
        endedAt: now().toISOString(),
        latencyMs: modelResult.usage.latencyMs,
        usage: modelResult.usage,
        ...(modelResult.providerTraceId === undefined
          ? {}
          : { providerTraceId: modelResult.providerTraceId }),
      })
      return stored.generation
    } catch (error) {
      const safeError = toSafeAttemptError(error)
      if (!generationPersisted) {
        const failedAt = now()
        if (attemptStartedAt) {
          await options.store.finalizeGenerationAttempt({
            ...completion,
            outcome: 'failed',
            endedAt: failedAt.toISOString(),
            latencyMs: modelResult?.usage.latencyMs ?? Math.max(
              0,
              Math.round(failedAt.getTime() - attemptStartedAt.getTime()),
            ),
            ...(modelResult?.usage === undefined
              ? { usageUnavailableReason: 'provider-did-not-report' }
              : { usage: modelResult.usage }),
            ...(modelResult?.providerTraceId === undefined
              ? {}
              : { providerTraceId: modelResult.providerTraceId }),
            failureCategory: safeError.category,
            failureCode: safeError.code,
          })
        } else {
          await options.store.failGenerationReservation({
            ...completion,
            failedAt: failedAt.toISOString(),
            failureCategory: safeError.category,
            failureCode: safeError.code,
          })
        }
      }
      throw safeError
    }
  }

  /** Reads one owner-scoped generation and rechecks disclosure authorization. */
  async function getGeneration(
    actor: AiAssistanceActor,
    generationId: string,
    authorization: AiAssistanceAuthorizationCallbacks,
  ): Promise<AiAssistanceGeneration> {
    const [record, policy] = await Promise.all([
      requireOwnedGeneration(actor, generationId, options.store.getGeneration),
      getPolicy(actor),
    ])
    return await projectStoredGeneration(actor, record, policy, authorization, now)
  }

  /** Records one owner-scoped decision, replaying the same outcome despite a stale revision. */
  async function decideGeneration(
    actor: AiAssistanceActor,
    generationId: string,
    input: DecideAiAssistanceGenerationRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
  ): Promise<AiAssistanceGeneration> {
    const request = parseDecideAiAssistanceGenerationRequest(input)
    const [record, policy] = await Promise.all([
      requireOwnedGeneration(actor, generationId, options.store.getGeneration),
      getPolicy(actor),
    ])
    const effectiveGeneration = applyEffectiveRetention(record.generation, policy)
    if (Date.parse(effectiveGeneration.expiresAt) <= now().getTime()) {
      return withholdGeneration(effectiveGeneration, 'retention-expired')
    }
    if (record.generation.decision?.outcome === request.outcome) {
      return await projectStoredGeneration(actor, record, policy, authorization, now)
    }
    if (record.generation.decision) {
      throw new AiAssistanceError(
        'conflict',
        'AiAssistanceDecisionAlreadyRecorded',
        'A decision has already been recorded for this generation.',
      )
    }
    const authorizationState = await authorization.isAuthorizationCurrent({
      actor,
      request: record.request,
      authorizationToken: record.authorizationToken,
    })
    if (!authorizationState.current) {
      throw authorizationChangedError(authorizationState.reason)
    }
    const decided = await options.store.decideGeneration(
      actor.workspaceId,
      generationId,
      request,
      now().toISOString(),
    )
    return applyEffectiveRetention(decided.generation, policy)
  }

  /** Appends owner-scoped bounded feedback without exposing source content. */
  async function createFeedback(
    actor: AiAssistanceActor,
    generationId: string,
    input: CreateAiAssistanceFeedbackRequest,
    idempotencyKeyValue: string,
  ): Promise<void> {
    const parsedFeedback = parseCreateAiAssistanceFeedbackRequest(input)
    const feedback: CreateAiAssistanceFeedbackRequest = {
      rating: parsedFeedback.rating,
      ...(parsedFeedback.comment === undefined
        ? {}
        : { comment: redactAiAssistanceText(parsedFeedback.comment) }),
    }
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
    const feedbackIdentity = createFeedbackIdentity(
      actor,
      generationId,
      feedback,
      idempotencyKey,
    )
    const record = await requireOwnedGeneration(actor, generationId, options.store.getGeneration)
    await options.store.putFeedback({
      workspaceId: actor.workspaceId,
      feedbackId: feedbackIdentity.feedbackId,
      generationId,
      memberId: actor.memberId,
      feedback,
      inputFingerprint: feedbackIdentity.inputFingerprint,
      createdAt: now().toISOString(),
      expiresAt: record.generation.expiresAt,
    })
  }

  return {
    getPolicy,
    updatePolicy,
    getPreference,
    updatePreference,
    generate,
    getGeneration,
    decideGeneration,
    createFeedback,
  }
}

/**
 * Validates deployment budget limits before any request can reach persistence.
 *
 * @param input - Fixed-window request/token caps and the provider output cap.
 */
function validateGenerationBudgetConfiguration(
  input: GenerationBudgetValidationInput,
): void {
  const values = [
    input.workspaceGenerationLimitPerMinute,
    input.memberGenerationLimitPerMinute,
    input.workspaceTokenLimitPerMinute,
    input.memberTokenLimitPerMinute,
    input.worstCaseTokensPerGeneration,
    input.maxOutputTokens,
  ]
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    input.memberGenerationLimitPerMinute > input.workspaceGenerationLimitPerMinute ||
    input.memberTokenLimitPerMinute > input.workspaceTokenLimitPerMinute ||
    input.worstCaseTokensPerGeneration > input.memberTokenLimitPerMinute ||
    input.maxOutputTokens > input.worstCaseTokensPerGeneration ||
    input.maxOutputTokens > Math.floor(
      (MAX_STORED_GENERATION_SERIALIZED_BYTES -
        GENERATION_STORAGE_ENVELOPE_HEADROOM_BYTES) /
        STRUCTURED_OUTPUT_UTF8_BYTES_PER_TOKEN,
    )
  ) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'AI assistance generation budget configuration is invalid.',
    )
  }
}

/**
 * Creates the UTC-aligned one-minute budget charged by an atomic reservation.
 *
 * @param createdAt - Request instant used to select the fixed window.
 * @param configuration - Validated deployment request and token caps.
 * @returns Exact counter window and conservative per-key token charge.
 */
function createGenerationBudgetReservation(
  createdAt: Date,
  configuration: GenerationBudgetConfiguration,
): AiAssistanceGenerationBudgetReservation {
  const windowStartedAtMs = Math.floor(
    createdAt.getTime() / GENERATION_BUDGET_WINDOW_MS,
  ) * GENERATION_BUDGET_WINDOW_MS
  return {
    windowStartedAt: new Date(windowStartedAtMs).toISOString(),
    windowExpiresAt: new Date(
      windowStartedAtMs + GENERATION_BUDGET_WINDOW_MS,
    ).toISOString(),
    reservedTokens: configuration.worstCaseTokensPerGeneration,
    workspaceGenerationLimit: configuration.workspaceGenerationLimitPerMinute,
    memberGenerationLimit: configuration.memberGenerationLimitPerMinute,
    workspaceTokenLimit: configuration.workspaceTokenLimitPerMinute,
    memberTokenLimit: configuration.memberTokenLimitPerMinute,
  }
}

/** Validates one effective policy against the deployment allowlist. */
function validateEffectivePolicy(
  policy: AiAssistancePolicy,
  deploymentAllowedModelIds: ReadonlySet<string>,
): void {
  if (
    policy.allowedModelIds.length === 0 ||
    !policy.allowedModelIds.includes(policy.defaultModelId) ||
    policy.allowedModelIds.some((modelId) => !deploymentAllowedModelIds.has(modelId))
  ) {
    throw new AiAssistanceError(
      'validation',
      'AiAssistanceModelNotAllowed',
      'AI assistance policy contains a model outside the deployment allowlist.',
    )
  }
  if (new Set(policy.enabledTasks).size !== policy.enabledTasks.length) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'AI assistance policy contains duplicate tasks.',
    )
  }
}

/** Enforces Workspace policy and current-member opt-out before source retrieval. */
function requireGenerationEnabled(
  policy: AiAssistancePolicy,
  preference: AiAssistancePreference,
  task: AiAssistanceTask,
): void {
  if (!policy.enabled) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceDisabled',
      'AI assistance is disabled for this Workspace.',
    )
  }
  if (!preference.enabled) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistancePreferenceDisabled',
      'AI assistance is disabled by the current member preference.',
    )
  }
  if (!policy.enabledTasks.includes(task)) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceTaskDisabled',
      'The requested AI assistance task is disabled.',
    )
  }
}

/** Selects a model present in both deployment and Workspace allowlists. */
function selectModelId(
  requestedModelId: string | undefined,
  policy: AiAssistancePolicy,
  deploymentAllowedModelIds: ReadonlySet<string>,
): string {
  const modelId = requestedModelId ?? policy.defaultModelId
  if (!policy.allowedModelIds.includes(modelId) || !deploymentAllowedModelIds.has(modelId)) {
    throw new AiAssistanceError(
      'authorization',
      'AiAssistanceModelNotAllowed',
      'The requested Bedrock model is not allowed.',
    )
  }
  return modelId
}

/** Validates bounded source context and server-created citation metadata. */
function validateResolvedContext(
  context: ResolvedAiAssistanceContext,
  maxPromptContextCharacters: number,
): void {
  if (
    !context.promptContext.trim() ||
    context.promptContext.length > maxPromptContextCharacters ||
    !context.authorizationToken.trim() ||
    context.authorizationToken.length > 8_192
  ) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'Resolved AI context is empty or exceeds configured bounds.',
    )
  }
  const citationIds = new Set<string>()
  for (const citation of context.citations) {
    if (
      citationIds.has(citation.id) ||
      !isSafeApplicationHref(citation.href)
    ) {
      throw new AiAssistanceError(
        'validation',
        'AiAssistanceCitationInvalid',
        'Resolved AI citations are invalid.',
      )
    }
    citationIds.add(citation.id)
  }
  validatePrivateMemberIdentifiers(context.privateMemberIdentifiers)
  validateUniqueAllowedValues(context.allowedValues)
  validateAllowedMemberIdentifiers(
    context.allowedValues,
    context.privateMemberIdentifiers,
  )
}

/** Rejects unbounded or ambiguous private identifier metadata from the resolver boundary. */
function validatePrivateMemberIdentifiers(
  members: readonly AiAssistancePrivateMemberIdentifiers[],
): void {
  const memberIds = new Set<string>()
  const providerAliases = new Set<string>()
  const entriesValid = members.length <= MAX_PRIVATE_MEMBER_IDENTIFIER_GROUPS &&
    members.every((member) => {
      const memberId = member.memberId.trim()
      const providerAlias = member.providerAlias.trim()
      if (
        !memberId || memberId !== member.memberId || memberId.length > 500 ||
        memberIds.has(memberId) ||
        providerAlias !== member.providerAlias ||
        !PRIVATE_MEMBER_PROVIDER_ALIAS_PATTERN.test(providerAlias) ||
        providerAliases.has(providerAlias) || member.identifiers.length > 8
      ) return false
      memberIds.add(memberId)
      providerAliases.add(providerAlias)
      const identifiers = member.identifiers.map((identifier) => identifier.trim())
      return identifiers.every((identifier) =>
        identifier.length > 0 && identifier.length <= 500
      ) && new Set(identifiers).size === identifiers.length
    })
  const valid = entriesValid &&
    [...providerAliases].every((providerAlias) => !memberIds.has(providerAlias))
  if (!valid) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'Resolved AI member identifier metadata is invalid.',
    )
  }
}

/** Requires every model-visible member identifier to have a private alias mapping. */
function validateAllowedMemberIdentifiers(
  allowed: AiAssistanceAllowedValues,
  members: readonly AiAssistancePrivateMemberIdentifiers[],
): void {
  const privateMemberIds = new Set(members.map((member) => member.memberId))
  if (
    allowed.assigneeUserIds.some((value) => !privateMemberIds.has(value)) ||
    allowed.creatorUserIds.some((value) => !privateMemberIds.has(value))
  ) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'Resolved AI member allowlists are missing private alias metadata.',
    )
  }
}

/**
 * Rejects context that cannot leave enough UTF-8 storage space for maximum model output.
 *
 * @param knownPersistentPayload - Redacted request, audit context, citations, and fixed envelope.
 * @param maxOutputTokens - Maximum structured-output tokens accepted from the provider.
 */
function requireGenerationPersistenceBudget(
  knownPersistentPayload: Readonly<Record<string, unknown>>,
  maxOutputTokens: number,
): void {
  const knownPayloadBytes = utf8SerializedByteLength(knownPersistentPayload)
  const maximumStructuredOutputBytes =
    maxOutputTokens * STRUCTURED_OUTPUT_UTF8_BYTES_PER_TOKEN
  if (
    knownPayloadBytes + maximumStructuredOutputBytes +
      GENERATION_STORAGE_ENVELOPE_HEADROOM_BYTES >
        MAX_STORED_GENERATION_SERIALIZED_BYTES
  ) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'Resolved AI context exceeds the safe persistence byte budget.',
    )
  }
}

/**
 * Measures a JSON-compatible value using its actual UTF-8 serialization size.
 *
 * @param value - Server-owned value intended for document persistence.
 * @returns Serialized UTF-8 byte length.
 */
function utf8SerializedByteLength(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'Resolved AI context is not serializable.',
    )
  }
  return Buffer.byteLength(serialized, 'utf8')
}

/** Requires the model draft discriminator to match the requested task. */
function validateDraftForTask(draft: AiAssistanceDraft, task: AiAssistanceTask): void {
  const expectedKind = task === 'search' ? 'search' : task
  if (draft.kind !== expectedKind) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceOutput',
      'The model returned a draft for a different task.',
    )
  }
}

/** Validates every citation and resource identifier emitted by the model. */
function validateDraftReferences(
  draft: AiAssistanceDraft,
  context: ResolvedAiAssistanceContext,
): void {
  const citationIds = new Set(context.citations.map((citation) => citation.id))
  for (const citationId of collectDraftCitationIds(draft)) {
    if (!citationIds.has(citationId)) {
      throw new AiAssistanceError(
        'validation',
        'AiAssistanceCitationInvalid',
        'The model referenced an unknown citation.',
      )
    }
  }
  validateDraftAllowedValues(draft, context.allowedValues)
}

/** Collects all model-generated citation identifiers from a task draft. */
function collectDraftCitationIds(draft: AiAssistanceDraft): string[] {
  if (draft.kind === 'search') return []
  if (draft.kind === 'summary') {
    return [
      ...draft.overview.citationIds,
      ...draft.decisions.flatMap((item) => item.citationIds),
      ...draft.actions.flatMap((item) => item.citationIds),
      ...draft.risks.flatMap((item) => item.citationIds),
    ]
  }
  if (draft.kind === 'triage') {
    return [
      ...(draft.title?.citationIds ?? []),
      ...(draft.description?.citationIds ?? []),
      ...(draft.priority?.citationIds ?? []),
      ...(draft.assigneeUserId?.citationIds ?? []),
      ...(draft.teamId?.citationIds ?? []),
      ...(draft.projectId?.citationIds ?? []),
      ...draft.customFields.flatMap((field) => field.citationIds),
    ]
  }
  return [
    ...(draft.title?.citationIds ?? []),
    ...(draft.description?.citationIds ?? []),
    ...(draft.priority?.citationIds ?? []),
    ...(draft.status?.citationIds ?? []),
    ...(draft.plannedEffortMinutes?.citationIds ?? []),
    ...draft.subtasks.flatMap((subtask) => subtask.citationIds),
    ...draft.dependencies.flatMap((dependency) => dependency.citationIds),
    ...(draft.statusUpdate?.citationIds ?? []),
  ]
}

/** Validates task-specific model identifiers against the current source allowlist. */
function validateDraftAllowedValues(
  draft: AiAssistanceDraft,
  allowed: AiAssistanceAllowedValues,
): void {
  if (draft.kind === 'triage') {
    requireAllowedOptional(draft.assigneeUserId?.value, allowed.assigneeUserIds, 'assignee')
    requireAllowedOptional(draft.teamId?.value, allowed.teamIds, 'Team')
    requireAllowedOptional(draft.projectId?.value, allowed.projectIds, 'Project')
    for (const field of draft.customFields) {
      requireAllowed(field.fieldId, allowed.customFieldIds, 'custom field')
    }
    return
  }
  if (draft.kind === 'search') {
    requireAllowedMany(draft.filters.assigneeUserIds, allowed.assigneeUserIds, 'assignee')
    requireAllowedMany(draft.filters.creatorUserIds, allowed.creatorUserIds, 'creator')
    requireAllowedMany(draft.filters.teamIds, allowed.teamIds, 'Team')
    requireAllowedMany(draft.filters.projectIds, allowed.projectIds, 'Project')
    requireAllowedMany(draft.filters.statuses, allowed.statuses, 'status')
    requireAllowedMany(draft.filters.relationIds, allowed.relationIds, 'relation')
    for (const filter of draft.filters.customFields ?? []) {
      requireAllowed(filter.fieldId, allowed.customFieldIds, 'custom field')
    }
    return
  }
  if (draft.kind === 'planning') {
    requireAllowedOptional(draft.status?.value, allowed.statuses, 'status')
    for (const dependency of draft.dependencies) {
      requireAllowedEndpoint(dependency.predecessor, allowed.workItemEndpoints)
      requireAllowedEndpoint(dependency.successor, allowed.workItemEndpoints)
    }
  }
}

/** Private member identifier aliases used only for one provider request. */
type PrivateIdentifierAliases = {
  /** Model-visible allowlists with member IDs replaced by random request-local aliases. */
  modelAllowedValues: AiAssistanceAllowedValues
  /** Canonical member identifier keyed by generation-local alias. */
  canonicalMemberIdByAlias: ReadonlyMap<string, string>
  /** Exact text replacements applied before generic email redaction. */
  textAliases: readonly AiAssistanceTextAlias[]
  /** Unambiguous member labels restored only after current authorization succeeds. */
  disclosureTextAliases: readonly AiAssistanceTextAlias[]
}

/** Creates resolver-supplied random aliases for potentially identifying member keys. */
function createPrivateIdentifierAliases(
  allowed: AiAssistanceAllowedValues,
  privateMembers: readonly AiAssistancePrivateMemberIdentifiers[],
): PrivateIdentifierAliases {
  const memberEntries = privateMembers.map((member) => [
    member.providerAlias,
    member.memberId,
  ] satisfies readonly [string, string])
  const aliasByCanonicalMemberId = new Map(
    memberEntries.map(([alias, value]) => [value, alias]),
  )
  const aliasesByPrivateIdentifier = new Map<string, Set<string>>()
  for (const member of privateMembers) {
    const alias = aliasByCanonicalMemberId.get(member.memberId)
    if (alias === undefined) continue
    for (const identifier of member.identifiers) {
      const normalized = identifier.trim()
      if (!normalized || normalized === member.memberId) continue
      const aliases = aliasesByPrivateIdentifier.get(normalized) ?? new Set<string>()
      aliases.add(alias)
      aliasesByPrivateIdentifier.set(normalized, aliases)
    }
  }
  const privateTextAliases = createAiAssistancePrivateTextAliases(privateMembers)
  const disclosureByAlias = new Map<string, string>()
  for (const member of privateMembers) {
    const alias = aliasByCanonicalMemberId.get(member.memberId)
    if (alias === undefined || disclosureByAlias.has(alias)) continue
    const identifier = member.identifiers
      .map((value) => value.trim())
      .find((value) => aliasesByPrivateIdentifier.get(value)?.size === 1)
    if (identifier !== undefined) {
      disclosureByAlias.set(alias, identifier)
    } else if (member.identifiers.some((value) => value.trim())) {
      disclosureByAlias.set(alias, '[REDACTED_PERSON]')
    }
  }
  return {
    modelAllowedValues: {
      ...allowed,
      assigneeUserIds: allowed.assigneeUserIds.map((value) =>
        aliasByCanonicalMemberId.get(value) ?? value),
      creatorUserIds: allowed.creatorUserIds.map((value) =>
        aliasByCanonicalMemberId.get(value) ?? value),
    },
    canonicalMemberIdByAlias: new Map(memberEntries),
    textAliases: privateTextAliases,
    disclosureTextAliases: [...disclosureByAlias.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, alias]) => ({ value, alias, applyAfterRedaction: true })),
  }
}

/** Restores server-owned member identifiers after strict model parsing. */
function restorePrivateIdentifiers(
  draft: AiAssistanceDraft,
  aliases: PrivateIdentifierAliases,
): AiAssistanceDraft {
  if (draft.kind === 'triage') {
    const assignee = draft.assigneeUserId
    return {
      ...draft,
      ...(assignee === undefined
        ? {}
        : {
            assigneeUserId: {
              ...assignee,
              value: aliases.canonicalMemberIdByAlias.get(assignee.value) ?? assignee.value,
            },
          }),
    }
  }
  if (draft.kind === 'search') {
    return {
      ...draft,
      filters: {
        ...draft.filters,
        ...(draft.filters.assigneeUserIds === undefined
          ? {}
          : {
              assigneeUserIds: draft.filters.assigneeUserIds.map((value) =>
                aliases.canonicalMemberIdByAlias.get(value) ?? value),
            }),
        ...(draft.filters.creatorUserIds === undefined
          ? {}
          : {
              creatorUserIds: draft.filters.creatorUserIds.map((value) =>
                aliases.canonicalMemberIdByAlias.get(value) ?? value),
            }),
      },
    }
  }
  return draft
}

/** Rejects duplicate values in each server-provided allowlist. */
function validateUniqueAllowedValues(allowed: AiAssistanceAllowedValues): void {
  const lists = [
    allowed.assigneeUserIds,
    allowed.creatorUserIds,
    allowed.teamIds,
    allowed.projectIds,
    allowed.customFieldIds,
    allowed.relationIds,
    allowed.statuses,
    allowed.workItemEndpoints.map(createEndpointKey),
  ]
  if (lists.some((values) => new Set(values).size !== values.length)) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'Resolved AI allowlists contain duplicate identifiers.',
    )
  }
}

/** Requires one optional identifier to be present in its current allowlist. */
function requireAllowedOptional(
  value: string | undefined,
  allowed: readonly string[],
  label: string,
): void {
  if (value !== undefined) requireAllowed(value, allowed, label)
}

/** Requires every optional identifier to be present in its current allowlist. */
function requireAllowedMany(
  values: readonly string[] | undefined,
  allowed: readonly string[],
  label: string,
): void {
  for (const value of values ?? []) requireAllowed(value, allowed, label)
}

/** Requires one identifier to be present in its current allowlist. */
function requireAllowed(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) {
    throw new AiAssistanceError(
      'validation',
      'AiAssistanceOutputNotAllowed',
      `The model returned an unknown ${label} identifier.`,
    )
  }
}

/** Requires one dependency endpoint to be visible to the current operator. */
function requireAllowedEndpoint(
  endpoint: WorkItemDependencyEndpoint,
  allowed: readonly WorkItemDependencyEndpoint[],
): void {
  const key = createEndpointKey(endpoint)
  if (!allowed.some((candidate) => createEndpointKey(candidate) === key)) {
    throw new AiAssistanceError(
      'validation',
      'AiAssistanceOutputNotAllowed',
      'The model returned an unknown Work Item dependency endpoint.',
    )
  }
}

/** Creates an unambiguous comparison key for a Team-qualified Work Item endpoint. */
function createEndpointKey(endpoint: WorkItemDependencyEndpoint): string {
  return `${encodeURIComponent(endpoint.teamId)}/${encodeURIComponent(endpoint.workItemId)}`
}

/** Returns whether a citation link is a safe application-relative path. */
function isSafeApplicationHref(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
}

/** Maps an authorization recheck result to a stable application error. */
function authorizationChangedError(
  reason: 'permission-changed' | 'source-changed',
): AiAssistanceError {
  return reason === 'permission-changed'
    ? new AiAssistanceError(
        'conflict',
        'AiAssistanceAuthorizationChanged',
        'AI source authorization changed during generation.',
      )
    : new AiAssistanceError(
        'conflict',
        'AiAssistanceSourceChanged',
        'An AI source changed during generation.',
      )
}

/** Converts an arbitrary generation failure to a durable, disclosure-safe application error. */
function toSafeAttemptError(error: unknown): AiAssistanceError {
  return error instanceof AiAssistanceError
    ? error
    : createSafeAttemptError('upstream', 'AiAssistanceAttemptFailed')
}

/** Reconstructs a stable attempt error without persisting provider messages or causes. */
function createSafeAttemptError(
  category: AiAssistanceErrorCategory,
  code: AiAssistanceErrorCode,
): AiAssistanceError {
  return new AiAssistanceError(
    category,
    code,
    'The AI assistance generation attempt failed. Use a new Idempotency-Key to retry.',
  )
}

/** Returns a disclosure-safe projection without retaining generated text or citations. */
function withholdGeneration(
  generation: AiAssistanceGeneration,
  reasonCode: 'permission-changed' | 'retention-expired' | 'source-changed',
): AiAssistanceGeneration {
  return {
    ...generation,
    content: {
      availability: 'withheld',
      reasonCode,
    },
  }
}

/** Strongly reads a generation and enforces requestor ownership. */
async function requireOwnedGeneration(
  actor: AiAssistanceActor,
  generationId: string,
  read: (
    workspaceId: string,
    id: string,
  ) => Promise<StoredAiAssistanceGeneration | undefined>,
): Promise<StoredAiAssistanceGeneration> {
  const record = await read(actor.workspaceId, generationId)
  if (!record || record.memberId !== actor.memberId) {
    throw new AiAssistanceError(
      'not-found',
      'AiAssistanceGenerationNotFound',
      'The AI assistance generation was not found.',
    )
  }
  return record
}

/** Requires one bounded idempotency key before any provider execution. */
function requireIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw new AiAssistanceError(
      'validation',
      'AiAssistanceIdempotencyKeyRequired',
      'A valid Idempotency-Key header is required.',
    )
  }
  return normalized
}

/** Creates an operation, actor, prompt, model, and validated-input-bound fingerprint. */
function createGenerationInputFingerprint(
  actor: AiAssistanceActor,
  request: GenerateAiAssistanceRequest,
  modelId: string,
  promptVersion: string,
): string {
  return createHash('sha256').update(JSON.stringify({
    operation: 'ai-assistance.generate',
    workspaceId: actor.workspaceId,
    memberId: actor.memberId,
    modelId,
    promptVersion,
    request,
  })).digest('hex')
}

/** Creates a deterministic feedback record key and a redacted-payload-bound fingerprint. */
function createFeedbackIdentity(
  actor: AiAssistanceActor,
  generationId: string,
  feedback: CreateAiAssistanceFeedbackRequest,
  idempotencyKey: string,
): { feedbackId: string; inputFingerprint: string } {
  const ownership = {
    operation: 'ai-assistance.feedback',
    workspaceId: actor.workspaceId,
    memberId: actor.memberId,
    generationId,
  }
  const feedbackId = createHash('sha256').update(JSON.stringify({
    ...ownership,
    idempotencyKey,
  })).digest('hex')
  const inputFingerprint = createHash('sha256').update(JSON.stringify({
    ...ownership,
    feedback,
  })).digest('hex')
  return { feedbackId: `feedback-${feedbackId}`, inputFingerprint }
}

/** Rechecks a stored generation before returning its generated content. */
async function projectStoredGeneration(
  actor: AiAssistanceActor,
  record: StoredAiAssistanceGeneration,
  policy: AiAssistancePolicy,
  authorization: AiAssistanceAuthorizationCallbacks,
  now: () => Date,
): Promise<AiAssistanceGeneration> {
  const generation = applyEffectiveRetention(record.generation, policy)
  if (Date.parse(generation.expiresAt) <= now().getTime()) {
    return withholdGeneration(generation, 'retention-expired')
  }
  const authorizationState = await authorization.isAuthorizationCurrent({
    actor,
    request: record.request,
    authorizationToken: record.authorizationToken,
  })
  return authorizationState.current
    ? generation
    : withholdGeneration(generation, authorizationState.reason)
}

/**
 * Applies the stricter of the immutable stored deadline and current Workspace policy.
 *
 * @param generation - Stored generation created under an earlier policy revision.
 * @param policy - Strongly read current Workspace policy.
 * @returns Generation projected with its current effective expiration deadline.
 */
function applyEffectiveRetention(
  generation: AiAssistanceGeneration,
  policy: AiAssistancePolicy,
): AiAssistanceGeneration {
  const storedExpiration = Date.parse(generation.expiresAt)
  const createdAt = Date.parse(generation.createdAt)
  const policyExpiration = createdAt + policy.retentionDays * RETENTION_DAY_MS
  const effectiveExpiration = Math.min(storedExpiration, policyExpiration)
  if (!Number.isFinite(effectiveExpiration)) {
    throw new AiAssistanceError(
      'upstream',
      'InvalidAiAssistanceRecord',
      'Stored AI assistance retention metadata is invalid.',
    )
  }
  const expiresAt = new Date(effectiveExpiration).toISOString()
  return expiresAt === generation.expiresAt
    ? generation
    : { ...generation, expiresAt }
}
