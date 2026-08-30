import { describe, expect, test } from 'bun:test'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistanceDraft,
  type AiAssistancePolicy,
  type CreateAiAssistanceFeedbackRequest,
  type GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import type {
  AiAssistanceActor,
  AiAssistanceAuthorizationState,
  AiAssistanceCustomFieldDefinition,
  AiAssistanceGenerationBudgetReservation,
  AiAssistancePolicyAuditInput,
  AiAssistancePrivateMemberIdentifiers,
  AiAssistanceTriageRoutingTuple,
  AiAssistanceTriageSourceRouting,
  AiAssistanceStore,
  AiModelGenerationInput,
  FailAiAssistanceGenerationReservationInput,
  FinalizeAiAssistanceGenerationAttemptInput,
  StartAiAssistanceGenerationAttemptInput,
  StoredAiAssistanceFeedback,
  StoredAiAssistanceGeneration,
} from '../ports/ai-assistance-ports'
import { AiAssistanceError } from '../../errors'
import { createAiAssistanceService } from './ai-assistance-service'

const NOW = '2026-08-25T00:00:00.000Z'
const ASSIGNEE_PROVIDER_ALIAS = 'U_test_assignee_0001'
const CREATOR_PROVIDER_ALIAS = 'U_test_creator_0002'

/** Creates the enabled default policy used by service tests. */
function createPolicy(): AiAssistancePolicy {
  return {
    schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
    enabled: true,
    allowedModelIds: ['model-1'],
    defaultModelId: 'model-1',
    enabledTasks: ['triage', 'summary', 'search', 'planning'],
    retentionDays: 30,
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
  }
}

/** Creates one current authenticated test actor. */
function createActor(): AiAssistanceActor {
  return {
    workspaceId: 'workspace-1',
    memberId: 'operator-1',
    actorId: 'operator-actor-1',
    auditActorKind: 'user',
    traceId: 'trace-1',
    canManagePolicy: true,
  }
}

/** Creates a valid grounded summary request. */
function createSummaryRequest(focus?: string): GenerateAiAssistanceRequest {
  return {
    task: 'summary',
    locale: 'ja',
    sources: [{
      type: 'work-item',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      expectedRevision: 2,
    }],
    ...(focus === undefined ? {} : { focus }),
  }
}

/** Creates one planning request for either a Work Item or Planning target source. */
function createPlanningRequest(
  sourceType: 'work-item' | 'planning-target',
): GenerateAiAssistanceRequest {
  return sourceType === 'work-item'
    ? {
        task: 'planning',
        locale: 'en',
        source: {
          type: 'work-item',
          teamId: 'team-1',
          workItemId: 'work-item-1',
          expectedRevision: 2,
        },
      }
    : {
        task: 'planning',
        locale: 'en',
        source: {
          type: 'planning-target',
          target: { type: 'project', teamId: 'team-1', projectId: 'project-1' },
          expectedRevision: 2,
        },
      }
}

/** Asserts the durable start receipt contains only the model-visible redacted evidence. */
function expectSafeSummaryAttemptAudit(
  attempt: StartAiAssistanceGenerationAttemptInput | undefined,
): void {
  if (attempt === undefined) throw new Error('Expected a started provider attempt.')
  expect(attempt.audit.request).toEqual(createSummaryRequest())
  expect(attempt.audit.auditedInput).toBe(
    `Authorized source for ${ASSIGNEE_PROVIDER_ALIAS} and ` +
      '[REDACTED_EMAIL] token=[REDACTED_SECRET]',
  )
  expect(attempt.audit.citations).toEqual([{
    id: 'S1',
    sourceType: 'work-item',
    label: 'Owner [REDACTED_EMAIL]',
    href: '/teams/team-1/work-items/work-item-1',
    excerpt: 'Bearer [REDACTED_TOKEN]',
    capturedRevision: 2,
  }])
  const serialized = JSON.stringify(attempt.audit)
  expect(serialized).not.toContain('owner@example.com')
  expect(serialized).not.toContain('secret-value')
  expect(serialized).not.toContain('abc.def.ghi')
}

/** Optional source and private-identifier overrides for one service harness. */
type HarnessConfiguration = {
  /** Permission-filtered source context returned by the authorization fake. */
  promptContext?: string
  /** Private member labels made available only to the service alias boundary. */
  privateMemberIdentifiers?: readonly AiAssistancePrivateMemberIdentifiers[]
  /** Optional compatible triage routes used to exercise tuple validation. */
  triageRoutingTuples?: readonly AiAssistanceTriageRoutingTuple[]
  /** Optional assignee allowlist override for routing compatibility tests. */
  assigneeUserIds?: readonly string[]
  /** Optional Team allowlist override for routing compatibility tests. */
  teamIds?: readonly string[]
  /** Optional Project allowlist override for routing compatibility tests. */
  projectIds?: readonly string[]
  /** Optional Team-scoped custom-field definitions used by output validation tests. */
  customFieldDefinitions?: readonly AiAssistanceCustomFieldDefinition[]
  /** Optional citation label used to exercise disclosure-time bounds. */
  citationLabel?: string
  /** Optional citation excerpt used to exercise disclosure-time bounds. */
  citationExcerpt?: string
  /** Optional strict model draft used to exercise task-specific output validation. */
  outputDraft?: AiAssistanceDraft
  /** Optional end-to-end deadline used to exercise remaining-time enforcement. */
  generationDeadlineMs?: number
  /** Optional provider timeout used with the end-to-end deadline. */
  providerTimeoutMs?: number
  /** Milliseconds advanced after context resolution and before provider admission. */
  advanceBeforeProviderMs?: number
  /** Changes the policy revision while source context is being resolved. */
  changePolicyBeforeProvider?: boolean
  /** Changes the policy revision after the provider returns. */
  changePolicyAfterProvider?: boolean
  /** Disables the Workspace policy after the provider returns. */
  disablePolicyAfterProvider?: boolean
  /** Disables the member preference after the provider returns. */
  disablePreferenceAfterProvider?: boolean
  /** Source Team and Project routing used when validating triage fields. */
  triageSourceRouting?: AiAssistanceTriageSourceRouting
  /** Revokes source authorization after the generation record is persisted. */
  revokeAuthorizationAfterPersistence?: boolean
  /** Revokes source authorization immediately before the generation persistence call. */
  revokeAuthorizationBeforePersistence?: boolean
  /** Captures policy transitions sent to the optional audit boundary. */
  policyAuditRecords?: AiAssistancePolicyAuditInput[]
  /** Changes retention after the initial replay policy read. */
  shortenPolicyBeforeReplayProjection?: boolean
}

/** Creates a service harness with deterministic fake ports. */
function createHarness(configuration: HarnessConfiguration = {}) {
  let storedGeneration: StoredAiAssistanceGeneration | undefined
  let preferenceEnabled = true
  let policyEnabled = true
  let policyRetentionDays = 30
  let policyRevision = 0
  let policyReadCount = 0
  let currentTime = NOW
  let resolveContextCount = 0
  let gatewayBarrier: Promise<void> | undefined
  let signalGatewayStarted: (() => void) | undefined
  const gatewayStarted = new Promise<void>((resolve) => {
    signalGatewayStarted = resolve
  })
  let reservationKey: string | undefined
  let reservationFingerprint: string | undefined
  let reservationGenerationId: string | undefined
  let reservationLeaseExpiresAt: string | undefined
  let reservationStatus: 'pending' | 'completed' | 'failed' | undefined
  let reservationFailureCategory:
    FailAiAssistanceGenerationReservationInput['failureCategory'] | undefined
  let reservationFailureCode:
    FailAiAssistanceGenerationReservationInput['failureCode'] | undefined
  let budgetLimited = false
  let budgetReservationCount = 0
  let lastBudget: AiAssistanceGenerationBudgetReservation | undefined
  let authorizationState: AiAssistanceAuthorizationState = { current: true }
  let authorizationCheckCount = 0
  const gatewayInputs: AiModelGenerationInput[] = []
  const feedbackRecords: StoredAiAssistanceFeedback[] = []
  const feedbackCommitFences: unknown[] = []
  const startedAttempts: StartAiAssistanceGenerationAttemptInput[] = []
  const finalizedAttempts: FinalizeAiAssistanceGenerationAttemptInput[] = []
  const generationCommitFences: unknown[] = []
  const decisionCommitFences: unknown[] = []
  const failedReservations: FailAiAssistanceGenerationReservationInput[] = []
  let attemptStarted = false
  let attemptStartError: unknown
  let finalizeAttemptError: unknown
  let finalizeAttemptFailuresRemaining = 0
  let finalizeAttemptCallCount = 0
  let gatewayError: unknown
  let generationPersistenceError: unknown
  let policyPutCalls = 0
  let outputCitationId = 'S1'
  let outputItemId = 'overview-1'
  let outputText = 'Safe summary.'
  let uncertaintyReason = 'Evidence is complete.'
  const store: AiAssistanceStore = {
    async readGenerationReservation(input) {
      if (
        reservationKey !== input.idempotencyKey ||
        reservationFingerprint !== input.inputFingerprint
      ) return undefined
      if (reservationStatus === 'completed') {
        return { status: 'replay', generationId: reservationGenerationId ?? '' }
      }
      if (
        reservationStatus === 'failed' &&
        reservationFailureCategory !== undefined &&
        reservationFailureCode !== undefined
      ) {
        return {
          status: 'failed',
          generationId: reservationGenerationId ?? '',
          failureCategory: reservationFailureCategory,
          failureCode: reservationFailureCode,
        }
      }
      if (reservationStatus === 'pending' && attemptStarted) {
        return { status: 'pending', generationId: reservationGenerationId ?? '' }
      }
      return undefined
    },
    async reserveGeneration(input) {
      if (reservationKey === undefined) {
        if (budgetLimited) {
          throw new AiAssistanceError(
            'rate-limit',
            'AiAssistanceRateLimitExceeded',
            'AI assistance generation capacity is exhausted for this one-minute window.',
          )
        }
        budgetReservationCount += 1
        lastBudget = input.budget
        reservationKey = input.idempotencyKey
        reservationFingerprint = input.inputFingerprint
        reservationGenerationId = input.generationId
        reservationLeaseExpiresAt = input.leaseExpiresAt
        reservationStatus = 'pending'
        attemptStarted = false
        return { status: 'reserved', generationId: input.generationId }
      }
      if (
        reservationKey !== input.idempotencyKey ||
        reservationFingerprint !== input.inputFingerprint
      ) {
        throw new AiAssistanceError(
          'conflict',
          'AiAssistanceIdempotencyConflict',
          'The Idempotency-Key was reused with different input.',
        )
      }
      if (reservationStatus === 'completed') {
        return { status: 'replay', generationId: reservationGenerationId ?? '' }
      }
      if (
        reservationStatus === 'failed' &&
        reservationFailureCategory !== undefined &&
        reservationFailureCode !== undefined
      ) {
        return {
          status: 'failed',
          generationId: reservationGenerationId ?? '',
          failureCategory: reservationFailureCategory,
          failureCode: reservationFailureCode,
        }
      }
      if (
        !attemptStarted &&
        reservationLeaseExpiresAt !== undefined &&
        Date.parse(reservationLeaseExpiresAt) <= Date.parse(input.requestedAt)
      ) {
        reservationGenerationId = input.generationId
        reservationLeaseExpiresAt = input.leaseExpiresAt
        attemptStarted = false
        return { status: 'reserved', generationId: input.generationId }
      }
      return { status: 'pending', generationId: reservationGenerationId ?? '' }
    },
    async startGenerationAttempt(input) {
      if (
        reservationKey !== input.idempotencyKey ||
        reservationFingerprint !== input.inputFingerprint ||
        reservationGenerationId !== input.generationId
      ) throw new Error('Unexpected attempt start.')
      if (attemptStartError !== undefined) throw attemptStartError
      startedAttempts.push(input)
      attemptStarted = true
    },
    async finalizeGenerationAttempt(input) {
      if (
        reservationKey !== input.idempotencyKey ||
        reservationFingerprint !== input.inputFingerprint ||
        reservationGenerationId !== input.generationId ||
        reservationStatus !== 'pending' ||
        !attemptStarted
      ) throw new Error('Unexpected attempt completion.')
      finalizeAttemptCallCount += 1
      if (finalizeAttemptFailuresRemaining > 0) {
        finalizeAttemptFailuresRemaining -= 1
        throw finalizeAttemptError ?? new Error('Injected attempt finalization failure.')
      }
      finalizedAttempts.push(input)
      reservationStatus = input.outcome === 'succeeded' ? 'completed' : 'failed'
      reservationFailureCategory = input.failureCategory
      reservationFailureCode = input.failureCode
    },
    async failGenerationReservation(input) {
      if (
        reservationKey !== input.idempotencyKey ||
        reservationFingerprint !== input.inputFingerprint ||
        reservationGenerationId !== input.generationId ||
        reservationStatus !== 'pending' ||
        attemptStarted
      ) throw new Error('Unexpected reservation failure.')
      failedReservations.push(input)
      reservationStatus = 'failed'
      reservationFailureCategory = input.failureCategory
      reservationFailureCode = input.failureCode
    },
    async getPolicy() {
      policyReadCount += 1
      if (configuration.shortenPolicyBeforeReplayProjection && policyReadCount === 6) {
        policyRetentionDays = 1
        policyRevision = 1
      }
      return {
        ...createPolicy(),
        enabled: policyEnabled,
        retentionDays: policyRetentionDays,
        revision: policyRevision,
      }
    },
    async putPolicy(_workspaceId, policy) {
      policyPutCalls += 1
      return policy
    },
    async getPreference() {
      return preferenceEnabled
        ? undefined
        : {
            schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
            enabled: false,
            revision: 1,
            updatedAt: NOW,
          }
    },
    async putPreference(_workspaceId, _memberId, preference) {
      return preference
    },
    async createGeneration(record, commitFence) {
      if (generationPersistenceError !== undefined) throw generationPersistenceError
      generationCommitFences.push(commitFence)
      storedGeneration = record
      if (configuration.revokeAuthorizationAfterPersistence) {
        authorizationState = { current: false, reason: 'permission-changed' }
      }
      return record
    },
    async getGeneration() {
      return storedGeneration
    },
    async decideGeneration(_workspaceId, _generationId, request, decidedAt, commitFence) {
      if (!storedGeneration) throw new Error('Expected a stored generation.')
      decisionCommitFences.push(commitFence)
      storedGeneration = {
        ...storedGeneration,
        generation: {
          ...storedGeneration.generation,
          revision: storedGeneration.generation.revision + 1,
          decision: { outcome: request.outcome, decidedAt },
        },
      }
      return storedGeneration
    },
    async putFeedback(record, commitFence) {
      feedbackCommitFences.push(commitFence)
      const existing = feedbackRecords.find((candidate) =>
        candidate.feedbackId === record.feedbackId)
      if (existing?.inputFingerprint === record.inputFingerprint) return
      if (existing) {
        throw new AiAssistanceError(
          'conflict',
          'AiAssistanceIdempotencyConflict',
          'Feedback key conflict.',
        )
      }
      feedbackRecords.push(record)
    },
  }
  const service = createAiAssistanceService({
    gateway: {
      async generate(input) {
        gatewayInputs.push(input)
        signalGatewayStarted?.()
        if (gatewayBarrier) await gatewayBarrier
        if (gatewayError !== undefined) throw gatewayError
        if (configuration.changePolicyAfterProvider) policyRevision = 1
        if (configuration.disablePolicyAfterProvider) policyEnabled = false
        if (configuration.disablePreferenceAfterProvider) preferenceEnabled = false
        return {
          draft: configuration.outputDraft ?? {
            kind: 'summary',
            overview: {
              id: outputItemId,
              text: outputText,
              confidence: 'high',
              citationIds: [outputCitationId],
            },
            decisions: [],
            actions: [],
            risks: [],
          },
          uncertainty: { level: 'medium', reason: uncertaintyReason },
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            latencyMs: 30,
            costUnavailableReason: 'pricing-not-configured',
          },
        }
      },
    },
    store,
    defaultPolicy: createPolicy(),
    deploymentAllowedModelIds: ['model-1'],
    promptVersion: 'ai-assistance-v1',
    ...(configuration.policyAuditRecords === undefined
      ? {}
      : {
          policyAudit: {
            async record(input: AiAssistancePolicyAuditInput) {
              configuration.policyAuditRecords?.push(input)
            },
          },
        }),
    ...(configuration.generationDeadlineMs === undefined
      ? {}
      : { generationDeadlineMs: configuration.generationDeadlineMs }),
    ...(configuration.providerTimeoutMs === undefined
      ? {}
      : { providerTimeoutMs: configuration.providerTimeoutMs }),
    now: () => new Date(currentTime),
    createId: () => 'generation-1',
  })
  const authorization = {
    async resolveContext() {
      resolveContextCount += 1
      if (configuration.advanceBeforeProviderMs !== undefined) {
        currentTime = new Date(
          Date.parse(currentTime) + configuration.advanceBeforeProviderMs,
        ).toISOString()
      }
      if (configuration.changePolicyBeforeProvider) policyRevision = 1
      return {
        promptContext: configuration.promptContext ??
          'Authorized source for assignee@example.com and owner@example.com token=secret-value.',
        citations: [{
          id: 'S1',
          sourceType: 'work-item' as const,
          label: configuration.citationLabel ?? 'Owner owner@example.com',
          href: '/teams/team-1/work-items/work-item-1',
          excerpt: configuration.citationExcerpt ?? 'Bearer abc.def.ghi',
          capturedRevision: 2,
        }],
        authorizationToken: 'authorization-snapshot-1',
        privateMemberIdentifiers: configuration.privateMemberIdentifiers ?? [{
            memberId: 'assignee@example.com',
            providerAlias: ASSIGNEE_PROVIDER_ALIAS,
            identifiers: ['佐藤 花子', 'Sato Hanako'],
          }, {
            memberId: 'creator@example.com',
            providerAlias: CREATOR_PROVIDER_ALIAS,
            identifiers: [],
          }],
        allowedValues: {
          assigneeUserIds: configuration.assigneeUserIds ?? ['assignee@example.com'],
          creatorUserIds: ['creator@example.com'],
          teamIds: configuration.teamIds ?? ['team-1'],
          projectIds: configuration.projectIds ?? ['project-1'],
          customFieldIds: configuration.customFieldDefinitions === undefined
            ? ['field-1']
            : [...new Set(configuration.customFieldDefinitions.map((definition) =>
                definition.fieldId))],
          ...(configuration.customFieldDefinitions === undefined
            ? {}
            : { customFieldDefinitions: configuration.customFieldDefinitions }),
          relationIds: ['relation-1'],
          statuses: ['workflow-status-1'],
          workItemEndpoints: [{ teamId: 'team-1', workItemId: 'work-item-1' }],
          ...(configuration.triageRoutingTuples === undefined
            ? {}
            : { triageRoutingTuples: configuration.triageRoutingTuples }),
        },
        ...(configuration.triageSourceRouting === undefined
          ? {}
          : { triageSourceRouting: configuration.triageSourceRouting }),
      }
    },
    async isAuthorizationCurrent() {
      authorizationCheckCount += 1
      if (configuration.revokeAuthorizationBeforePersistence && authorizationCheckCount === 3) {
        authorizationState = { current: false, reason: 'source-changed' }
      }
      return authorizationState
    },
  }
  return {
    authorization,
    blockGatewayUntil(value: Promise<void>) {
      gatewayBarrier = value
    },
    gatewayStarted: () => gatewayStarted,
    feedbackRecords,
    feedbackCommitFences,
    failedReservations,
    finalizedAttempts,
    finalizeAttemptCallCount: () => finalizeAttemptCallCount,
    gatewayInputs,
    generationCommitFences,
    decisionCommitFences,
    budgetReservationCount: () => budgetReservationCount,
    lastBudget: () => lastBudget,
    policyPutCalls: () => policyPutCalls,
    resolveContextCount: () => resolveContextCount,
    authorizationCheckCount: () => authorizationCheckCount,
    service,
    startedAttempts,
    setAuthorizationState(value: AiAssistanceAuthorizationState) {
      authorizationState = value
    },
    setBudgetLimited(value: boolean) {
      budgetLimited = value
    },
    setAttemptStartError(value: unknown) {
      attemptStartError = value
    },
    setFinalizeAttemptFailures(count: number, error: unknown) {
      finalizeAttemptFailuresRemaining = count
      finalizeAttemptError = error
    },
    setGatewayError(value: unknown) {
      gatewayError = value
    },
    setGenerationPersistenceError(value: unknown) {
      generationPersistenceError = value
    },
    setOutputCitationId(value: string) {
      outputCitationId = value
    },
    setOutputItemId(value: string) {
      outputItemId = value
    },
    setOutputText(value: string) {
      outputText = value
    },
    setPreferenceEnabled(value: boolean) {
      preferenceEnabled = value
    },
    setPolicyEnabled(value: boolean) {
      policyEnabled = value
    },
    setPolicyRetentionDays(value: number) {
      policyRetentionDays = value
    },
    setPolicyRevision(value: number) {
      policyRevision = value
    },
    setNow(value: string) {
      currentTime = value
    },
    setUncertaintyReason(value: string) {
      uncertaintyReason = value
    },
    setStoredGenerationMemberId(memberId: string) {
      if (!storedGeneration) throw new Error('Expected a stored generation.')
      storedGeneration = { ...storedGeneration, memberId }
    },
    setStoredGenerationExpiresAt(expiresAt: string) {
      if (!storedGeneration) throw new Error('Expected a stored generation.')
      storedGeneration = {
        ...storedGeneration,
        generation: { ...storedGeneration.generation, expiresAt },
      }
    },
    storedGeneration() {
      return storedGeneration
    },
  }
}

describe('createAiAssistanceService', () => {
  test('does not expose Workspace policy to a non-manager', async () => {
    const harness = createHarness()

    await expect(harness.service.getPolicy({
      ...createActor(),
      canManagePolicy: false,
    })).rejects.toMatchObject({
      category: 'authorization',
      code: 'AiAssistanceDisabled',
    })
  })

  test('redacts operator input, source text, citations, and generated output before persistence', async () => {
    const harness = createHarness({
      promptContext: 'Authorized source for 佐藤 花子 and owner@example.com token=secret-value.',
    })
    harness.setOutputText(
      '佐藤 花子 confirmed. Email leaked@example.com Bearer generated.secret.token ' +
      '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    )
    harness.setOutputItemId('victim@example.com')
    harness.setUncertaintyReason('佐藤 花子 confirmed; password=generated-password')

    const generation = await harness.service.generate(
      createActor(),
      createSummaryRequest(
        'Ask 佐藤 花子 to contact requester@example.com with token=operator-secret',
      ),
      harness.authorization,
      'request-1',
    )

    expect(harness.gatewayInputs).toHaveLength(1)
    const gatewayInput = harness.gatewayInputs[0]
    expect(gatewayInput?.request).toEqual(createSummaryRequest(
      `Ask ${ASSIGNEE_PROVIDER_ALIAS} to contact ` +
        '[REDACTED_EMAIL] with token=[REDACTED_SECRET]',
    ))
    expect(JSON.stringify(gatewayInput)).not.toContain('佐藤 花子')
    expect(gatewayInput?.promptContext).not.toContain('owner@example.com')
    expect(gatewayInput?.promptContext).not.toContain('secret-value')
    expect(gatewayInput?.citations[0]?.label).toContain('[REDACTED_EMAIL]')
    expect(gatewayInput?.citations[0]?.excerpt).toContain('[REDACTED_TOKEN]')
    expect(gatewayInput?.allowedValues.assigneeUserIds).toEqual([
      ASSIGNEE_PROVIDER_ALIAS,
    ])
    expect(gatewayInput?.allowedValues.creatorUserIds).toEqual([
      CREATOR_PROVIDER_ALIAS,
    ])
    expect(gatewayInput?.promptContext).toContain(ASSIGNEE_PROVIDER_ALIAS)

    const serializedGeneration = JSON.stringify(generation)
    expect(serializedGeneration).not.toContain('leaked@example.com')
    expect(serializedGeneration).not.toContain('generated.secret.token')
    expect(serializedGeneration).not.toContain('BEGIN PRIVATE KEY')
    expect(serializedGeneration).not.toContain('generated-password')
    expect(serializedGeneration).not.toContain('victim@example.com')
    expect(serializedGeneration).toContain('[REDACTED_EMAIL]')
    expect(serializedGeneration).toContain('[REDACTED_PRIVATE_KEY]')
    expect(serializedGeneration).toContain('佐藤 花子 confirmed')
    if (
      generation.content.availability !== 'available' ||
      generation.content.draft.kind !== 'summary'
    ) {
      throw new Error('Expected an available Summary generation.')
    }
    expect(generation.content.draft.overview.id).toBe('summary-overview-1')
    const stored = harness.storedGeneration()
    expect(JSON.stringify(stored?.request)).not.toContain('requester@example.com')
    expect(stored?.auditedInput).not.toContain('owner@example.com')
    expect(stored?.auditedInput).not.toContain('secret-value')
    expect(stored?.auditedInput).not.toContain('佐藤 花子')
    expect(JSON.stringify(stored?.request)).not.toContain('佐藤 花子')
    expect(JSON.stringify(stored)).not.toContain('assignee@example.com')
    expect(JSON.stringify(stored)).not.toContain('victim@example.com')
    expect(JSON.stringify(harness.startedAttempts)).not.toContain('victim@example.com')
    expect(harness.startedAttempts).toEqual([{
      workspaceId: 'workspace-1',
      memberId: 'operator-1',
      idempotencyKey: 'request-1',
      inputFingerprint: expect.any(String),
      generationId: 'generation-1',
      task: 'summary',
      modelId: 'model-1',
      promptVersion: 'ai-assistance-v1',
      traceId: 'trace-1',
      startedAt: NOW,
      audit: {
        request: createSummaryRequest(
          `Ask ${ASSIGNEE_PROVIDER_ALIAS} to contact ` +
            '[REDACTED_EMAIL] with token=[REDACTED_SECRET]',
        ),
        auditedInput:
          `Authorized source for ${ASSIGNEE_PROVIDER_ALIAS} and ` +
            '[REDACTED_EMAIL] token=[REDACTED_SECRET]',
        citations: [{
          id: 'S1',
          sourceType: 'work-item',
          label: 'Owner [REDACTED_EMAIL]',
          href: '/teams/team-1/work-items/work-item-1',
          excerpt: 'Bearer [REDACTED_TOKEN]',
          capturedRevision: 2,
        }],
      },
    }])
    expect(harness.startedAttempts[0]?.audit).toEqual({
      request: gatewayInput?.request,
      auditedInput: gatewayInput?.promptContext,
      citations: gatewayInput?.citations,
    })
    expect(harness.finalizedAttempts).toEqual([{
      workspaceId: 'workspace-1',
      memberId: 'operator-1',
      idempotencyKey: 'request-1',
      inputFingerprint: expect.any(String),
      generationId: 'generation-1',
      outcome: 'succeeded',
      endedAt: NOW,
      latencyMs: 30,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 30,
        costUnavailableReason: 'pricing-not-configured',
      },
    }])
  })

  test('masks general-source person, phone, and address PII before provider and audit use', async () => {
    const harness = createHarness({
      promptContext: [
        '氏名: 山田 太郎',
        '電話: 090-1234-5678',
        '住所: 東京都千代田区丸の内1-1-1',
        'Release 1.20.300 remains useful context.',
      ].join('\n'),
    })

    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-pii-source',
    )

    const providerContext = harness.gatewayInputs[0]?.promptContext ?? ''
    expect(providerContext).not.toContain('山田 太郎')
    expect(providerContext).not.toContain('090-1234-5678')
    expect(providerContext).not.toContain('東京都千代田区丸の内1-1-1')
    expect(providerContext).toContain('[REDACTED_PERSON]')
    expect(providerContext).toContain('[REDACTED_PHONE]')
    expect(providerContext).toContain('[REDACTED_ADDRESS]')
    expect(providerContext).toContain('Release 1.20.300')
    expect(harness.storedGeneration()?.auditedInput).toBe(providerContext)
    expect(harness.startedAttempts[0]?.audit.auditedInput).toBe(providerContext)
  })

  test('aliases private members beyond the 100 structured-value candidate cap', async () => {
    const boundaryMemberId = 'boundary-member@example.com'
    const boundaryAlias = 'U_test_boundary_member_0101'
    const privateMemberIdentifiers: AiAssistancePrivateMemberIdentifiers[] = [
      {
        memberId: 'assignee@example.com',
        providerAlias: ASSIGNEE_PROVIDER_ALIAS,
        identifiers: ['Assignee'],
      },
      {
        memberId: 'creator@example.com',
        providerAlias: CREATOR_PROVIDER_ALIAS,
        identifiers: ['Creator'],
      },
      ...Array.from({ length: 98 }, (_, index) => ({
        memberId: `private-${String(index).padStart(3, '0')}@example.com`,
        providerAlias: `U_test_private_${String(index).padStart(4, '0')}`,
        identifiers: [`Private Member ${index}`],
      })),
      {
        memberId: boundaryMemberId,
        providerAlias: boundaryAlias,
        identifiers: ['Boundary Person'],
      },
    ]
    const harness = createHarness({
      promptContext: `Boundary Person (${boundaryMemberId}) owns this source.`,
      privateMemberIdentifiers,
    })

    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-private-member-boundary',
    )

    const gatewayInput = harness.gatewayInputs[0]
    expect(privateMemberIdentifiers).toHaveLength(101)
    expect(gatewayInput?.promptContext).toContain(boundaryAlias)
    expect(gatewayInput?.promptContext).not.toContain(boundaryMemberId)
    expect(gatewayInput?.promptContext).not.toContain('Boundary Person')
    expect(gatewayInput?.allowedValues.assigneeUserIds).toEqual([
      ASSIGNEE_PROVIDER_ALIAS,
    ])
    expect(gatewayInput?.allowedValues.creatorUserIds).toEqual([
      CREATOR_PROVIDER_ALIAS,
    ])
  })

  test('keeps an ambiguous duplicate member display name redacted after authorization', async () => {
    const harness = createHarness({
      promptContext: 'Shared Member owns the visible source.',
      privateMemberIdentifiers: [
        {
          memberId: 'assignee@example.com',
          providerAlias: ASSIGNEE_PROVIDER_ALIAS,
          identifiers: ['Shared Member'],
        },
        {
          memberId: 'another@example.com',
          providerAlias: 'U_test_another_0002',
          identifiers: ['Shared Member'],
        },
        {
          memberId: 'creator@example.com',
          providerAlias: CREATOR_PROVIDER_ALIAS,
          identifiers: [],
        },
      ],
    })
    harness.setOutputText('Shared Member should review the result.')

    const generation = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-ambiguous-member',
    )

    expect(JSON.stringify(harness.gatewayInputs[0])).not.toContain('Shared Member')
    expect(JSON.stringify(generation)).not.toContain('Shared Member')
    expect(JSON.stringify(generation)).toContain('[REDACTED_PERSON]')
  })

  test('does not disclose a private member outside the resolved allowlists', async () => {
    const hiddenAlias = 'U_test_hidden_0003'
    const harness = createHarness({
      promptContext: 'Hidden Person owns the visible source.',
      privateMemberIdentifiers: [
        {
          memberId: 'assignee@example.com',
          providerAlias: ASSIGNEE_PROVIDER_ALIAS,
          identifiers: ['Assignee'],
        },
        {
          memberId: 'hidden@example.com',
          providerAlias: hiddenAlias,
          identifiers: ['Hidden Person'],
        },
        {
          memberId: 'creator@example.com',
          providerAlias: CREATOR_PROVIDER_ALIAS,
          identifiers: [],
        },
      ],
    })
    harness.setOutputText(`${hiddenAlias} should review the result.`)

    const generation = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-hidden-member-disclosure',
    )

    const serializedGeneration = JSON.stringify(generation)
    expect(serializedGeneration).not.toContain('Hidden Person')
    expect(serializedGeneration).not.toContain(hiddenAlias)
    expect(serializedGeneration).toContain('[REDACTED_PERSON]')
  })

  test('rejects duplicate or malformed resolver member aliases before provider use', async () => {
    for (const [idempotencyKey, privateMemberIdentifiers] of [
      [
        'request-duplicate-provider-alias',
        [
          {
            memberId: 'assignee@example.com',
            providerAlias: ASSIGNEE_PROVIDER_ALIAS,
            identifiers: ['Assignee'],
          },
          {
            memberId: 'creator@example.com',
            providerAlias: ASSIGNEE_PROVIDER_ALIAS,
            identifiers: ['Creator'],
          },
        ],
      ],
      [
        'request-malformed-provider-alias',
        [
          {
            memberId: 'assignee@example.com',
            providerAlias: 'U unsafe alias',
            identifiers: ['Assignee'],
          },
          {
            memberId: 'creator@example.com',
            providerAlias: CREATOR_PROVIDER_ALIAS,
            identifiers: ['Creator'],
          },
        ],
      ],
    ] satisfies ReadonlyArray<readonly [string, AiAssistancePrivateMemberIdentifiers[]]>) {
      const harness = createHarness({ privateMemberIdentifiers })

      await expect(harness.service.generate(
        createActor(),
        createSummaryRequest(),
        harness.authorization,
        idempotencyKey,
      )).rejects.toMatchObject({ code: 'InvalidAiAssistanceRequest' })
      expect(harness.gatewayInputs).toHaveLength(0)
    }
  })

  test('rejects member allowlists without complete private alias metadata', async () => {
    const harness = createHarness({
      privateMemberIdentifiers: [{
        memberId: 'assignee@example.com',
        providerAlias: ASSIGNEE_PROVIDER_ALIAS,
        identifiers: ['Assignee'],
      }],
    })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-missing-private-member-alias',
    )).rejects.toMatchObject({ code: 'InvalidAiAssistanceRequest' })
    expect(harness.gatewayInputs).toHaveLength(0)
  })

  test('durably finalizes a provider timeout and terminally replays the safe failure', async () => {
    const harness = createHarness()
    harness.setGatewayError(new AiAssistanceError(
      'timeout',
      'AiAssistanceProviderTimeout',
      'Provider detail that must not be persisted.',
    ))

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(harness.service.generate(
        createActor(),
        createSummaryRequest(),
        harness.authorization,
        'request-timeout',
      )).rejects.toMatchObject({
        category: 'timeout',
        code: 'AiAssistanceProviderTimeout',
      })
    }

    expect(harness.gatewayInputs).toHaveLength(1)
    expect(harness.budgetReservationCount()).toBe(1)
    expect(harness.startedAttempts).toHaveLength(1)
    expectSafeSummaryAttemptAudit(harness.startedAttempts[0])
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      latencyMs: 0,
      usageUnavailableReason: 'provider-did-not-report',
      failureCategory: 'timeout',
      failureCode: 'AiAssistanceProviderTimeout',
    })])
    expect(JSON.stringify(harness.finalizedAttempts)).not.toContain('Provider detail')
    expect(JSON.stringify({
      attempts: harness.startedAttempts,
      outcomes: harness.finalizedAttempts,
    })).not.toContain('Provider detail')
  })

  test('retains provider usage when generation persistence fails after inference', async () => {
    const harness = createHarness()
    harness.setGenerationPersistenceError(new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'DynamoDB detail with secret=must-not-persist.',
    ))

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-persistence-failure',
    )).rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })

    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      latencyMs: 30,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 30,
        costUnavailableReason: 'pricing-not-configured',
      },
      failureCategory: 'upstream',
      failureCode: 'AiAssistancePersistenceError',
    })])
    expectSafeSummaryAttemptAudit(harness.startedAttempts[0])
    expect(JSON.stringify(harness.finalizedAttempts)).not.toContain('must-not-persist')
    expect(harness.storedGeneration()).toBeUndefined()
  })

  test('does not invoke the provider when the durable attempt start write fails', async () => {
    const harness = createHarness()
    harness.setAttemptStartError(new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'Injected attempt start failure.',
    ))

    for (let retry = 0; retry < 2; retry += 1) {
      await expect(harness.service.generate(
        createActor(),
        createSummaryRequest(),
        harness.authorization,
        'request-start-failure',
      )).rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })
    }

    expect(harness.gatewayInputs).toHaveLength(0)
    expect(harness.startedAttempts).toHaveLength(0)
    expect(harness.failedReservations).toEqual([expect.objectContaining({
      failureCode: 'AiAssistancePersistenceError',
    })])
    expect(harness.budgetReservationCount()).toBe(1)
  })

  test('keeps a started receipt pending when failure finalization fails', async () => {
    const harness = createHarness()
    harness.setGatewayError(new AiAssistanceError(
      'timeout',
      'AiAssistanceProviderTimeout',
      'Injected provider timeout.',
    ))
    harness.setFinalizeAttemptFailures(1, new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'Injected failure finalization failure.',
    ))

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-failure-finalize',
    )).rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })
    harness.setNow('2026-08-25T00:01:00.000Z')
    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-failure-finalize',
    )).rejects.toMatchObject({ code: 'AiAssistanceGenerationInProgress' })

    expect(harness.gatewayInputs).toHaveLength(1)
    expect(harness.startedAttempts).toHaveLength(1)
    expect(harness.finalizedAttempts).toHaveLength(0)
    expect(harness.finalizeAttemptCallCount()).toBe(1)
    expect(harness.budgetReservationCount()).toBe(1)
  })

  test('repairs success finalization before a changed preference gate without another provider call', async () => {
    const harness = createHarness()
    harness.setFinalizeAttemptFailures(1, new AiAssistanceError(
      'upstream',
      'AiAssistancePersistenceError',
      'Injected success finalization failure.',
    ))

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-success-repair',
    )).rejects.toMatchObject({ code: 'AiAssistancePersistenceError' })
    harness.setPreferenceEnabled(false)
    const repaired = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-success-repair',
    )

    expect(repaired.id).toBe('generation-1')
    expect(harness.gatewayInputs).toHaveLength(1)
    expect(harness.budgetReservationCount()).toBe(1)
    expect(harness.finalizeAttemptCallCount()).toBe(2)
    expect(harness.finalizedAttempts).toHaveLength(1)
    expect(harness.finalizedAttempts[0]).toEqual(expect.objectContaining({
      outcome: 'succeeded',
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 20 }),
    }))
    expect(Object.hasOwn(harness.finalizedAttempts[0] ?? {}, 'providerTraceId')).toBeFalse()
  })

  test('uses UTF-8 bytes to reject multibyte context before provider execution', async () => {
    const asciiContext = 'a'.repeat(50_000)
    const japaneseContext = '界'.repeat(50_000)
    const emojiContext = '😀'.repeat(25_000)
    expect(japaneseContext.length).toBe(asciiContext.length)
    expect(emojiContext.length).toBe(asciiContext.length)
    expect(Buffer.byteLength(japaneseContext, 'utf8')).toBeGreaterThan(
      Buffer.byteLength(asciiContext, 'utf8'),
    )
    expect(Buffer.byteLength(emojiContext, 'utf8')).toBeGreaterThan(
      Buffer.byteLength(asciiContext, 'utf8'),
    )

    const asciiHarness = createHarness({ promptContext: asciiContext })
    await expect(asciiHarness.service.generate(
      createActor(),
      createSummaryRequest(),
      asciiHarness.authorization,
      'request-ascii',
    )).resolves.toMatchObject({ id: 'generation-1' })
    expect(asciiHarness.gatewayInputs).toHaveLength(1)

    for (const [key, promptContext] of [
      ['request-japanese', japaneseContext],
      ['request-emoji', emojiContext],
    ]) {
      const harness = createHarness({ promptContext })
      await expect(harness.service.generate(
        createActor(),
        createSummaryRequest(),
        harness.authorization,
        key,
      )).rejects.toMatchObject({
        category: 'validation',
        code: 'InvalidAiAssistanceRequest',
      })
      expect(harness.gatewayInputs).toHaveLength(0)
      expect(harness.storedGeneration()).toBeUndefined()
      expect(harness.failedReservations).toEqual([expect.objectContaining({
        failureCategory: 'validation',
        failureCode: 'InvalidAiAssistanceRequest',
      })])
    }
  })

  test('rejects an unknown model citation before persistence', async () => {
    const harness = createHarness()
    harness.setOutputCitationId('S999')

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceCitationInvalid' })
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 20 }),
      failureCategory: 'validation',
      failureCode: 'AiAssistanceCitationInvalid',
    })])
    expectSafeSummaryAttemptAudit(harness.startedAttempts[0])
  })

  test('retains redacted audit evidence when structured provider output is invalid', async () => {
    const harness = createHarness()
    harness.setOutputText('')

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-invalid-output',
    )).rejects.toMatchObject({
      category: 'upstream',
      code: 'InvalidAiAssistanceOutput',
    })

    expect(harness.storedGeneration()).toBeUndefined()
    expectSafeSummaryAttemptAudit(harness.startedAttempts[0])
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 20 }),
      failureCategory: 'upstream',
      failureCode: 'InvalidAiAssistanceOutput',
    })])
  })

  test('retains a provider trace when invalid output reaches terminal attempt audit', async () => {
    const harness = createHarness()
    harness.setGatewayError(new AiAssistanceError(
      'upstream',
      'InvalidAiAssistanceOutput',
      'Injected invalid structured output.',
      undefined,
      undefined,
      'provider-invalid-output-trace',
    ))

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-invalid-output-trace',
    )).rejects.toMatchObject({ code: 'InvalidAiAssistanceOutput' })

    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      providerTraceId: 'provider-invalid-output-trace',
    })])
  })

  test('rejects Work Item planning fields for a Planning target source', async () => {
    const harness = createHarness({
      outputDraft: {
        kind: 'planning',
        subtasks: [{
          id: 'subtask-1',
          title: 'Review migration validation',
          priority: 'high',
          reason: 'The work item is independently reviewable.',
          confidence: 'high',
          citationIds: ['S1'],
        }],
        dependencies: [],
      },
    })

    await expect(harness.service.generate(
      createActor(),
      createPlanningRequest('planning-target'),
      harness.authorization,
      'request-planning-target-work-item-fields',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'InvalidAiAssistanceOutput',
    })
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCode: 'InvalidAiAssistanceOutput',
    })])
  })

  test('rejects a Planning status update for a Work Item source', async () => {
    const harness = createHarness({
      outputDraft: {
        kind: 'planning',
        subtasks: [],
        dependencies: [],
        statusUpdate: {
          health: 'at-risk',
          risk: 'medium',
          summary: 'The migration needs another rehearsal.',
          riskSummary: 'Rollback coverage is incomplete.',
          decisionSummary: 'Keep the staged launch.',
          helpNeeded: 'Request an additional reviewer.',
          nextAction: 'Schedule the rehearsal.',
          confidence: 'medium',
          citationIds: ['S1'],
        },
      },
    })

    await expect(harness.service.generate(
      createActor(),
      createPlanningRequest('work-item'),
      harness.authorization,
      'request-work-item-status-update',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'InvalidAiAssistanceOutput',
    })
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCode: 'InvalidAiAssistanceOutput',
    })])
  })

  test('rejects an empty Work Item planning draft', async () => {
    const harness = createHarness({
      outputDraft: {
        kind: 'planning',
        subtasks: [],
        dependencies: [],
      },
    })

    await expect(harness.service.generate(
      createActor(),
      createPlanningRequest('work-item'),
      harness.authorization,
      'request-empty-work-item-planning',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'InvalidAiAssistanceOutput',
    })
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCode: 'InvalidAiAssistanceOutput',
    })])
  })

  test('revalidates a draft after private identifier disclosure expands its text', async () => {
    const longDisplayName = 'A'.repeat(500)
    const harness = createHarness({
      privateMemberIdentifiers: [
        {
          memberId: 'assignee@example.com',
          providerAlias: ASSIGNEE_PROVIDER_ALIAS,
          identifiers: [longDisplayName],
        },
        {
          memberId: 'creator@example.com',
          providerAlias: CREATOR_PROVIDER_ALIAS,
          identifiers: [],
        },
      ],
      outputDraft: {
        kind: 'planning',
        title: {
          value: ASSIGNEE_PROVIDER_ALIAS,
          reason: 'Use the visible source.',
          confidence: 'high',
          citationIds: ['S1'],
        },
        subtasks: [],
        dependencies: [],
      },
    })

    await expect(harness.service.generate(
      createActor(),
      createPlanningRequest('work-item'),
      harness.authorization,
      'request-privacy-expanded-title',
    )).rejects.toMatchObject({
      category: 'upstream',
      code: 'InvalidAiAssistanceOutput',
    })
    expect(harness.gatewayInputs).toHaveLength(1)
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCode: 'InvalidAiAssistanceOutput',
    })])
  })

  test('revalidates disclosed citation bounds before persistence', async () => {
    const longDisplayName = 'A'.repeat(500)
    const citationLabel = `Owner ${ASSIGNEE_PROVIDER_ALIAS} ${'x'.repeat(470)}`
    const harness = createHarness({
      citationLabel,
      privateMemberIdentifiers: [
        {
          memberId: 'assignee@example.com',
          providerAlias: ASSIGNEE_PROVIDER_ALIAS,
          identifiers: [longDisplayName],
        },
        {
          memberId: 'creator@example.com',
          providerAlias: CREATOR_PROVIDER_ALIAS,
          identifiers: [],
        },
      ],
    })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-privacy-expanded-citation',
    )).rejects.toMatchObject({
      category: 'upstream',
      code: 'InvalidAiAssistanceRecord',
    })
    expect(harness.gatewayInputs).toHaveLength(1)
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCode: 'InvalidAiAssistanceRecord',
    })])
  })

  test('rechecks source authorization before invoking the provider', async () => {
    const harness = createHarness()
    harness.setAuthorizationState({ current: false, reason: 'permission-changed' })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceAuthorizationChanged' })
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.gatewayInputs).toHaveLength(0)
    expect(harness.startedAttempts).toHaveLength(1)
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCategory: 'conflict',
      failureCode: 'AiAssistanceAuthorizationChanged',
    })])
  })

  test('withholds an existing generation after source access changes', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    harness.setAuthorizationState({ current: false, reason: 'source-changed' })

    const generation = await harness.service.getGeneration(
      createActor(),
      'generation-1',
      harness.authorization,
    )
    expect(generation.content).toEqual({
      availability: 'withheld',
      reasonCode: 'source-changed',
    })
  })

  test('withholds an existing generation immediately after policy retention shortens', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    harness.setPolicyRetentionDays(1)
    harness.setNow('2026-08-27T00:00:00.000Z')

    const generation = await harness.service.getGeneration(
      createActor(),
      'generation-1',
      harness.authorization,
    )

    expect(generation.expiresAt).toBe('2026-08-26T00:00:00.000Z')
    expect(generation.content).toEqual({
      availability: 'withheld',
      reasonCode: 'retention-expired',
    })
    expect(JSON.stringify(generation)).not.toContain('Safe summary.')
    expect(JSON.stringify(generation)).not.toContain('/teams/team-1/work-items/work-item-1')
  })

  test('rejects feedback after the effective retention deadline', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    harness.setPolicyRetentionDays(1)
    harness.setNow('2026-08-27T00:00:00.000Z')

    await expect(harness.service.createFeedback(
      createActor(),
      'generation-1',
      { rating: 'helpful' },
      'feedback-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceGenerationNotFound' })
    expect(harness.feedbackRecords).toHaveLength(0)
  })

  test('does not start Bedrock when source resolution exhausts the end-to-end deadline', async () => {
    const harness = createHarness({
      generationDeadlineMs: 2_000,
      providerTimeoutMs: 500,
      advanceBeforeProviderMs: 1_500,
    })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceProviderTimeout' })
    expect(harness.gatewayInputs).toHaveLength(0)
    expect(harness.failedReservations).toHaveLength(0)
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCategory: 'timeout',
      failureCode: 'AiAssistanceProviderTimeout',
    })])
  })

  test('measures the end-to-end deadline from the request boundary', async () => {
    const harness = createHarness({
      generationDeadlineMs: 2_500,
      providerTimeoutMs: 1_000,
    })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-boundary-deadline',
      Date.parse(NOW) - 2_000,
    )).rejects.toMatchObject({ code: 'AiAssistanceProviderTimeout' })
    expect(harness.gatewayInputs).toHaveLength(0)
  })

  test('projects the persisted generation through a final authorization check', async () => {
    const harness = createHarness({ revokeAuthorizationAfterPersistence: true })

    const generation = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-final-projection',
    )

    expect(generation.content).toEqual({
      availability: 'withheld',
      reasonCode: 'permission-changed',
    })
  })

  test('does not persist a draft when source authorization changes at the commit fence', async () => {
    const harness = createHarness({ revokeAuthorizationBeforePersistence: true })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-commit-source-fence',
    )).rejects.toMatchObject({
      category: 'conflict',
      code: 'AiAssistanceSourceChanged',
    })
    expect(harness.authorizationCheckCount()).toBe(3)
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCategory: 'conflict',
      failureCode: 'AiAssistanceSourceChanged',
    })])
  })

  test('rejects a deployment-disallowed requested model before source retrieval', async () => {
    const harness = createHarness()
    const request = { ...createSummaryRequest(), modelId: 'model-2' }

    await expect(harness.service.generate(
      createActor(),
      request,
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceModelNotAllowed' })
    expect(harness.gatewayInputs).toHaveLength(0)
  })

  test('rechecks policy and member preference before invoking the provider', async () => {
    const harness = createHarness({ changePolicyBeforeProvider: true })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-policy-changed',
    )).rejects.toMatchObject({
      category: 'conflict',
      code: 'AiAssistanceAuthorizationChanged',
    })
    expect(harness.gatewayInputs).toHaveLength(0)
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCategory: 'conflict',
      failureCode: 'AiAssistanceAuthorizationChanged',
    })])
  })

  test('discards provider output when governance changes after inference', async () => {
    for (const [label, configuration, category] of [
      ['policy-revision', { changePolicyAfterProvider: true }, 'conflict'],
      ['policy-disabled', { disablePolicyAfterProvider: true }, 'authorization'],
      ['member-opt-out', { disablePreferenceAfterProvider: true }, 'authorization'],
    ] as const) {
      const harness = createHarness(configuration)

      await expect(harness.service.generate(
        createActor(),
        createSummaryRequest(),
        harness.authorization,
        `request-post-provider-${label}`,
      )).rejects.toMatchObject({
        category,
        code: expect.any(String),
      })
      expect(harness.gatewayInputs).toHaveLength(1)
      expect(harness.storedGeneration()).toBeUndefined()
      expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
        outcome: 'failed',
      })])
    }
  })

  test('rejects generated identifiers outside current allowlists', async () => {
    const gatewayInputs: AiModelGenerationInput[] = []
    const harness = createHarness()
    const service = createAiAssistanceService({
      gateway: {
        async generate(input) {
          gatewayInputs.push(input)
          return {
            draft: {
              kind: 'triage',
              assigneeUserId: {
                value: 'U999',
                reason: 'Suggested owner.',
                confidence: 'high',
                citationIds: ['S1'],
              },
              customFields: [],
            },
            uncertainty: { level: 'low', reason: 'Clear.' },
            usage: { latencyMs: 1, costUnavailableReason: 'pricing-not-configured' },
          }
        },
      },
      store: neverStore(),
      defaultPolicy: createPolicy(),
      deploymentAllowedModelIds: ['model-1'],
      promptVersion: 'ai-assistance-v1',
      now: () => new Date(NOW),
      createId: () => 'generation-1',
    })
    const request: GenerateAiAssistanceRequest = {
      task: 'triage',
      locale: 'ja',
      source: {
        type: 'triage-entry',
        teamId: 'team-1',
        triageEntryId: 'triage-1',
        expectedRevision: 1,
      },
    }

    await expect(service.generate(
      createActor(),
      request,
      harness.authorization,
      'request-1',
    ))
      .rejects.toMatchObject({ code: 'AiAssistanceOutputNotAllowed' })
    expect(gatewayInputs).toHaveLength(1)
  })

  test('accepts a canonical member identifier after restoring a provider alias', async () => {
    const longMemberId = `member-${'x'.repeat(313)}`
    const providerAlias = 'U_long_member_0001'
    const harness = createHarness({
      privateMemberIdentifiers: [{
        memberId: longMemberId,
        providerAlias,
        identifiers: ['Long Member'],
      }, {
        memberId: 'creator@example.com',
        providerAlias: CREATOR_PROVIDER_ALIAS,
        identifiers: [],
      }],
      assigneeUserIds: [longMemberId],
      outputDraft: {
        kind: 'triage',
        assigneeUserId: {
          value: providerAlias,
          reason: 'The provider-local member alias is grounded in the source.',
          confidence: 'high',
          citationIds: ['S1'],
        },
        customFields: [],
      },
    })
    const request: GenerateAiAssistanceRequest = {
      task: 'triage',
      locale: 'en',
      source: {
        type: 'triage-entry',
        teamId: 'team-1',
        triageEntryId: 'triage-1',
        expectedRevision: 1,
      },
    }

    const generation = await harness.service.generate(
      createActor(),
      request,
      harness.authorization,
      'request-long-member-id',
    )

    if (
      generation.content.availability !== 'available' ||
      generation.content.draft.kind !== 'triage'
    ) throw new Error('Expected an available Triage generation.')
    expect(generation.content.draft.assigneeUserId?.value).toBe(longMemberId)
    expect(harness.gatewayInputs[0]?.allowedValues.assigneeUserIds).toEqual([providerAlias])
  })

  test('rejects a triage routing tuple that mixes independently allowed values', async () => {
    const harness = createHarness({
      assigneeUserIds: ['assignee@example.com'],
      teamIds: ['team-a', 'team-b'],
      projectIds: ['project-a', 'project-b'],
      triageRoutingTuples: [{
        teamId: 'team-a',
        projectId: 'project-a',
        assigneeUserIds: ['assignee@example.com'],
      }, {
        teamId: 'team-b',
        projectId: 'project-b',
        assigneeUserIds: ['assignee@example.com'],
      }],
      outputDraft: {
        kind: 'triage',
        teamId: {
          value: 'team-a',
          reason: 'The destination is owned by Team A.',
          confidence: 'high',
          citationIds: ['S1'],
        },
        projectId: {
          value: 'project-b',
          reason: 'The destination is Project B.',
          confidence: 'high',
          citationIds: ['S1'],
        },
        assigneeUserId: {
          value: 'assignee@example.com',
          reason: 'The active owner can handle the route.',
          confidence: 'medium',
          citationIds: ['S1'],
        },
        customFields: [],
      },
    })
    const request: GenerateAiAssistanceRequest = {
      task: 'triage',
      locale: 'ja',
      source: {
        type: 'triage-entry',
        teamId: 'team-1',
        triageEntryId: 'triage-1',
        expectedRevision: 1,
      },
    }

    await expect(harness.service.generate(
      createActor(),
      request,
      harness.authorization,
      'request-incompatible-routing',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'AiAssistanceOutputNotAllowed',
    })
    expect(harness.storedGeneration()).toBeUndefined()
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCode: 'AiAssistanceOutputNotAllowed',
    })])
  })

  test('inherits the source Project when validating an assignee-only triage draft', async () => {
    const harness = createHarness({
      privateMemberIdentifiers: [{
        memberId: 'assignee@example.com',
        providerAlias: ASSIGNEE_PROVIDER_ALIAS,
        identifiers: ['佐藤 花子', 'Sato Hanako'],
      }, {
        memberId: 'other@example.com',
        providerAlias: 'U_other_member',
        identifiers: [],
      }, {
        memberId: 'creator@example.com',
        providerAlias: CREATOR_PROVIDER_ALIAS,
        identifiers: [],
      }],
      teamIds: ['team-a'],
      projectIds: ['project-a', 'project-b'],
      triageSourceRouting: { teamId: 'team-a', projectId: 'project-a' },
      triageRoutingTuples: [{
        teamId: 'team-a',
        projectId: 'project-a',
        assigneeUserIds: ['other@example.com'],
      }, {
        teamId: 'team-a',
        projectId: 'project-b',
        assigneeUserIds: ['assignee@example.com'],
      }],
      outputDraft: {
        kind: 'triage',
        assigneeUserId: {
          value: 'assignee@example.com',
          reason: 'The suggested owner is available.',
          confidence: 'high',
          citationIds: ['S1'],
        },
        customFields: [],
      },
    })

    await expect(harness.service.generate(
      createActor(),
      {
        task: 'triage',
        locale: 'en',
        source: {
          type: 'request-submission',
          formId: 'form-1',
          submissionId: 'submission-1',
          expectedRevision: 1,
        },
      },
      harness.authorization,
      'request-source-project-routing',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'AiAssistanceOutputNotAllowed',
    })
    expect(harness.storedGeneration()).toBeUndefined()
  })

  test('rejects an excluded sensitive custom field without auditing its model value', async () => {
    const harness = createHarness({
      outputDraft: {
        kind: 'triage',
        customFields: [{
          fieldId: 'customer-phone',
          value: 9_012_345_678,
          reason: 'Provider-controlled rationale.',
          confidence: 'high',
          citationIds: ['S1'],
        }],
      },
    })
    const request: GenerateAiAssistanceRequest = {
      task: 'triage',
      locale: 'ja',
      source: {
        type: 'triage-entry',
        teamId: 'team-1',
        triageEntryId: 'triage-1',
        expectedRevision: 1,
      },
    }

    await expect(harness.service.generate(
      createActor(),
      request,
      harness.authorization,
      'request-sensitive-custom-field',
    )).rejects.toMatchObject({ code: 'AiAssistanceOutputNotAllowed' })

    expect(harness.gatewayInputs[0]?.allowedValues.customFieldIds).toEqual(['field-1'])
    expect(harness.storedGeneration()).toBeUndefined()
    expect(JSON.stringify(harness.startedAttempts)).not.toContain('customer-phone')
    expect(JSON.stringify(harness.startedAttempts)).not.toContain('9012345678')
    expect(JSON.stringify(harness.finalizedAttempts)).not.toContain('customer-phone')
    expect(JSON.stringify(harness.finalizedAttempts)).not.toContain('9012345678')
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      failureCategory: 'validation',
      failureCode: 'AiAssistanceOutputNotAllowed',
    })])
  })

  test('validates triage custom fields against the selected Team schema', async () => {
    const definitions: AiAssistanceCustomFieldDefinition[] = [{
      teamId: 'team-a',
      fieldId: 'team-a-only',
      type: 'text',
      required: false,
    }, {
      teamId: 'team-b',
      fieldId: 'release-channel',
      type: 'select',
      required: false,
      optionIds: ['beta'],
    }]
    const request: GenerateAiAssistanceRequest = {
      task: 'triage',
      locale: 'en',
      source: {
        type: 'triage-entry',
        teamId: 'team-a',
        triageEntryId: 'triage-1',
        expectedRevision: 1,
      },
    }
    for (const [key, field] of [
      ['wrong-team', {
        fieldId: 'team-a-only',
        value: 'should not cross Teams',
      }],
      ['invalid-option', {
        fieldId: 'release-channel',
        value: 'production',
      }],
    ] as const) {
      const harness = createHarness({
        teamIds: ['team-a', 'team-b'],
        customFieldDefinitions: definitions,
        outputDraft: {
          kind: 'triage',
          teamId: {
            value: 'team-b',
            reason: 'Team B owns this request.',
            confidence: 'high',
            citationIds: ['S1'],
          },
          customFields: [{
            ...field,
            reason: 'The field is suggested by the source.',
            confidence: 'medium',
            citationIds: ['S1'],
          }],
        },
      })
      await expect(harness.service.generate(
        createActor(),
        request,
        harness.authorization,
        `request-custom-field-${key}`,
      )).rejects.toMatchObject({
        category: 'validation',
        code: 'AiAssistanceOutputNotAllowed',
      })
      expect(harness.storedGeneration()).toBeUndefined()
    }
  })

  test('uses source routing to validate request-submission custom fields', async () => {
    const harness = createHarness({
      teamIds: ['team-a'],
      projectIds: ['project-a'],
      triageSourceRouting: { teamId: 'team-a', projectId: 'project-a' },
      customFieldDefinitions: [{
        teamId: 'team-a',
        fieldId: 'project-field',
        type: 'text',
        required: false,
        projectIds: ['project-a'],
      }],
      outputDraft: {
        kind: 'triage',
        customFields: [{
          fieldId: 'project-field',
          value: 'valid for the source Project',
          reason: 'The source route selects this field.',
          confidence: 'high',
          citationIds: ['S1'],
        }],
      },
    })

    const generation = await harness.service.generate(
      createActor(),
      {
        task: 'triage',
        locale: 'en',
        source: {
          type: 'request-submission',
          formId: 'form-1',
          submissionId: 'submission-1',
          expectedRevision: 1,
        },
      },
      harness.authorization,
      'request-source-routing-field',
    )

    expect(generation.content.availability).toBe('available')
    expect(harness.storedGeneration()).toBeDefined()
  })

  test('rejects currency values that exceed the configured precision', async () => {
    const harness = createHarness({
      customFieldDefinitions: [{
        teamId: 'team-1',
        fieldId: 'yen-budget',
        type: 'currency',
        required: false,
        currencyCode: 'JPY',
      }],
      outputDraft: {
        kind: 'triage',
        customFields: [{
          fieldId: 'yen-budget',
          value: 1.5,
          reason: 'Fractional yen is not supported.',
          confidence: 'high',
          citationIds: ['S1'],
        }],
      },
    })

    await expect(harness.service.generate(
      createActor(),
      {
        task: 'triage',
        locale: 'en',
        source: {
          type: 'triage-entry',
          teamId: 'team-1',
          triageEntryId: 'triage-1',
          expectedRevision: 1,
        },
      },
      harness.authorization,
      'request-currency-precision',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'AiAssistanceOutputNotAllowed',
    })
    expect(harness.storedGeneration()).toBeUndefined()
  })

  test('rejects empty values for required custom fields', async () => {
    const request: GenerateAiAssistanceRequest = {
      task: 'triage',
      locale: 'en',
      source: {
        type: 'triage-entry',
        teamId: 'team-1',
        triageEntryId: 'triage-1',
        expectedRevision: 1,
      },
    }
    const cases: Array<{
      label: string
      value: string | string[]
      type: AiAssistanceCustomFieldDefinition['type']
      optionIds?: string[]
    }> = [
      { label: 'empty text', value: '', type: 'text' },
      { label: 'whitespace text', value: ' \t\n', type: 'text' },
      { label: 'empty multi-select', value: [], type: 'multi-select', optionIds: ['option-1'] },
    ]

    for (const testCase of cases) {
      const harness = createHarness({
        customFieldDefinitions: [{
          teamId: 'team-1',
          fieldId: 'required-field',
          type: testCase.type,
          required: true,
          ...(testCase.optionIds === undefined ? {} : { optionIds: testCase.optionIds }),
        }],
        outputDraft: {
          kind: 'triage',
          customFields: [{
            fieldId: 'required-field',
            value: testCase.value,
            reason: 'The source suggests this field.',
            confidence: 'high',
            citationIds: ['S1'],
          }],
        },
      })

      await expect(harness.service.generate(
        createActor(),
        request,
        harness.authorization,
        `request-required-custom-field-${testCase.label.replaceAll(' ', '-')}`,
      )).rejects.toMatchObject({
        category: 'validation',
        code: 'AiAssistanceOutputNotAllowed',
      })
      expect(harness.storedGeneration()).toBeUndefined()
    }
  })

  test('rejects control characters in text custom-field suggestions', async () => {
    const harness = createHarness({
      customFieldDefinitions: [{
        teamId: 'team-1',
        fieldId: 'text-field',
        type: 'text',
        required: false,
      }],
      outputDraft: {
        kind: 'triage',
        customFields: [{
          fieldId: 'text-field',
          value: 'safe\u0000text',
          reason: 'The source suggests this text.',
          confidence: 'high',
          citationIds: ['S1'],
        }],
      },
    })

    await expect(harness.service.generate(
      createActor(),
      {
        task: 'triage',
        locale: 'en',
        source: {
          type: 'triage-entry',
          teamId: 'team-1',
          triageEntryId: 'triage-1',
          expectedRevision: 1,
        },
      },
      harness.authorization,
      'request-control-character-custom-field',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'AiAssistanceOutputNotAllowed',
    })
    expect(harness.storedGeneration()).toBeUndefined()
  })

  test('replays the same generation key without invoking the provider again', async () => {
    const harness = createHarness()

    const first = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    harness.setBudgetLimited(true)
    const replay = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )

    expect(replay).toEqual(first)
    expect(harness.gatewayInputs).toHaveLength(1)
    expect(harness.budgetReservationCount()).toBe(1)
    expect(harness.lastBudget()).toEqual({
      windowStartedAt: '2026-08-25T00:00:00.000Z',
      windowExpiresAt: '2026-08-25T00:01:00.000Z',
      reservedTokens: 1_000_000,
      workspaceGenerationLimit: 32,
      memberGenerationLimit: 4,
      workspaceTokenLimit: 32_000_000,
      memberTokenLimit: 4_000_000,
    })
  })

  test('replays a completed generation after the member opts out', async () => {
    const harness = createHarness()
    const first = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-opt-out-replay',
    )
    harness.setPreferenceEnabled(false)

    const replay = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-opt-out-replay',
    )

    expect(replay).toEqual(first)
    expect(harness.gatewayInputs).toHaveLength(1)
    expect(harness.budgetReservationCount()).toBe(1)
  })

  test('replays with the current retention policy after the receipt read', async () => {
    const harness = createHarness({ shortenPolicyBeforeReplayProjection: true })
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-retention-replay',
    )
    harness.setNow('2026-08-27T00:00:00.000Z')

    const replay = await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-retention-replay',
    )

    expect(replay.content).toEqual({
      availability: 'withheld',
      reasonCode: 'retention-expired',
    })
    expect(JSON.stringify(replay)).not.toContain('Safe summary.')
  })

  test('rejects one generation key reused with different redacted input', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest('Different focus'),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceIdempotencyConflict' })
    expect(harness.gatewayInputs).toHaveLength(1)
  })

  test('fails closed when a replay receipt points at another member generation', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    harness.setStoredGenerationMemberId('another-member')

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'InvalidAiAssistanceRecord' })
    expect(harness.gatewayInputs).toHaveLength(1)
  })

  test('redacts and idempotently stores feedback comments', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    const feedback: CreateAiAssistanceFeedbackRequest = {
      rating: 'helpful',
      comment: 'Contact feedback@example.com token=feedback-secret',
    }

    await harness.service.createFeedback(
      createActor(),
      'generation-1',
      feedback,
      'feedback-1',
    )
    await harness.service.createFeedback(
      createActor(),
      'generation-1',
      feedback,
      'feedback-1',
    )

    expect(harness.feedbackRecords).toHaveLength(1)
    expect(harness.feedbackRecords[0]?.feedback.comment).toBe(
      'Contact [REDACTED_EMAIL] token=[REDACTED_SECRET]',
    )
    expect(harness.feedbackCommitFences[0]).toEqual(expect.objectContaining({
      effectiveExpiresAt: harness.feedbackRecords[0]?.expiresAt,
      commitAt: harness.feedbackRecords[0]?.createdAt,
    }))
    await expect(harness.service.createFeedback(
      createActor(),
      'generation-1',
      { rating: 'not-helpful', comment: 'Different' },
      'feedback-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceIdempotencyConflict' })
  })

  test('rejects feedback when redaction expands it beyond the public bound', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-feedback-bound',
    )
    const comment = `${'x'.repeat(1975)} sk-${'a'.repeat(16)}`

    await expect(harness.service.createFeedback(
      createActor(),
      'generation-1',
      { rating: 'helpful', comment },
      'feedback-bound',
    )).rejects.toMatchObject({
      category: 'validation',
      code: 'InvalidAiAssistanceRequest',
    })
    expect(harness.feedbackRecords).toHaveLength(0)
  })

  test('rejects a member opt-out before source resolution or provider execution', async () => {
    const harness = createHarness()
    harness.setPreferenceEnabled(false)

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistancePreferenceDisabled' })
    expect(harness.resolveContextCount()).toBe(0)
    expect(harness.gatewayInputs).toHaveLength(0)
  })

  test('rejects an exhausted durable budget before source resolution or provider execution', async () => {
    const harness = createHarness()
    harness.setBudgetLimited(true)

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({
      category: 'rate-limit',
      code: 'AiAssistanceRateLimitExceeded',
    })
    expect(harness.resolveContextCount()).toBe(0)
    expect(harness.gatewayInputs).toHaveLength(0)
  })

  test('returns an in-progress conflict for a nonexpired concurrent retry', async () => {
    const harness = createHarness()
    let releaseGateway = () => {}
    const gatewayBarrier = new Promise<void>((resolve) => {
      releaseGateway = resolve
    })
    harness.blockGatewayUntil(gatewayBarrier)
    const first = harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    await harness.gatewayStarted()

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceGenerationInProgress' })
    expect(harness.gatewayInputs).toHaveLength(1)

    releaseGateway()
    await first
  })

  test('rejects duplicate policy values instead of silently normalizing them', async () => {
    const harness = createHarness()

    await expect(harness.service.updatePolicy(createActor(), {
      enabled: true,
      allowedModelIds: ['model-1', 'model-1'],
      defaultModelId: 'model-1',
      enabledTasks: ['summary', 'summary'],
      retentionDays: 30,
      expectedRevision: 0,
    }, {
      isCurrent: async () => true,
    })).rejects.toMatchObject({ code: 'InvalidAiAssistanceRequest' })
  })

  test('rechecks management authorization immediately before a policy write', async () => {
    const harness = createHarness()

    await expect(harness.service.updatePolicy(createActor(), {
      enabled: true,
      allowedModelIds: ['model-1'],
      defaultModelId: 'model-1',
      enabledTasks: ['summary'],
      retentionDays: 30,
      expectedRevision: 0,
    }, {
      isCurrent: async () => false,
    })).rejects.toMatchObject({
      category: 'authorization',
      code: 'AiAssistanceAuthorizationChanged',
    })
    expect(harness.policyPutCalls()).toBe(0)
  })

  test('audits a successfully persisted policy transition', async () => {
    const policyAuditRecords: AiAssistancePolicyAuditInput[] = []
    const harness = createHarness({ policyAuditRecords })

    const policy = await harness.service.updatePolicy(createActor(), {
      enabled: true,
      allowedModelIds: ['model-1'],
      defaultModelId: 'model-1',
      enabledTasks: ['summary'],
      retentionDays: 30,
      expectedRevision: 0,
    }, {
      isCurrent: async () => true,
    })

    expect(policyAuditRecords).toHaveLength(1)
    expect(policyAuditRecords[0]).toMatchObject({
      workspaceId: 'workspace-1',
      memberId: 'operator-1',
      actorId: 'operator-actor-1',
      actorKind: 'user',
      previousPolicy: expect.objectContaining({ revision: 0 }),
      nextPolicy: expect.objectContaining({
        revision: 1,
        enabledTasks: ['summary'],
      }),
    })
    expect(policy.revision).toBe(1)
  })

  test('treats the same decision outcome as replay despite a stale expected revision', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    const first = await harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'approved', expectedRevision: 1 },
      harness.authorization,
    )
    const replay = await harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'approved', expectedRevision: 1 },
      harness.authorization,
    )

    expect(replay).toEqual(first)
    await expect(harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'rejected', expectedRevision: 1 },
      harness.authorization,
    )).rejects.toMatchObject({ code: 'AiAssistanceDecisionAlreadyRecorded' })
  })

  test('withholds an idempotent decision replay after source authorization changes', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    await harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'approved', expectedRevision: 1 },
      harness.authorization,
    )
    harness.setAuthorizationState({ current: false, reason: 'permission-changed' })

    const replay = await harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'approved', expectedRevision: 1 },
      harness.authorization,
    )

    expect(replay.content).toEqual({
      availability: 'withheld',
      reasonCode: 'permission-changed',
    })
  })

  test('withholds an idempotent decision replay after policy retention shortens', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    await harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'approved', expectedRevision: 1 },
      harness.authorization,
    )
    harness.setPolicyRetentionDays(1)
    harness.setNow('2026-08-27T00:00:00.000Z')

    const replay = await harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'approved', expectedRevision: 1 },
      harness.authorization,
    )

    expect(replay.expiresAt).toBe('2026-08-26T00:00:00.000Z')
    expect(replay.content).toEqual({
      availability: 'withheld',
      reasonCode: 'retention-expired',
    })
    expect(JSON.stringify(replay)).not.toContain('Safe summary.')
    expect(JSON.stringify(replay)).not.toContain('/teams/team-1/work-items/work-item-1')
  })

  test('withholds an expired generation without persisting a decision', async () => {
    const harness = createHarness()
    await harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )
    harness.setStoredGenerationExpiresAt('2026-08-24T23:59:59.999Z')

    const expired = await harness.service.decideGeneration(
      createActor(),
      'generation-1',
      { outcome: 'approved', expectedRevision: 1 },
      harness.authorization,
    )

    expect(expired.content).toEqual({
      availability: 'withheld',
      reasonCode: 'retention-expired',
    })
    expect(harness.storedGeneration()?.generation.decision).toBeUndefined()
  })

  test('rejects unsafe generation budget configuration during construction', () => {
    const gateway = {
      async generate() {
        throw new Error('Provider execution is not expected.')
      },
    }
    expect(() => createAiAssistanceService({
      gateway,
      store: neverStore(),
      defaultPolicy: createPolicy(),
      deploymentAllowedModelIds: ['model-1'],
      promptVersion: 'ai-assistance-v1',
      memberGenerationLimitPerMinute: 0,
    })).toThrow('generation budget configuration is invalid')

    expect(() => createAiAssistanceService({
      gateway,
      store: neverStore(),
      defaultPolicy: createPolicy(),
      deploymentAllowedModelIds: ['model-1'],
      promptVersion: 'ai-assistance-v1',
      memberTokenLimitPerMinute: 999_999,
      worstCaseTokensPerGeneration: 1_000_000,
    })).toThrow('generation budget configuration is invalid')
  })
})

/** Creates a store that supports defaults and rejects unexpected persistence. */
function neverStore(): AiAssistanceStore {
  return {
    async readGenerationReservation() { return undefined },
    async reserveGeneration(input) {
      return { status: 'reserved', generationId: input.generationId }
    },
    async startGenerationAttempt() {},
    async finalizeGenerationAttempt() {},
    async failGenerationReservation() {},
    async getPolicy() { return undefined },
    async putPolicy(_workspaceId, policy) { return policy },
    async getPreference() { return undefined },
    async putPreference(_workspaceId, _memberId, preference) { return preference },
    async createGeneration() { throw new Error('Generation must not be persisted.') },
    async getGeneration() { return undefined },
    async decideGeneration() { throw new Error('Decision is not expected.') },
    async putFeedback() { throw new Error('Feedback is not expected.') },
  }
}
