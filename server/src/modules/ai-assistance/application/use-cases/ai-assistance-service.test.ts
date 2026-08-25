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
  AiAssistanceGenerationBudgetReservation,
  AiAssistancePrivateMemberIdentifiers,
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
  /** Optional strict model draft used to exercise task-specific output validation. */
  outputDraft?: AiAssistanceDraft
}

/** Creates a service harness with deterministic fake ports. */
function createHarness(configuration: HarnessConfiguration = {}) {
  let storedGeneration: StoredAiAssistanceGeneration | undefined
  let preferenceEnabled = true
  let policyRetentionDays = 30
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
  const gatewayInputs: AiModelGenerationInput[] = []
  const feedbackRecords: StoredAiAssistanceFeedback[] = []
  const startedAttempts: StartAiAssistanceGenerationAttemptInput[] = []
  const finalizedAttempts: FinalizeAiAssistanceGenerationAttemptInput[] = []
  const failedReservations: FailAiAssistanceGenerationReservationInput[] = []
  let attemptStarted = false
  let attemptStartError: unknown
  let finalizeAttemptError: unknown
  let finalizeAttemptFailuresRemaining = 0
  let finalizeAttemptCallCount = 0
  let gatewayError: unknown
  let generationPersistenceError: unknown
  let outputCitationId = 'S1'
  let outputItemId = 'overview-1'
  let outputText = 'Safe summary.'
  let uncertaintyReason = 'Evidence is complete.'
  const store: AiAssistanceStore = {
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
      return { ...createPolicy(), retentionDays: policyRetentionDays }
    },
    async putPolicy(_workspaceId, policy) {
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
    async createGeneration(record) {
      if (generationPersistenceError !== undefined) throw generationPersistenceError
      storedGeneration = record
      return record
    },
    async getGeneration() {
      return storedGeneration
    },
    async decideGeneration(_workspaceId, _generationId, request, decidedAt) {
      if (!storedGeneration) throw new Error('Expected a stored generation.')
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
    async putFeedback(record) {
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
    now: () => new Date(currentTime),
    createId: () => 'generation-1',
  })
  const authorization = {
    async resolveContext() {
      resolveContextCount += 1
      return {
        promptContext: configuration.promptContext ??
          'Authorized source for assignee@example.com and owner@example.com token=secret-value.',
        citations: [{
          id: 'S1',
          sourceType: 'work-item' as const,
          label: 'Owner owner@example.com',
          href: '/teams/team-1/work-items/work-item-1',
          excerpt: 'Bearer abc.def.ghi',
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
          assigneeUserIds: ['assignee@example.com'],
          creatorUserIds: ['creator@example.com'],
          teamIds: ['team-1'],
          projectIds: ['project-1'],
          customFieldIds: ['field-1'],
          relationIds: ['relation-1'],
          statuses: ['workflow-status-1'],
          workItemEndpoints: [{ teamId: 'team-1', workItemId: 'work-item-1' }],
        },
      }
    },
    async isAuthorizationCurrent() {
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
    failedReservations,
    finalizedAttempts,
    finalizeAttemptCallCount: () => finalizeAttemptCallCount,
    gatewayInputs,
    budgetReservationCount: () => budgetReservationCount,
    lastBudget: () => lastBudget,
    resolveContextCount: () => resolveContextCount,
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
    setPolicyRetentionDays(value: number) {
      policyRetentionDays = value
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

  test('repairs success finalization after generation storage without another provider call', async () => {
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
      category: 'validation',
      code: 'InvalidAiAssistanceOutput',
    })

    expect(harness.storedGeneration()).toBeUndefined()
    expectSafeSummaryAttemptAudit(harness.startedAttempts[0])
    expect(harness.finalizedAttempts).toEqual([expect.objectContaining({
      outcome: 'failed',
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 20 }),
      failureCategory: 'validation',
      failureCode: 'InvalidAiAssistanceOutput',
    })])
  })

  test('discards output when authorization changes during inference', async () => {
    const harness = createHarness()
    harness.setAuthorizationState({ current: false, reason: 'permission-changed' })

    await expect(harness.service.generate(
      createActor(),
      createSummaryRequest(),
      harness.authorization,
      'request-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceAuthorizationChanged' })
    expect(harness.storedGeneration()).toBeUndefined()
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
    await expect(harness.service.createFeedback(
      createActor(),
      'generation-1',
      { rating: 'not-helpful', comment: 'Different' },
      'feedback-1',
    )).rejects.toMatchObject({ code: 'AiAssistanceIdempotencyConflict' })
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
    })).rejects.toMatchObject({ code: 'InvalidAiAssistanceRequest' })
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
