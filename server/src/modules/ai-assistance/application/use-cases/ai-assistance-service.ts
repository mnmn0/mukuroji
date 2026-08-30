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
  parseAiAssistanceGeneration,
  parseAiAssistanceModelOutput,
  parseAiAssistanceUsage,
  parseCreateAiAssistanceFeedbackRequest,
  parseDecideAiAssistanceGenerationRequest,
  parseGenerateAiAssistanceRequest,
  parseUpdateAiAssistancePolicyRequest,
  parseUpdateAiAssistancePreferenceRequest,
} from '../validation/ai-assistance-schema'
import type {
  AiAssistanceActor,
  AiAssistanceAllowedValues,
  AiAssistanceCustomFieldDefinition,
  AiAssistanceDecisionCommitFence,
  AiAssistanceGenerationCommitFence,
  AiAssistanceAuthorizationCallbacks,
  AiAssistanceGenerationBudgetReservation,
  AiAssistanceGenerationReservation,
  CompleteAiAssistanceGenerationReservationInput,
  AiAssistancePolicyAuthorization,
  AiAssistancePolicyAuthorizationFence,
  AiAssistancePolicyAudit,
  AiAssistancePolicyAuditInput,
  AiAssistancePrivateMemberIdentifiers,
  AiAssistanceTriageRoutingTuple,
  AiModelGenerationResult,
  AiAssistanceService,
  AiAssistanceServiceOptions,
  ResolvedAiAssistanceContext,
  StoredAiAssistanceGeneration,
} from '../ports/ai-assistance-ports'
import { hasSupportedCurrencyPrecision } from '../../../work-items'

const DEFAULT_MAX_PROMPT_CONTEXT_CHARACTERS = 100_000
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const DEFAULT_PROVIDER_TIMEOUT_MS = 12_000
const DEFAULT_GENERATION_DEADLINE_MS = 19_000
const GENERATION_DEADLINE_HEADROOM_MS = 1_000
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
  const generationDeadlineMs = options.generationDeadlineMs ?? DEFAULT_GENERATION_DEADLINE_MS
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
  if (
    !Number.isSafeInteger(generationDeadlineMs) ||
    generationDeadlineMs <= providerTimeoutMs + GENERATION_DEADLINE_HEADROOM_MS
  ) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'The AI assistance generation deadline must leave provider and persistence headroom.',
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

  /** Reads the explicit or deployment-default Workspace policy for internal use cases. */
  async function readPolicy(actor: AiAssistanceActor): Promise<AiAssistancePolicy> {
    return await options.store.getPolicy(actor.workspaceId) ?? options.defaultPolicy
  }

  /** Reads the Workspace policy only for an authenticated policy manager. */
  async function getPolicy(actor: AiAssistanceActor): Promise<AiAssistancePolicy> {
    if (!actor.canManagePolicy) {
      throw new AiAssistanceError(
        'authorization',
        'AiAssistanceDisabled',
        'The current operator cannot read AI assistance policy.',
      )
    }
    return await readPolicy(actor)
  }

  /**
   * Persists a manager-authorized Workspace policy update.
   *
   * @param actor - Operator snapshot used for Workspace and member identity binding.
   * @param input - Revision-fenced policy update request.
   * @param authorization - Fresh management authorization checked immediately before persistence.
   * @returns The policy accepted by the revision-fenced store.
   */
  async function updatePolicy(
    actor: AiAssistanceActor,
    input: UpdateAiAssistancePolicyRequest,
    authorization: AiAssistancePolicyAuthorization,
  ): Promise<AiAssistancePolicy> {
    if (!actor.canManagePolicy) {
      throw new AiAssistanceError(
        'authorization',
        'AiAssistanceDisabled',
        'The current operator cannot manage AI assistance policy.',
      )
    }
    const request = parseUpdateAiAssistancePolicyRequest(input)
    const previousPolicy = await readPolicy(actor)
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
    if (!await authorization.isCurrent()) {
      throw new AiAssistanceError(
        'authorization',
        'AiAssistanceAuthorizationChanged',
        'AI assistance policy authorization changed. Reload and try again.',
      )
    }
    const auditInput: AiAssistancePolicyAuditInput = {
      workspaceId: actor.workspaceId,
      memberId: actor.memberId,
      actorId: actor.actorId,
      actorKind: actor.auditActorKind,
      previousPolicy,
      nextPolicy: policy,
    }
    const writePolicy = () => options.store.putPolicy(
      actor.workspaceId,
      policy,
      request.expectedRevision,
    )
    let storedPolicy: AiAssistancePolicy
    if (options.policyAudit?.persist) {
      const authorizationFence = await authorization.getCommitFence?.()
      if (authorizationFence === undefined) {
        throw new AiAssistanceError(
          'authorization',
          'AiAssistanceAuthorizationChanged',
          'AI assistance policy authorization changed. Reload and try again.',
        )
      }
      storedPolicy = await persistPolicyWithAudit(
        options.policyAudit,
        auditInput,
        request.expectedRevision,
        authorizationFence,
        writePolicy,
      )
    } else {
      storedPolicy = await writePolicy()
      if (options.policyAudit) {
        await recordPolicyAudit(options.policyAudit, auditInput)
      }
    }
    return storedPolicy
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

  /**
   * Replays an exact durable generation before evaluating gates for new inference.
   *
   * @param actor - Authenticated actor bound to the receipt.
   * @param reservation - Durable receipt classification returned by the store.
   * @param authorization - Current source authorization used for disclosure.
   * @param completionIdentity - Idempotency identity used to repair a pending attempt.
   * @returns The existing generation projected through current authorization.
   * @throws A stable error when the receipt is failed, malformed, or no longer accessible.
   */
  async function replayGenerationReservation(
    actor: AiAssistanceActor,
    reservation: AiAssistanceGenerationReservation,
    authorization: AiAssistanceAuthorizationCallbacks,
    completionIdentity: Pick<
      CompleteAiAssistanceGenerationReservationInput,
      'idempotencyKey' | 'inputFingerprint'
    >,
  ): Promise<AiAssistanceGeneration> {
    if (reservation.status === 'failed') {
      throw createSafeAttemptError(
        reservation.failureCategory,
        reservation.failureCode,
      )
    }
    if (reservation.status !== 'replay' && reservation.status !== 'pending') {
      throw new AiAssistanceError(
        'upstream',
        'InvalidAiAssistanceRecord',
        'The AI assistance idempotency receipt is not replayable.',
      )
    }
    const existing = await options.store.getGeneration(
      actor.workspaceId,
      reservation.generationId,
    )
    if (!existing || existing.memberId !== actor.memberId) {
      if (reservation.status === 'pending' && !existing) {
        throw new AiAssistanceError(
          'conflict',
          'AiAssistanceGenerationInProgress',
          'An AI assistance generation with this idempotency key is in progress.',
        )
      }
      throw new AiAssistanceError(
        'upstream',
        'InvalidAiAssistanceRecord',
        'The AI assistance idempotency receipt references an invalid generation.',
      )
    }
    if (reservation.status === 'pending') {
      await options.store.finalizeGenerationAttempt({
        workspaceId: actor.workspaceId,
        memberId: actor.memberId,
        ...completionIdentity,
        generationId: reservation.generationId,
        outcome: 'succeeded',
        endedAt: now().toISOString(),
        latencyMs: existing.generation.details.usage.latencyMs,
        usage: existing.generation.details.usage,
      })
    }
    // The initial policy read happens before the reservation read. Re-read it
    // after the receipt is resolved so a concurrent retention shortening cannot
    // disclose content through an idempotent replay using stale policy data.
    return await projectStoredGeneration(
      actor,
      existing,
      await readPolicy(actor),
      authorization,
      now,
    )
  }

  /** Generates one permission-fenced structured draft. */
  async function generate(
    actor: AiAssistanceActor,
    input: GenerateAiAssistanceRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
    idempotencyKeyValue: string,
    requestStartedAtMs?: number,
  ): Promise<AiAssistanceGeneration> {
    const request = parseGenerateAiAssistanceRequest(input)
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
    const [policy, preference] = await Promise.all([
      readPolicy(actor),
      getPreference(actor),
    ])
    const inputFingerprint = createGenerationInputFingerprint(
      actor,
      request,
    )
    const existingReservation = await options.store.readGenerationReservation({
      workspaceId: actor.workspaceId,
      memberId: actor.memberId,
      idempotencyKey,
      inputFingerprint,
    })
    if (existingReservation !== undefined) {
      return await replayGenerationReservation(
        actor,
        existingReservation,
        authorization,
        { idempotencyKey, inputFingerprint },
      )
    }
    requireGenerationEnabled(policy, preference, request.task)
    const modelId = selectModelId(request.modelId, policy, deploymentAllowedModelIds)
    const createdAt = now()
    const generationRequestStartedAtMs = normalizeGenerationRequestStartedAtMs(
      requestStartedAtMs,
      createdAt.getTime(),
    )
    const generationId = createId()
    const expiresAt = new Date(
      createdAt.getTime() + policy.retentionDays * RETENTION_DAY_MS,
    )
    const leaseExpiresAt = new Date(createdAt.getTime() + reservationLeaseMs)
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
      throw createSafeAttemptError(reservation.failureCategory, reservation.failureCode)
    }
    if (reservation.status !== 'reserved') {
      return await replayGenerationReservation(
        actor,
        reservation,
        authorization,
        { idempotencyKey, inputFingerprint },
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
      const attemptStartedAtValue = now()
      await options.store.startGenerationAttempt({
        ...completion,
        task: request.task,
        modelId,
        promptVersion: options.promptVersion,
        traceId: actor.traceId,
        startedAt: attemptStartedAtValue.toISOString(),
        audit: {
          request: providerRequest,
          auditedInput: context.promptContext,
          citations: [...context.citations],
        },
      })
      attemptStartedAt = attemptStartedAtValue
      // Re-resolve every source after the durable attempt starts and immediately
      // before the paid call. This fences document bodies and comment windows
      // that can change without a policy or Workspace ACL revision update.
      const preProviderAuthorizationState = await authorization.isAuthorizationCurrent({
        actor,
        request: providerRequest,
        authorizationToken: context.authorizationToken,
      })
      if (!preProviderAuthorizationState.current) {
        throw authorizationChangedError(preProviderAuthorizationState.reason)
      }
      const [currentPolicy, currentPreference] = await Promise.all([
        readPolicy(actor),
        getPreference(actor),
      ])
      if (!isGenerationConfigurationCurrent(
        policy,
        currentPolicy,
        preference,
        currentPreference,
      )) {
        throw authorizationChangedError('permission-changed')
      }
      const providerStartedAt = now()
      const elapsedBeforeProviderMs = Math.max(
        0,
        providerStartedAt.getTime() - generationRequestStartedAtMs,
      )
      const remainingProviderTimeoutMs = Math.min(
        providerTimeoutMs,
        generationDeadlineMs - elapsedBeforeProviderMs - GENERATION_DEADLINE_HEADROOM_MS,
      )
      if (remainingProviderTimeoutMs <= 0) {
        throw new AiAssistanceError(
          'timeout',
          'AiAssistanceProviderTimeout',
          'The AI assistance request exceeded its end-to-end deadline before Bedrock started.',
        )
      }
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
        timeoutMs: remainingProviderTimeoutMs,
      })
      modelResult = {
        ...modelResult,
        usage: parseAiAssistanceUsage(modelResult.usage),
      }
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
      validateDraftForRequest(aliasedDraft, request)
      validateDraftReferences(aliasedDraft, {
        ...context,
        allowedValues: privateIdentifierAliases.modelAllowedValues,
      }, request)
      const authorizationState = await authorization.isAuthorizationCurrent({
        actor,
        request: providerRequest,
        authorizationToken: context.authorizationToken,
      })
      if (!authorizationState.current) {
        throw authorizationChangedError(authorizationState.reason)
      }
      // Re-read governance after the paid call. A policy or member opt-out can
      // change while Bedrock is in flight, so the output must be discarded before
      // it can be persisted or disclosed.
      const [postProviderPolicy, postProviderPreference] = await Promise.all([
        readPolicy(actor),
        getPreference(actor),
      ])
      requireGenerationEnabled(postProviderPolicy, postProviderPreference, request.task)
      if (!isGenerationConfigurationCurrent(
        policy,
        postProviderPolicy,
        preference,
        postProviderPreference,
      )) {
        throw authorizationChangedError('permission-changed')
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
      const safeOutput = parseAiAssistanceModelOutput({
        draft: safeDraft,
        uncertainty: safeUncertainty,
      })
      validateAiAssistanceDraftForApplication(safeOutput.draft, request, context)

      const generation: AiAssistanceGeneration = {
        schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
        id: reservation.generationId,
        task: request.task,
        revision: 1,
        content: {
          availability: 'available',
          draft: safeOutput.draft,
          citations: disclosureCitations,
          uncertainty: safeOutput.uncertainty,
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
      // Disclosure-time redaction can expand citation labels or excerpts. Parse the complete
      // public generation after every transformation so the first persisted response obeys the
      // same bounds as later reads and replays.
      const validatedGeneration = parseAiAssistanceGeneration(generation)
      const generationCommitFence: AiAssistanceGenerationCommitFence = {
        policyRevision: postProviderPolicy.revision,
        preferenceRevision: postProviderPreference.revision,
      }
      const stored = await options.store.createGeneration({
        workspaceId: actor.workspaceId,
        memberId: actor.memberId,
        generation: validatedGeneration,
        request: providerRequest,
        authorizationToken: context.authorizationToken,
        auditedInput: context.promptContext,
      }, generationCommitFence)
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
      return await projectStoredGeneration(
        actor,
        stored,
        await readPolicy(actor),
        authorization,
        now,
      )
    } catch (error) {
      const safeError = toSafeAttemptError(error)
      const reportedUsage = modelResult?.usage ??
        (error instanceof AiAssistanceError ? error.usage : undefined)
      const providerTraceId = modelResult?.providerTraceId ??
        (error instanceof AiAssistanceError ? error.providerTraceId : undefined)
      if (!generationPersisted) {
        const failedAt = now()
        if (attemptStartedAt) {
          await options.store.finalizeGenerationAttempt({
            ...completion,
            outcome: 'failed',
            endedAt: failedAt.toISOString(),
            latencyMs: reportedUsage?.latencyMs ?? Math.max(
              0,
              Math.round(failedAt.getTime() - attemptStartedAt.getTime()),
            ),
            ...(reportedUsage === undefined
              ? { usageUnavailableReason: 'provider-did-not-report' }
              : { usage: reportedUsage }),
            ...(providerTraceId === undefined
              ? {}
              : { providerTraceId }),
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
      requireOwnedGeneration(
        actor,
        generationId,
        (workspaceId, id) => options.store.getGeneration(workspaceId, id),
      ),
      readPolicy(actor),
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
      requireOwnedGeneration(
        actor,
        generationId,
        (workspaceId, id) => options.store.getGeneration(workspaceId, id),
      ),
      readPolicy(actor),
    ])
    const effectiveGeneration = applyEffectiveRetention(record.generation, policy)
    if (Date.parse(effectiveGeneration.expiresAt) <= now().getTime()) {
      return withholdGeneration(effectiveGeneration, 'retention-expired')
    }
    if (record.generation.decision?.outcome === request.outcome) {
      return await projectStoredGeneration(
        actor,
        record,
        await readPolicy(actor),
        authorization,
        now,
      )
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
    // Re-read retention immediately before the write. The store also checks this
    // revision atomically so a concurrent policy shortening cannot commit a stale
    // decision between this read and DynamoDB's conditional write.
    const decisionPolicy = await readPolicy(actor)
    const decisionGeneration = applyEffectiveRetention(record.generation, decisionPolicy)
    if (Date.parse(decisionGeneration.expiresAt) <= now().getTime()) {
      return withholdGeneration(decisionGeneration, 'retention-expired')
    }
    const decisionCommitFence: AiAssistanceDecisionCommitFence = {
      policyRevision: decisionPolicy.revision,
      effectiveExpiresAt: decisionGeneration.expiresAt,
    }
    const decided = await options.store.decideGeneration(
      actor.workspaceId,
      generationId,
      request,
      now().toISOString(),
      decisionCommitFence,
    )
    return await projectStoredGeneration(
      actor,
      decided,
      await readPolicy(actor),
      authorization,
      now,
    )
  }

  /** Appends owner-scoped bounded feedback without exposing source content. */
  async function createFeedback(
    actor: AiAssistanceActor,
    generationId: string,
    input: CreateAiAssistanceFeedbackRequest,
    idempotencyKeyValue: string,
  ): Promise<void> {
    const parsedFeedback = parseCreateAiAssistanceFeedbackRequest(input)
    const redactedFeedback = {
      rating: parsedFeedback.rating,
      ...(parsedFeedback.comment === undefined
        ? {}
        : { comment: redactAiAssistanceText(parsedFeedback.comment) }),
    }
    // Redaction markers are longer than many source tokens. Reparse the transformed payload
    // before deriving its idempotency identity or writing it to the feedback table.
    const feedback: CreateAiAssistanceFeedbackRequest =
      parseCreateAiAssistanceFeedbackRequest(redactedFeedback)
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
    const feedbackIdentity = createFeedbackIdentity(
      actor,
      generationId,
      feedback,
      idempotencyKey,
    )
    const [record, policy] = await Promise.all([
      requireOwnedGeneration(
        actor,
        generationId,
        (workspaceId, id) => options.store.getGeneration(workspaceId, id),
      ),
      readPolicy(actor),
    ])
    const effectiveGeneration = applyEffectiveRetention(record.generation, policy)
    if (Date.parse(effectiveGeneration.expiresAt) <= now().getTime()) {
      throw new AiAssistanceError(
        'not-found',
        'AiAssistanceGenerationNotFound',
        'The AI assistance generation is no longer available for feedback.',
      )
    }
    await options.store.putFeedback({
      workspaceId: actor.workspaceId,
      feedbackId: feedbackIdentity.feedbackId,
      generationId,
      memberId: actor.memberId,
      feedback,
      inputFingerprint: feedbackIdentity.inputFingerprint,
      createdAt: now().toISOString(),
      expiresAt: effectiveGeneration.expiresAt,
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

/**
 * Normalizes the trusted HTTP request timestamp used by the end-to-end deadline.
 *
 * A malformed or future timestamp must not extend the deadline beyond the first
 * application clock sample. The fallback keeps direct application callers
 * backward-compatible while HTTP callers include authentication and parsing time.
 *
 * @param requestStartedAtMs - Optional request-boundary epoch milliseconds.
 * @param createdAtMs - First service clock sample for this generation.
 * @returns Epoch milliseconds from which the generation deadline is measured.
 */
function normalizeGenerationRequestStartedAtMs(
  requestStartedAtMs: number | undefined,
  createdAtMs: number,
): number {
  if (
    requestStartedAtMs === undefined ||
    !Number.isSafeInteger(requestStartedAtMs) ||
    requestStartedAtMs > createdAtMs
  ) {
    return createdAtMs
  }
  return requestStartedAtMs
}

/**
 * Records a successful policy transition without exposing audit implementation errors.
 *
 * @param policyAudit - Append-only audit boundary supplied by composition.
 * @param input - Actor and before/after policy snapshots.
 * @returns A promise that resolves after the transition is audited.
 * @throws A safe persistence error when the audit writer cannot commit the event.
 */
async function recordPolicyAudit(
  policyAudit: AiAssistancePolicyAudit,
  input: AiAssistancePolicyAuditInput,
): Promise<void> {
  try {
    await policyAudit.record(input)
  } catch (error) {
    if (error instanceof AiAssistanceError) throw error
    throw new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'AI assistance policy audit could not be persisted.',
      { cause: error },
    )
  }
}

/**
 * Runs the adapter-owned atomic policy/audit boundary and maps unexpected failures safely.
 *
 * @param policyAudit - Policy audit boundary supplied by composition.
 * @param input - Actor and before/after policy snapshots.
 * @param expectedRevision - Policy revision supplied by the operator.
 * @param authorizationFence - Fresh membership and Enterprise values for commit conditions.
 * @param write - Revision-fenced policy write used by adapters without atomic support.
 * @returns The policy accepted by the persistence boundary.
 * @throws A stable persistence error when the boundary fails unexpectedly.
 */
async function persistPolicyWithAudit(
  policyAudit: AiAssistancePolicyAudit,
  input: AiAssistancePolicyAuditInput,
  expectedRevision: number,
  authorizationFence: AiAssistancePolicyAuthorizationFence,
  write: () => Promise<AiAssistancePolicy>,
): Promise<AiAssistancePolicy> {
  try {
    if (policyAudit.persist === undefined) {
      const storedPolicy = await write()
      await recordPolicyAudit(policyAudit, input)
      return storedPolicy
    }
    return await policyAudit.persist(
      input,
      expectedRevision,
      authorizationFence,
      write,
    )
  } catch (error) {
    if (error instanceof AiAssistanceError) throw error
    throw new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'AI assistance policy transition could not be persisted.',
      { cause: error },
    )
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

/**
 * Compares the initial generation configuration with a fresh pre-provider read.
 *
 * @param initialPolicy - Policy used to reserve and scope the generation.
 * @param currentPolicy - Strongly reread policy immediately before inference.
 * @param initialPreference - Member preference used before source resolution.
 * @param currentPreference - Strongly reread member preference immediately before inference.
 * @returns Whether effective policy and preference are unchanged.
 */
function isGenerationConfigurationCurrent(
  initialPolicy: AiAssistancePolicy,
  currentPolicy: AiAssistancePolicy,
  initialPreference: AiAssistancePreference,
  currentPreference: AiAssistancePreference,
): boolean {
  return initialPolicy.revision === currentPolicy.revision &&
    initialPolicy.enabled === currentPolicy.enabled &&
    initialPolicy.defaultModelId === currentPolicy.defaultModelId &&
    initialPolicy.retentionDays === currentPolicy.retentionDays &&
    initialPolicy.allowedModelIds.length === currentPolicy.allowedModelIds.length &&
    initialPolicy.allowedModelIds.every((value, index) =>
      value === currentPolicy.allowedModelIds[index]) &&
    initialPolicy.enabledTasks.length === currentPolicy.enabledTasks.length &&
    initialPolicy.enabledTasks.every((value, index) =>
      value === currentPolicy.enabledTasks[index]) &&
    initialPreference.revision === currentPreference.revision &&
    initialPreference.enabled === currentPreference.enabled
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
    allowed.creatorUserIds.some((value) => !privateMemberIds.has(value)) ||
    allowed.triageRoutingTuples?.some((tuple) =>
      tuple.assigneeUserIds.some((value) => !privateMemberIds.has(value))
    )
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

/** Requires the model draft discriminator to match the requested task and source shape. */
function validateDraftForRequest(
  draft: AiAssistanceDraft,
  request: GenerateAiAssistanceRequest,
): void {
  const expectedKind = request.task === 'search' ? 'search' : request.task
  if (draft.kind !== expectedKind) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceOutput',
      'The model returned a draft for a different task.',
    )
  }
  if (request.task !== 'planning' || draft.kind !== 'planning') return

  const hasWorkItemDraft = draft.title !== undefined ||
    draft.description !== undefined ||
    draft.priority !== undefined ||
    draft.status !== undefined ||
    draft.plannedEffortMinutes !== undefined ||
    draft.subtasks.length > 0 ||
    draft.dependencies.length > 0
  if (request.source.type === 'planning-target') {
    if (draft.statusUpdate === undefined || hasWorkItemDraft) {
      throw new AiAssistanceError(
        'validation',
        'InvalidAiAssistanceOutput',
        'The model returned Work Item planning fields for a Planning target.',
      )
    }
    return
  }
  if (draft.statusUpdate !== undefined) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceOutput',
      'The model returned a Planning status update for a Work Item source.',
    )
  }
  if (!hasWorkItemDraft) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceOutput',
      'The model returned an empty Work Item planning draft.',
    )
  }
}

/**
 * Validates a parsed AI draft against task, citation, and server-owned allowlist rules.
 *
 * @param draft - Strictly parsed draft after privacy transformations.
 * @param request - Generation request that determines source-specific rules.
 * @param context - Current permission-safe citations and identifier allowlists.
 * @returns Nothing when the draft is safe for application use.
 * @throws AiAssistanceError When a task, citation, or allowlist invariant is violated.
 */
export function validateAiAssistanceDraftForApplication(
  draft: AiAssistanceDraft,
  request: GenerateAiAssistanceRequest,
  context: Pick<
    ResolvedAiAssistanceContext,
    'citations' | 'allowedValues' | 'triageSourceRouting'
  >,
): void {
  validateDraftForRequest(draft, request)
  validateDraftReferences(draft, context, request)
}

/** Validates every citation and resource identifier emitted by the model. */
function validateDraftReferences(
  draft: AiAssistanceDraft,
  context: Pick<
    ResolvedAiAssistanceContext,
    'citations' | 'allowedValues' | 'triageSourceRouting'
  >,
  request: GenerateAiAssistanceRequest,
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
  validateDraftAllowedValues(draft, context.allowedValues, request, context.triageSourceRouting)
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
  request: GenerateAiAssistanceRequest,
  triageSourceRouting: ResolvedAiAssistanceContext['triageSourceRouting'],
): void {
  if (draft.kind === 'triage') {
    requireAllowedOptional(draft.assigneeUserId?.value, allowed.assigneeUserIds, 'assignee')
    requireAllowedOptional(draft.teamId?.value, allowed.teamIds, 'Team')
    requireAllowedOptional(draft.projectId?.value, allowed.projectIds, 'Project')
    validateTriageRoutingTuple(draft, allowed.triageRoutingTuples)
    for (const field of draft.customFields) {
      requireAllowed(field.fieldId, allowed.customFieldIds, 'custom field')
    }
    validateTriageCustomFields(draft, allowed, request, triageSourceRouting)
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
    validateSearchCustomFields(draft, allowed)
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

/** Validates triage custom-field suggestions against the selected Team schema. */
function validateTriageCustomFields(
  draft: Extract<AiAssistanceDraft, { kind: 'triage' }>,
  allowed: AiAssistanceAllowedValues,
  request: GenerateAiAssistanceRequest,
  triageSourceRouting: ResolvedAiAssistanceContext['triageSourceRouting'],
): void {
  const definitions = allowed.customFieldDefinitions
  if (definitions === undefined || draft.customFields.length === 0) return
  const sourceTeamId = request.task === 'triage' && request.source.type === 'triage-entry'
    ? request.source.teamId
    : triageSourceRouting?.teamId
  const teamId = draft.teamId?.value ?? sourceTeamId
  const projectId = draft.projectId?.value ?? triageSourceRouting?.projectId
  for (const field of draft.customFields) {
    const matches = definitions.filter((definition) =>
      definition.fieldId === field.fieldId &&
      (teamId === undefined || definition.teamId === teamId) &&
      isAiCustomFieldApplicableToProject(definition, projectId)
    )
    if (matches.length !== 1) {
      throw new AiAssistanceError(
        'validation',
        'AiAssistanceOutputNotAllowed',
        'The model returned a custom field that is not defined for the destination Team and Project.',
      )
    }
    validateAiCustomFieldValue(field.value, matches[0])
  }
}

/** Validates Search custom-field values against one unambiguous current definition. */
function validateSearchCustomFields(
  draft: Extract<AiAssistanceDraft, { kind: 'search' }>,
  allowed: AiAssistanceAllowedValues,
): void {
  const definitions = allowed.customFieldDefinitions
  if (definitions === undefined) return
  for (const filter of draft.filters.customFields ?? []) {
    if (filter.value === undefined) continue
    const matches = definitions.filter((definition) => definition.fieldId === filter.fieldId)
    if (matches.length !== 1) {
      throw new AiAssistanceError(
        'validation',
        'AiAssistanceOutputNotAllowed',
        'The model returned an ambiguous or unknown custom field filter.',
      )
    }
    validateAiCustomFieldValue(filter.value, matches[0])
  }
}

/** Checks whether one custom-field definition applies to the proposed Project. */
function isAiCustomFieldApplicableToProject(
  definition: AiAssistanceCustomFieldDefinition,
  projectId: string | undefined,
): boolean {
  return definition.projectIds === undefined || definition.projectIds.length === 0 ||
    (projectId !== undefined && definition.projectIds.includes(projectId))
}

/** Validates a model-proposed value using the canonical Work Item field semantics. */
function validateAiCustomFieldValue(
  value: string | number | boolean | string[] | null,
  definition: AiAssistanceCustomFieldDefinition,
): void {
  if (definition.required && isMissingAiRequiredCustomFieldValue(value)) {
    rejectAiCustomFieldValue('A required custom field cannot be empty.')
  }
  if (value === null) {
    return
  }
  if (definition.type === 'formula') {
    rejectAiCustomFieldValue('Formula custom fields are read-only.')
  }
  if (definition.type === 'boolean' && typeof value !== 'boolean') {
    rejectAiCustomFieldValue('The custom field value must be boolean.')
  }
  if (
    (definition.type === 'number' || definition.type === 'currency' || definition.type === 'duration') &&
    (typeof value !== 'number' || !Number.isFinite(value))
  ) {
    rejectAiCustomFieldValue('The custom field value must be a finite number.')
  }
  if (
    definition.type === 'currency' &&
    typeof value === 'number' &&
    !hasSupportedCurrencyPrecision(value, definition.currencyCode ?? '')
  ) {
    rejectAiCustomFieldValue('The currency custom field value uses unsupported precision.')
  }
  if (definition.type === 'duration' && typeof value === 'number' && value < 0) {
    rejectAiCustomFieldValue('A duration custom field cannot be negative.')
  }
  if ((definition.type === 'text' || definition.type === 'person') && typeof value !== 'string') {
    rejectAiCustomFieldValue('The custom field value must be a string.')
  }
  if (definition.type === 'date' &&
      (typeof value !== 'string' || !isValidAiCalendarDate(value))) {
    rejectAiCustomFieldValue('The custom field value must be a valid ISO date.')
  }
  if (definition.type === 'select') {
    if (typeof value !== 'string' || !definition.optionIds?.includes(value)) {
      rejectAiCustomFieldValue('The custom field value is not a configured select option.')
    }
  }
  if (definition.type === 'multi-select') {
    if (
      !Array.isArray(value) ||
      new Set(value).size !== value.length ||
      !definition.optionIds ||
      value.some((optionId) => !definition.optionIds?.includes(optionId))
    ) {
      rejectAiCustomFieldValue('The custom field value contains an invalid select option.')
    }
  }
  const validation = definition.validation
  if (validation === undefined) return
  if (typeof value === 'number') {
    if (validation.min !== undefined && value < validation.min) {
      rejectAiCustomFieldValue('The custom field value is below its configured minimum.')
    }
    if (validation.max !== undefined && value > validation.max) {
      rejectAiCustomFieldValue('The custom field value exceeds its configured maximum.')
    }
  }
  const length = typeof value === 'string' || Array.isArray(value) ? value.length : undefined
  if (length !== undefined) {
    if (validation.minLength !== undefined && length < validation.minLength) {
      rejectAiCustomFieldValue('The custom field value is shorter than its configured minimum.')
    }
    if (validation.maxLength !== undefined && length > validation.maxLength) {
      rejectAiCustomFieldValue('The custom field value exceeds its configured maximum.')
    }
  }
  if (
    validation.pattern !== undefined &&
    definition.type === 'text' &&
    typeof value === 'string' &&
    !new RegExp(validation.pattern).test(value)
  ) {
    rejectAiCustomFieldValue('The custom field value does not match its configured pattern.')
  }
}

/** Determines whether a typed custom-field value is empty for a required definition. */
function isMissingAiRequiredCustomFieldValue(
  value: string | number | boolean | string[] | null,
): boolean {
  return value === null ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
}

/** Checks one strict Gregorian date used by date custom fields. */
function isValidAiCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Throws the stable output-boundary error for an invalid custom-field proposal. */
function rejectAiCustomFieldValue(message: string): never {
  throw new AiAssistanceError(
    'validation',
    'AiAssistanceOutputNotAllowed',
    message,
  )
}

/** Requires a triage draft's Team, Project, and assignee to share one allowed route. */
function validateTriageRoutingTuple(
  draft: Extract<AiAssistanceDraft, { kind: 'triage' }>,
  tuples: readonly AiAssistanceTriageRoutingTuple[] | undefined,
): void {
  if (tuples === undefined) return
  const teamId = draft.teamId?.value
  const projectId = draft.projectId?.value
  const assigneeUserId = draft.assigneeUserId?.value
  if (teamId === undefined && projectId === undefined && assigneeUserId === undefined) return
  if (tuples.some((tuple) =>
    (teamId === undefined || tuple.teamId === teamId) &&
    (projectId === undefined || tuple.projectId === projectId) &&
    (assigneeUserId === undefined || tuple.assigneeUserIds.includes(assigneeUserId))
  )) return
  throw new AiAssistanceError(
    'validation',
    'AiAssistanceOutputNotAllowed',
    'The model returned an incompatible triage routing combination.',
  )
}

/** Private member identifier aliases used only for one provider request. */
type PrivateIdentifierAliases = {
  /** Model-visible allowlists with member IDs replaced by random request-local aliases. */
  modelAllowedValues: AiAssistanceAllowedValues
  /** Canonical member identifier keyed by generation-local alias. */
  canonicalMemberIdByAlias: ReadonlyMap<string, string>
  /** Exact text replacements applied before generic email redaction. */
  textAliases: readonly AiAssistanceTextAlias[]
  /** Allowed member labels restored, or redacted, only after current authorization succeeds. */
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
  const disclosureAllowedMemberIds = new Set([
    ...allowed.assigneeUserIds,
    ...allowed.creatorUserIds,
    ...(allowed.triageRoutingTuples ?? []).flatMap((tuple) =>
      tuple.assigneeUserIds
    ),
  ])
  const disclosureByAlias = new Map<string, string>()
  for (const member of privateMembers) {
    const alias = aliasByCanonicalMemberId.get(member.memberId)
    if (alias === undefined || disclosureByAlias.has(alias)) continue
    if (!disclosureAllowedMemberIds.has(member.memberId)) {
      disclosureByAlias.set(alias, '[REDACTED_PERSON]')
      continue
    }
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
      ...(allowed.triageRoutingTuples === undefined
        ? {}
        : {
            triageRoutingTuples: allowed.triageRoutingTuples.map((tuple) => ({
              ...tuple,
              assigneeUserIds: tuple.assigneeUserIds.map((value) =>
                aliasByCanonicalMemberId.get(value) ?? value),
            })),
          }),
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
  const routingTuples = allowed.triageRoutingTuples
  const hasDuplicateRoutingTuple = routingTuples !== undefined &&
    new Set(routingTuples.map((tuple) => JSON.stringify([
      tuple.teamId,
      tuple.projectId ?? null,
      [...tuple.assigneeUserIds].sort(),
    ]))).size !== routingTuples.length
  if (lists.some((values) => new Set(values).size !== values.length) ||
      hasDuplicateRoutingTuple ||
      routingTuples?.some((tuple) =>
        !tuple.teamId.trim() ||
        (tuple.projectId !== undefined && !tuple.projectId.trim()) ||
        new Set(tuple.assigneeUserIds).size !== tuple.assigneeUserIds.length
      )) {
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

/** Creates an operation, actor, and validated client-input-bound fingerprint. */
function createGenerationInputFingerprint(
  actor: AiAssistanceActor,
  request: GenerateAiAssistanceRequest,
): string {
  return createHash('sha256').update(JSON.stringify({
    operation: 'ai-assistance.generate',
    workspaceId: actor.workspaceId,
    memberId: actor.memberId,
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
