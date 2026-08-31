import { describe, expect, test } from 'bun:test'
import { GetCommand, type GetCommandOutput } from '@aws-sdk/lib-dynamodb'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistanceDraft,
  type AiAssistanceGeneration,
  type AiAssistanceSource,
  type GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import {
  createAiAssistanceFeedbackIdentity,
  createAiAssistanceFeedbackRecordKey,
  createAiAssistanceGenerationInputFingerprint,
  createAiAssistanceGenerationRecordKey,
  createAiAssistanceIdempotencyRecordKey,
  parseGenerateAiAssistanceRequest,
} from '../../src/modules/ai-assistance'
import {
  evaluateAiAssistanceLive,
  runAiAssistanceLiveCommitPreflight,
  runAiAssistanceLiveEvalCli,
  type AiAssistanceLiveDynamoGet,
  type AiAssistanceLiveEvalFailureCode,
  type AiAssistanceLiveFetch,
  type AiAssistanceLiveHttpResponse,
  type AiAssistanceLiveJourney,
} from './evaluate-ai-assistance-live'

const EXPECTED_COMMIT_SHA = '1234567890abcdef1234567890abcdef12345678'
const OTHER_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const ACCESS_TOKEN = 'synthetic-access-token-secret'
const SYNTHETIC_EMAIL = 'live-eval@example.test'
const SYNTHETIC_PASSWORD = 'synthetic-password-secret'
const FORBIDDEN_CANARY = 'RAW_SECRET_CANARY_123'
const PRIVATE_MODEL_ID = 'private-model-identifier'
const PRIVATE_TRACE_ID = 'private-trace-identifier'
const WITHHELD_GENERATION_ID = 'private-withheld-generation-identifier'
const PERMISSION_WITHHELD_GENERATION_ID = 'private-permission-withheld-generation-id'
const RETENTION_WITHHELD_GENERATION_ID = 'private-retention-withheld-generation-id'
const MISMATCHED_MODEL_ID = 'private-mismatched-model-identifier'
const PRIVATE_JWT = 'eyJhbGciOiJIUzI1NiJ9.cHJpdmF0ZS1wYXlsb2Fk.cHJpdmF0ZS1zaWduYXR1cmU'
const AWS_REGION = 'ap-northeast-1'
const DURABILITY_TABLE_NAME = 'private-ai-assistance-table'
const SYNTHETIC_WORKSPACE_ID = 'private-synthetic-workspace-id'
const SYNTHETIC_MEMBER_ID = 'private-synthetic-member-id'
const STALE_GENERATION_ID = 'private-stale-generation-identifier'
const POST_PROVIDER_TEAM_ID = 'private-post-provider-team-id'
const POST_PROVIDER_WORK_ITEM_ID = 'private-post-provider-work-item-id'
const POST_PROVIDER_TITLE_A = 'Synthetic provider fence title A'
const POST_PROVIDER_TITLE_B = 'Synthetic provider fence title B'
const POST_PROVIDER_GENERATION_ID = 'private-post-provider-generation-id'
const POST_PROVIDER_INITIAL_REVISION = 11
const SAFE_AUDITED_INPUT = 'Safe synthetic source context.'
const PRIVATE_AWS_ACCOUNT_ID = '123456789012'
const TEST_API_BASE_URL = 'https://production.example.test'
const TEST_API_BASE_URL_ALLOWLIST: readonly string[] = [TEST_API_BASE_URL]
const GENERATION_EXPIRES_AT = '2026-09-30T00:00:00.000Z'
const GENERATION_TTL_EPOCH_SECONDS = 1_790_726_400
const LIVE_EVALUATION_NOW_MS = Date.parse('2026-08-31T00:05:00.000Z')
const EXPIRED_EVALUATION_NOW_MS = Date.parse('2026-10-01T00:00:00.000Z')
const DURABILITY_INPUT = {
  awsRegion: AWS_REGION,
  durabilityTableName: DURABILITY_TABLE_NAME,
}
const DURABILITY_ENVIRONMENT = {
  AI_ASSISTANCE_LIVE_EVAL_AWS_REGION: AWS_REGION,
  AI_ASSISTANCE_LIVE_EVAL_TABLE_NAME: DURABILITY_TABLE_NAME,
}

/** One deterministic journey and its strict synthetic API request. */
type FakeLiveCase = {
  /** Stable live journey label. */
  journey: AiAssistanceLiveJourney
  /** Strict request used by both the fake API and fake persistence evidence. */
  request: GenerateAiAssistanceRequest
}

const LIVE_CASES = [
  {
    journey: 'request',
    request: {
      task: 'triage',
      locale: 'en',
      source: {
        type: 'request-submission',
        formId: 'private-request-form-id',
        submissionId: 'private-request-submission-id',
        expectedRevision: 3,
      },
    },
  },
  {
    journey: 'triage',
    request: {
      task: 'triage',
      locale: 'en',
      source: {
        type: 'triage-entry',
        teamId: 'private-triage-team-id',
        triageEntryId: 'private-triage-entry-id',
        expectedRevision: 4,
      },
    },
  },
  {
    journey: 'work-item',
    request: {
      task: 'summary',
      locale: 'en',
      sources: [{
        type: 'work-item',
        teamId: 'private-work-item-team-id',
        workItemId: 'private-work-item-id',
        expectedRevision: 5,
      }],
    },
  },
  {
    journey: 'planning',
    request: {
      task: 'planning',
      locale: 'en',
      source: {
        type: 'planning-target',
        target: {
          type: 'initiative',
          entityId: 'private-planning-entity-id',
        },
        expectedRevision: 6,
      },
    },
  },
  {
    journey: 'document',
    request: {
      task: 'summary',
      locale: 'en',
      sources: [{
        type: 'document',
        documentId: 'private-document-id',
        expectedRevision: 7,
      }],
    },
  },
  {
    journey: 'search',
    request: {
      task: 'search',
      locale: 'en',
      query: 'Private synthetic search text that must not enter the report.',
    },
  },
] satisfies readonly FakeLiveCase[]

const STALE_REVISION_REQUEST: GenerateAiAssistanceRequest = {
  task: 'triage',
  locale: 'en',
  source: {
    type: 'triage-entry',
    teamId: 'private-stale-team-id',
    triageEntryId: 'private-stale-entry-id',
    expectedRevision: 999,
  },
}

/** Deterministic protected fixture with one exact request for every required journey. */
const LIVE_FIXTURE: unknown = {
  schemaVersion: 1,
  cases: LIVE_CASES,
  staleRevisionRequest: STALE_REVISION_REQUEST,
  postProviderSourceFence: {
    teamId: POST_PROVIDER_TEAM_ID,
    workItemId: POST_PROVIDER_WORK_ITEM_ID,
    locale: 'en',
    titleA: POST_PROVIDER_TITLE_A,
    titleB: POST_PROVIDER_TITLE_B,
  },
  withheld: [
    {
      generationId: PERMISSION_WITHHELD_GENERATION_ID,
      reasonCode: 'permission-changed',
    },
    {
      generationId: WITHHELD_GENERATION_ID,
      reasonCode: 'source-changed',
    },
    {
      generationId: RETENTION_WITHHELD_GENERATION_ID,
      reasonCode: 'retention-expired',
    },
  ],
  forbiddenSubstrings: [FORBIDDEN_CANARY],
  expectedModelId: PRIVATE_MODEL_ID,
  expectedPromptVersion: 'ai-assistance-v1',
  budgets: {
    maxLatencyMsPerGeneration: 12_000,
    maxInputTokensPerGeneration: 2_000,
    maxOutputTokensPerGeneration: 1_000,
    maxCostUsdPerGeneration: 0.1,
    maxTotalInputTokens: 12_000,
    maxTotalOutputTokens: 6_000,
    maxTotalCostUsd: 0.6,
  },
  durability: {
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    memberId: SYNTHETIC_MEMBER_ID,
  },
}

/** Options controlling one deterministic fake deployed API. */
type FakeLiveApiOptions = {
  /** Commit SHA exposed by the fake liveness response. */
  commitSha?: string
  /** Ordered commit SHAs overriding successive liveness responses. */
  healthCommitShas?: readonly string[]
  /** Journey whose otherwise-valid response includes a forbidden canary. */
  unsafeJourney?: AiAssistanceLiveJourney
  /** Access-token expiration returned by the synthetic login route. */
  accessTokenExpiresAt?: number
  /** Journey whose response echoes the injected access token. */
  leakedAccessTokenJourney?: AiAssistanceLiveJourney
  /** Journey whose response contains a JWT-shaped credential. */
  leakedJwtJourney?: AiAssistanceLiveJourney
  /** Journey whose response exceeds the evaluator response-size limit. */
  oversizedJourney?: AiAssistanceLiveJourney
  /** Journey whose model and prompt identifiers differ from the fixture. */
  providerMismatchJourney?: AiAssistanceLiveJourney
  /** Journey whose provider omits trustworthy cost evidence. */
  missingUsageJourney?: AiAssistanceLiveJourney
  /** Journey whose provider evidence exceeds every per-case budget. */
  overBudgetJourney?: AiAssistanceLiveJourney
  /** Journey whose second response omits server-owned replay evidence. */
  missingReplayJourney?: AiAssistanceLiveJourney
  /** Journey whose first response is incorrectly marked as a replay. */
  unexpectedFirstReplayJourney?: AiAssistanceLiveJourney
  /** Whether feedback replay omits its server-owned replay evidence. */
  missingFeedbackReplay?: boolean
  /** Whether the decision response changes an immutable generation field. */
  invalidDecisionMutation?: boolean
  /** Whether the withheld lookup returns a different generation identifier. */
  invalidWithheldGenerationId?: boolean
  /** Whether the canonical Work Item PATCH loses its first committed response. */
  postProviderMutationResponseLoss?: boolean
  /** Whether the first active-drill receipt read fails after the server starts work. */
  postProviderInitialReceiptReadFailure?: boolean
  /** Whether the server completes generation after the evaluator cancels its local wait. */
  postProviderCompletesAfterClientAbort?: boolean
  /** Stable conflict returned by the post-provider source fence. */
  postProviderFailureCode?: 'AiAssistanceSourceChanged' | 'AiAssistanceAuthorizationChanged'
  /** One exact persisted invariant corrupted for a fail-closed durability test. */
  durabilityMutation?: FakeDurabilityMutation
}

/** Exact fake persisted invariant selected for one negative test. */
type FakeDurabilityMutation =
  | 'receipt-link'
  | 'attempt-status'
  | 'attempt-provider-start'
  | 'attempt-usage'
  | 'audit-schema'
  | 'audit-canary'
  | 'audit-credential'
  | 'receipt-retention'
  | 'generation-link'
  | 'generation-retention'
  | 'stale-attempt'
  | 'stale-generation'
  | 'stale-retention'
  | 'decision'
  | 'feedback'
  | 'feedback-retention'
  | 'post-provider-attempt-timeout'
  | 'post-provider-outcome'
  | 'post-provider-generation'
  | 'post-provider-zero-usage'
  | 'post-provider-replay-overwrite'
  | 'aws-error'

/** Mutable fake state shared by the HTTP race and strong-read evidence boundary. */
type FakePostProviderSourceFenceState = {
  /** Opaque generation key captured from the first drill request. */
  generationIdempotencyKey?: string
  /** Strict dynamically revisioned drill request. */
  request?: GenerateAiAssistanceRequest
  /** Current persisted attempt phase exposed by the fake strong read. */
  phase: 'idle' | 'started' | 'provider-free' | 'failed' | 'completed'
  /** Current alternating title. */
  title: string
  /** Current monotonically increasing revision. */
  revision: number
  /** Opaque Work Item mutation key used for response-loss replay. */
  mutationIdempotencyKey?: string
  /** Whether the same generation key has already replayed. */
  generationReplayed: boolean
  /** Number of provider invocations started for the drill key. */
  providerInvocationCount: number
}

/** Observations captured without logging any protected request values. */
type FakeLiveApi = {
  /** Injectable HTTP implementation. */
  fetch: AiAssistanceLiveFetch
  /** Number of requests received by the fake API. */
  requestCount(): number
  /** Whether the unauthenticated commit probe was the first request. */
  commitProbeWasFirst(): boolean
  /** Number of response bodies canceled without parsing. */
  discardedBodyCount(): number
  /** Number of canceled response bodies that had already been read. */
  discardedBodyAfterReadCount(): number
  /** Number of calls to the unbounded full-body Response method. */
  responseTextCallCount(): number
  /** Number of approval or feedback mutation requests received. */
  reviewMutationCount(): number
  /** Ordered API paths received without retaining query or request content. */
  requestPaths(): readonly string[]
  /** Strongly consistent exact-key DynamoDB fake for this HTTP transcript. */
  dynamoGet: AiAssistanceLiveDynamoGet
  /** Commands received by the fake DynamoDB boundary. */
  dynamoCommands(): readonly GetCommand[]
  /** Ordered HTTP and DynamoDB boundary events. */
  operationEvents(): readonly string[]
  /** Number of real-provider invocations made for the active drill key. */
  postProviderInvocationCount(): number
}

/** Creates a deterministic API supporting the complete successful live-evaluation sequence. */
function createFakeLiveApi(options: FakeLiveApiOptions = {}): FakeLiveApi {
  let requestCount = 0
  let firstPath: string | undefined
  let discardedBodyCount = 0
  let discardedBodyAfterReadCount = 0
  let responseTextCallCount = 0
  let reviewMutationCount = 0
  const requestPaths: string[] = []
  const operationEvents: string[] = []
  let healthRequestCount = 0
  const generationKeys = new Map<string, AiAssistanceLiveJourney>()
  const postProviderState: FakePostProviderSourceFenceState = {
    phase: 'idle',
    title: POST_PROVIDER_TITLE_A,
    revision: POST_PROVIDER_INITIAL_REVISION,
    generationReplayed: false,
    providerInvocationCount: 0,
  }
  let completePostProviderMutation: (() => void) | undefined
  const postProviderMutationCompleted = new Promise<void>((resolve) => {
    completePostProviderMutation = resolve
  })
  let postProviderResponseLossInjected = false
  let nextJourneyIndex = 0
  const journeyOrder: readonly AiAssistanceLiveJourney[] = [
    'request',
    'triage',
    'work-item',
    'planning',
    'document',
    'search',
  ]

  /** Adds stream-cancel observations to one fake response. */
  function observeResponse(
    response: AiAssistanceLiveHttpResponse,
  ): AiAssistanceLiveHttpResponse {
    let bodyRead = false
    let encodedBody: Uint8Array | undefined
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        bodyRead = true
        encodedBody ??= new TextEncoder().encode(await response.text())
        if (offset >= encodedBody.byteLength) {
          controller.close()
          return
        }
        const nextOffset = Math.min(offset + 64 * 1024, encodedBody.byteLength)
        controller.enqueue(encodedBody.slice(offset, nextOffset))
        offset = nextOffset
        if (offset >= encodedBody.byteLength) controller.close()
      },
      cancel() {
        discardedBodyCount += 1
        if (bodyRead) discardedBodyAfterReadCount += 1
      },
    }, { highWaterMark: 0 })
    return {
      status: response.status,
      headers: response.headers,
      body,
      async text() {
        responseTextCallCount += 1
        bodyRead = true
        return await response.text()
      },
    }
  }

  const fetch: AiAssistanceLiveFetch = async (url, init) => {
    requestCount += 1
    const path = new URL(url).pathname
    requestPaths.push(path)
    operationEvents.push(`http:${path}`)
    firstPath ??= path
    if (path === '/api/health') {
      expect(readHeader(init, 'Authorization')).toBeNull()
      const commitSha = options.healthCommitShas?.[healthRequestCount] ??
        options.commitSha ?? EXPECTED_COMMIT_SHA
      healthRequestCount += 1
      return observeResponse(jsonResponse(200, {
        ok: true,
        status: 'alive',
        applicationCommitSha: commitSha,
      }))
    }
    if (path === '/api/auth/login') {
      expect(readHeader(init, 'Authorization')).toBeNull()
      expect(readRequestRecord(init)).toEqual({
        email: SYNTHETIC_EMAIL,
        password: SYNTHETIC_PASSWORD,
      })
      return observeResponse(jsonResponse(200, {
        accessToken: ACCESS_TOKEN,
        tokenType: 'Bearer',
        expiresAt: options.accessTokenExpiresAt ?? 3_600_000,
      }))
    }

    expect(readHeader(init, 'Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    const postProviderPath =
      `/api/teams/${POST_PROVIDER_TEAM_ID}/issues/${POST_PROVIDER_WORK_ITEM_ID}`
    if (path === postProviderPath && init.method === 'GET') {
      return observeResponse(jsonResponse(200, {
        issue: {
          id: POST_PROVIDER_WORK_ITEM_ID,
          teamId: POST_PROVIDER_TEAM_ID,
          title: postProviderState.title,
          revision: postProviderState.revision,
        },
      }))
    }
    if (path === postProviderPath && init.method === 'PATCH') {
      const key = requireHeader(init, 'Idempotency-Key')
      expect(requireHeader(init, 'X-Correlation-Id')).toBe(key)
      const requestBody = readRequestRecord(init)
      const replayed = postProviderState.mutationIdempotencyKey === key
      if (!replayed) {
        expect(requestBody).toEqual({
          expectedRevision: postProviderState.revision,
          title: postProviderState.title === POST_PROVIDER_TITLE_A
            ? POST_PROVIDER_TITLE_B
            : POST_PROVIDER_TITLE_A,
        })
        postProviderState.mutationIdempotencyKey = key
        postProviderState.title = requestBody.title === POST_PROVIDER_TITLE_A
          ? POST_PROVIDER_TITLE_A
          : POST_PROVIDER_TITLE_B
        postProviderState.revision += 1
        postProviderState.phase = 'failed'
        completePostProviderMutation?.()
      }
      if (
        options.postProviderMutationResponseLoss === true &&
        !postProviderResponseLossInjected
      ) {
        postProviderResponseLossInjected = true
        throw new Error('Synthetic committed response loss.')
      }
      if (options.postProviderMutationResponseLoss === true && replayed) {
        return observeResponse(jsonResponse(409, {
          code: 'WorkItemRevisionConflict',
        }))
      }
      return observeResponse(jsonResponse(200, {
        issue: {
          id: POST_PROVIDER_WORK_ITEM_ID,
          teamId: POST_PROVIDER_TEAM_ID,
          title: postProviderState.title,
          revision: postProviderState.revision,
        },
      }, replayed))
    }
    const withheldFixture = readWithheldFixture(path)
    if (withheldFixture !== undefined) {
      return observeResponse(jsonResponse(
        200,
        createWithheldGeneration(
          withheldFixture.generationId,
          withheldFixture.reasonCode,
          options.invalidWithheldGenerationId === true &&
            withheldFixture.reasonCode === 'source-changed',
        ),
      ))
    }
    if (path.endsWith('/decision')) {
      reviewMutationCount += 1
      return observeResponse(jsonResponse(
        200,
        createDecidedGeneration(options.invalidDecisionMutation ?? false),
      ))
    }
    if (path.endsWith('/feedback')) {
      reviewMutationCount += 1
      const key = requireHeader(init, 'Idempotency-Key')
      const replayed = generationKeys.has(`feedback:${key}`)
      generationKeys.set(`feedback:${key}`, 'work-item')
      return observeResponse(emptyResponse(
        204,
        replayed && !(options.missingFeedbackReplay ?? false),
      ))
    }
    if (path !== '/api/ai-assistance/generations') {
      throw new Error('Unexpected fake live API route.')
    }

    const requestBody = readRequestRecord(init)
    const key = requireHeader(init, 'Idempotency-Key')
    if (containsStaleRevision(requestBody)) {
      const staleKey = `stale:${key}`
      const replayed = generationKeys.has(staleKey)
      generationKeys.set(staleKey, 'triage')
      return observeResponse(jsonResponse(
        409,
        { code: 'AiAssistanceSourceChanged' },
        replayed,
      ))
    }
    if (containsPostProviderSourceFence(requestBody)) {
      const replayed = postProviderState.generationIdempotencyKey === key
      if (!replayed) {
        postProviderState.generationIdempotencyKey = key
        postProviderState.request = parseGenerateAiAssistanceRequest(requestBody)
        if (options.durabilityMutation === 'post-provider-attempt-timeout') {
          postProviderState.phase = 'provider-free'
          return observeResponse(jsonResponse(503, { code: 'SyntheticUnavailable' }))
        }
        postProviderState.phase = 'started'
        postProviderState.providerInvocationCount += 1
        if (options.postProviderCompletesAfterClientAbort === true) {
          await waitForFakeClientAbort(init.signal)
          postProviderState.phase = 'completed'
          return observeResponse(jsonResponse(
            201,
            createPostProviderCompletedGeneration(),
          ))
        }
        await waitForFakePostProviderMutation(
          postProviderMutationCompleted,
          init.signal,
        )
      } else {
        postProviderState.generationReplayed = true
      }
      return observeResponse(jsonResponse(409, {
        code: options.postProviderFailureCode ?? 'AiAssistanceSourceChanged',
      }, replayed))
    }
    const existingJourney = generationKeys.get(key)
    const journey = existingJourney ?? journeyOrder[nextJourneyIndex]
    if (journey === undefined) throw new Error('Unexpected generation key.')
    if (existingJourney === undefined) {
      generationKeys.set(key, journey)
      nextJourneyIndex += 1
    }
    const responseVariant = options.unsafeJourney === journey
      ? 'canary'
      : options.leakedAccessTokenJourney === journey
        ? 'access-token'
        : options.leakedJwtJourney === journey
          ? 'jwt'
          : options.oversizedJourney === journey
            ? 'oversized'
            : options.providerMismatchJourney === journey
              ? 'provider-mismatch'
              : options.missingUsageJourney === journey
                ? 'usage-missing'
                : options.overBudgetJourney === journey
                  ? 'over-budget'
                  : 'valid'
    const defaultReplay = existingJourney !== undefined
    const replayed = defaultReplay
      ? options.missingReplayJourney !== journey
      : options.unexpectedFirstReplayJourney === journey
    return observeResponse(jsonResponse(
      201,
      createAvailableGeneration(journey, responseVariant),
      replayed,
    ))
  }
  const durability = createFakeDurabilityReader(
    generationKeys,
    postProviderState,
    options,
    () => operationEvents.push('dynamodb:get'),
  )

  return {
    fetch,
    requestCount: () => requestCount,
    commitProbeWasFirst: () => firstPath === '/api/health',
    discardedBodyCount: () => discardedBodyCount,
    discardedBodyAfterReadCount: () => discardedBodyAfterReadCount,
    responseTextCallCount: () => responseTextCallCount,
    reviewMutationCount: () => reviewMutationCount,
    requestPaths: () => requestPaths,
    dynamoGet: durability.dynamoGet,
    dynamoCommands: durability.commands,
    operationEvents: () => operationEvents,
    postProviderInvocationCount: () => postProviderState.providerInvocationCount,
  }
}

/** Fake read-only persistence boundary sharing the HTTP transcript's opaque keys. */
type FakeDurabilityReader = {
  /** Strongly consistent exact-key DynamoDB transport. */
  dynamoGet: AiAssistanceLiveDynamoGet
  /** Captured commands for command-surface assertions. */
  commands(): readonly GetCommand[]
}

/**
 * Creates exact generation, receipt, attempt, audit, and feedback rows on demand.
 *
 * @param generationKeys - Opaque HTTP keys captured by the fake API.
 * @param postProviderState - Active drill state shared with the fake HTTP boundary.
 * @param options - Optional single-invariant corruption.
 * @param observeRead - Records one DynamoDB boundary event without row content.
 * @returns Fake strongly consistent GetCommand reader and captured commands.
 */
function createFakeDurabilityReader(
  generationKeys: ReadonlyMap<string, AiAssistanceLiveJourney>,
  postProviderState: FakePostProviderSourceFenceState,
  options: FakeLiveApiOptions,
  observeRead: () => void,
): FakeDurabilityReader {
  const commands: GetCommand[] = []
  let postProviderReceiptReadCount = 0
  const dynamoGet: AiAssistanceLiveDynamoGet = async (command) => {
    observeRead()
    commands.push(command)
    if (options.durabilityMutation === 'aws-error') {
      throw new Error(
        `private raw AWS error ${PRIVATE_AWS_ACCOUNT_ID} ${DURABILITY_TABLE_NAME}`,
      )
    }
    const key: unknown = command.input.Key
    if (
      command.input.TableName !== DURABILITY_TABLE_NAME ||
      command.input.ConsistentRead !== true ||
      !isRecord(key) ||
      Object.keys(key).length !== 2 ||
      key.workspaceId !== SYNTHETIC_WORKSPACE_ID ||
      typeof key.recordKey !== 'string'
    ) throw new Error('Unexpected fake DynamoDB command.')

    const recordKey = key.recordKey
    const postProviderKey = postProviderState.generationIdempotencyKey
    const postProviderRequest = postProviderState.request
    if (
      postProviderKey !== undefined &&
      postProviderRequest !== undefined &&
      recordKey === createAiAssistanceIdempotencyRecordKey(
        SYNTHETIC_MEMBER_ID,
        postProviderKey,
      )
    ) {
      postProviderReceiptReadCount += 1
      if (
        options.postProviderInitialReceiptReadFailure === true &&
        postProviderReceiptReadCount === 1
      ) {
        throw new Error('Synthetic first receipt read failed.')
      }
      if (postProviderState.phase === 'started') {
        return createDynamoOutput(createPostProviderStartedReceipt(
          postProviderKey,
          postProviderRequest,
        ))
      }
      if (postProviderState.phase === 'provider-free') {
        return createDynamoOutput(createPostProviderProviderFreeReceipt(
          postProviderKey,
          postProviderRequest,
        ))
      }
      if (postProviderState.phase === 'failed') {
        return createDynamoOutput(createPostProviderFailedReceipt(
          postProviderKey,
          postProviderRequest,
          options,
          postProviderState.generationReplayed,
        ))
      }
      if (postProviderState.phase === 'completed') {
        return createDynamoOutput(createPostProviderCompletedReceipt(
          postProviderKey,
          postProviderRequest,
        ))
      }
      return createDynamoOutput()
    }
    if (recordKey === createAiAssistanceGenerationRecordKey(
      POST_PROVIDER_GENERATION_ID,
    )) {
      if (postProviderState.phase === 'completed' && postProviderRequest !== undefined) {
        return createDynamoOutput(createPostProviderCompletedGenerationItem(
          postProviderRequest,
        ))
      }
      return options.durabilityMutation === 'post-provider-generation'
        ? createDynamoOutput({ unexpected: true })
        : createDynamoOutput()
    }
    for (const [idempotencyKey, journey] of generationKeys) {
      if (idempotencyKey.startsWith('feedback:') || idempotencyKey.startsWith('stale:')) {
        continue
      }
      const fixtureCase = requireLiveCase(journey)
      const generation = createAvailableGeneration(journey, 'valid')
      if (
        recordKey === createAiAssistanceIdempotencyRecordKey(
          SYNTHETIC_MEMBER_ID,
          idempotencyKey,
        )
      ) {
        return createDynamoOutput(createSuccessfulReceipt(
            fixtureCase,
            generation,
            idempotencyKey,
            options.durabilityMutation,
          ))
      }
      if (recordKey === createAiAssistanceGenerationRecordKey(generation.id)) {
        return createDynamoOutput(createStoredGenerationItem(
            fixtureCase,
            generation,
            options.durabilityMutation,
          ))
      }
    }

    const staleKey = findOpaqueKey(generationKeys, 'stale:')
    if (
      staleKey !== undefined &&
      recordKey === createAiAssistanceIdempotencyRecordKey(
        SYNTHETIC_MEMBER_ID,
        staleKey,
      )
    ) return createDynamoOutput(createStaleReceipt(staleKey, options.durabilityMutation))
    if (recordKey === createAiAssistanceGenerationRecordKey(STALE_GENERATION_ID)) {
      return options.durabilityMutation === 'stale-generation'
        ? createDynamoOutput(createStoredGenerationItem(
              requireLiveCase('triage'),
              {
                ...createAvailableGeneration('triage', 'valid'),
                id: STALE_GENERATION_ID,
              },
              undefined,
            ))
        : createDynamoOutput()
    }

    const feedbackKey = findOpaqueKey(generationKeys, 'feedback:')
    if (feedbackKey !== undefined) {
      const idempotencyKey = feedbackKey
      const generationId = createAvailableGeneration('work-item', 'valid').id
      const feedback = { rating: 'helpful' } satisfies {
        rating: 'helpful'
      }
      const identity = createAiAssistanceFeedbackIdentity(
        SYNTHETIC_WORKSPACE_ID,
        SYNTHETIC_MEMBER_ID,
        generationId,
        feedback,
        idempotencyKey,
      )
      if (
        recordKey === createAiAssistanceFeedbackRecordKey(
          generationId,
          identity.feedbackId,
        )
      ) {
        return createDynamoOutput({
            workspaceId: SYNTHETIC_WORKSPACE_ID,
            recordKey,
            recordType: 'ai-assistance-feedback',
            generationId,
            feedbackId: identity.feedbackId,
            memberId: SYNTHETIC_MEMBER_ID,
            feedback,
            inputFingerprint: options.durabilityMutation === 'feedback'
              ? '0'.repeat(64)
              : identity.inputFingerprint,
            createdAt: '2026-08-31T00:02:00.000Z',
            expiresAt: options.durabilityMutation === 'feedback-retention'
              ? GENERATION_TTL_EPOCH_SECONDS + 1
              : GENERATION_TTL_EPOCH_SECONDS,
          })
      }
    }
    return createDynamoOutput()
  }
  return { dynamoGet, commands: () => commands }
}

/** Creates a type-complete fake AWS SDK output with optional exact row data. */
function createDynamoOutput(
  item?: Record<string, unknown>,
): GetCommandOutput {
  return item === undefined
    ? { $metadata: {} }
    : { $metadata: {}, Item: item }
}

/** Returns one fixed case and fails the fake when the journey map is invalid. */
function requireLiveCase(journey: AiAssistanceLiveJourney): FakeLiveCase {
  const fixtureCase = LIVE_CASES.find((candidate) => candidate.journey === journey)
  if (fixtureCase === undefined) throw new Error('Missing fake live case.')
  return fixtureCase
}

/** Finds one untrusted key captured under a fake operation namespace. */
function findOpaqueKey(
  generationKeys: ReadonlyMap<string, AiAssistanceLiveJourney>,
  prefix: 'feedback:' | 'stale:',
): string | undefined {
  for (const key of generationKeys.keys()) {
    if (key.startsWith(prefix)) return key.slice(prefix.length)
  }
  return undefined
}

/** Creates one completed receipt with a singleton succeeded provider attempt. */
function createSuccessfulReceipt(
  fixtureCase: FakeLiveCase,
  generation: AiAssistanceGeneration,
  idempotencyKey: string,
  mutation: FakeDurabilityMutation | undefined,
): Record<string, unknown> {
  const audit = {
    request: fixtureCase.request,
    auditedInput: fixtureCase.journey === 'request' && mutation === 'audit-canary'
      ? FORBIDDEN_CANARY
      : fixtureCase.journey === 'request' && mutation === 'audit-credential'
        ? ACCESS_TOKEN
        : SAFE_AUDITED_INPUT,
    citations: mutation === 'audit-schema' && fixtureCase.journey === 'request'
      ? 'not-an-array'
      : generation.content.availability === 'available'
        ? generation.content.citations
        : [],
  }
  const attempt = {
    task: generation.task,
    modelId: PRIVATE_MODEL_ID,
    promptVersion: 'ai-assistance-v1',
    traceId: PRIVATE_TRACE_ID,
    startedAt: '2026-08-31T00:00:00.000Z',
    ...(mutation === 'attempt-provider-start' && fixtureCase.journey === 'request'
      ? {}
      : { providerStartedAt: '2026-08-31T00:00:00.001Z' }),
    audit,
    status: mutation === 'attempt-status' && fixtureCase.journey === 'request'
      ? 'failed'
      : 'succeeded',
    endedAt: '2026-08-31T00:00:00.500Z',
    latencyMs: 500,
    providerOutcome: 'succeeded',
    usage: mutation === 'attempt-usage' && fixtureCase.journey === 'request'
      ? { ...generation.details.usage, latencyMs: 501 }
      : generation.details.usage,
  }
  const recordKey = createAiAssistanceIdempotencyRecordKey(
    SYNTHETIC_MEMBER_ID,
    idempotencyKey,
  )
  return {
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    recordKey,
    recordType: 'ai-assistance-generation-idempotency',
    memberId: SYNTHETIC_MEMBER_ID,
    inputFingerprint: createAiAssistanceGenerationInputFingerprint(
      SYNTHETIC_WORKSPACE_ID,
      SYNTHETIC_MEMBER_ID,
      parseGenerateAiAssistanceRequest(fixtureCase.request),
    ),
    generationId: mutation === 'receipt-link' && fixtureCase.journey === 'request'
      ? 'private-unlinked-generation-id'
      : generation.id,
    status: 'completed',
    leaseExpiresAt: 1_780_000_000,
    expiresAt: mutation === 'receipt-retention' && fixtureCase.journey === 'request'
      ? GENERATION_TTL_EPOCH_SECONDS + 1
      : GENERATION_TTL_EPOCH_SECONDS,
    attempt,
  }
}

/** Creates one canonical generation row, including the durable Work Item decision. */
function createStoredGenerationItem(
  fixtureCase: FakeLiveCase,
  generation: AiAssistanceGeneration,
  mutation: FakeDurabilityMutation | undefined,
): Record<string, unknown> {
  const storedGeneration = fixtureCase.journey === 'work-item' && mutation !== 'decision'
    ? createDecidedGeneration(false)
    : generation
  return {
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    recordKey: createAiAssistanceGenerationRecordKey(generation.id),
    recordType: 'ai-assistance-generation',
    memberId: SYNTHETIC_MEMBER_ID,
    generation: storedGeneration,
    request: mutation === 'generation-link' && fixtureCase.journey === 'request'
      ? STALE_REVISION_REQUEST
      : fixtureCase.request,
    authorizationToken: 'opaque-authorization-snapshot',
    auditedInput: SAFE_AUDITED_INPUT,
    expiresAt: mutation === 'generation-retention' && fixtureCase.journey === 'request'
      ? GENERATION_TTL_EPOCH_SECONDS + 1
      : GENERATION_TTL_EPOCH_SECONDS,
  }
}

/** Creates one terminal stale-source receipt without a provider attempt. */
function createStaleReceipt(
  idempotencyKey: string,
  mutation: FakeDurabilityMutation | undefined,
): Record<string, unknown> {
  return {
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    recordKey: createAiAssistanceIdempotencyRecordKey(
      SYNTHETIC_MEMBER_ID,
      idempotencyKey,
    ),
    recordType: 'ai-assistance-generation-idempotency',
    memberId: SYNTHETIC_MEMBER_ID,
    inputFingerprint: createAiAssistanceGenerationInputFingerprint(
      SYNTHETIC_WORKSPACE_ID,
      SYNTHETIC_MEMBER_ID,
      parseGenerateAiAssistanceRequest(STALE_REVISION_REQUEST),
    ),
    generationId: STALE_GENERATION_ID,
    status: 'failed',
    leaseExpiresAt: 1_780_000_000,
    expiresAt: mutation === 'stale-retention' ? 0 : GENERATION_TTL_EPOCH_SECONDS,
    failedAt: '2026-08-31T00:03:00.000Z',
    failureCategory: 'conflict',
    failureCode: 'AiAssistanceSourceChanged',
    ...(mutation === 'stale-attempt' ? { attempt: { status: 'started' } } : {}),
  }
}

/** Creates the exact pending receipt observed at the provider-start barrier. */
function createPostProviderStartedReceipt(
  idempotencyKey: string,
  request: GenerateAiAssistanceRequest,
): Record<string, unknown> {
  const recordKey = createAiAssistanceIdempotencyRecordKey(
    SYNTHETIC_MEMBER_ID,
    idempotencyKey,
  )
  return {
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    recordKey,
    recordType: 'ai-assistance-generation-idempotency',
    memberId: SYNTHETIC_MEMBER_ID,
    inputFingerprint: createAiAssistanceGenerationInputFingerprint(
      SYNTHETIC_WORKSPACE_ID,
      SYNTHETIC_MEMBER_ID,
      request,
    ),
    generationId: POST_PROVIDER_GENERATION_ID,
    status: 'pending',
    leaseExpiresAt: 1_780_000_000,
    expiresAt: GENERATION_TTL_EPOCH_SECONDS,
    attempt: {
      task: 'summary',
      modelId: PRIVATE_MODEL_ID,
      promptVersion: 'ai-assistance-v1',
      traceId: PRIVATE_TRACE_ID,
      startedAt: '2026-08-31T00:04:00.000Z',
      providerStartedAt: '2026-08-31T00:04:00.001Z',
      audit: {
        request,
        auditedInput: SAFE_AUDITED_INPUT,
        citations: [],
      },
      status: 'started',
    },
  }
}

/** Creates a terminal receipt proving that the provider dispatch marker was never reached. */
function createPostProviderProviderFreeReceipt(
  idempotencyKey: string,
  request: GenerateAiAssistanceRequest,
): Record<string, unknown> {
  const started = createPostProviderStartedReceipt(idempotencyKey, request)
  const { attempt: _attempt, ...receipt } = started
  return {
    ...receipt,
    status: 'failed',
    failedAt: '2026-08-31T00:04:00.001Z',
    failureCategory: 'timeout',
    failureCode: 'AiAssistanceProviderTimeout',
  }
}

/** Creates the terminal singleton failed attempt after a successful provider result. */
function createPostProviderFailedReceipt(
  idempotencyKey: string,
  request: GenerateAiAssistanceRequest,
  options: FakeLiveApiOptions,
  replayed: boolean,
): Record<string, unknown> {
  const started = createPostProviderStartedReceipt(idempotencyKey, request)
  const zeroUsage = options.durabilityMutation === 'post-provider-zero-usage'
  const usage = {
    inputTokens: zeroUsage ? 0 : 100,
    outputTokens: zeroUsage ? 0 : 50,
    latencyMs: zeroUsage ? 0 : 500,
    costUsd: zeroUsage ? 0 : 0.002,
  }
  const failureCode = options.postProviderFailureCode ??
    'AiAssistanceSourceChanged'
  return {
    ...started,
    status: 'failed',
    failedAt: '2026-08-31T00:04:01.000Z',
    failureCategory: 'conflict',
    failureCode,
    attempt: {
      task: 'summary',
      modelId: PRIVATE_MODEL_ID,
      promptVersion: 'ai-assistance-v1',
      traceId: PRIVATE_TRACE_ID,
      startedAt: '2026-08-31T00:04:00.000Z',
      providerStartedAt: '2026-08-31T00:04:00.001Z',
      audit: {
        request,
        auditedInput: SAFE_AUDITED_INPUT,
        citations: [],
      },
      status: 'failed',
      endedAt: options.durabilityMutation === 'post-provider-replay-overwrite' && replayed
        ? '2026-08-31T00:04:01.001Z'
        : '2026-08-31T00:04:01.000Z',
      latencyMs: usage.latencyMs,
      usage,
      providerOutcome: options.durabilityMutation === 'post-provider-outcome'
        ? 'failed'
        : 'succeeded',
      failureCategory: 'conflict',
      failureCode,
    },
  }
}

/** Creates the terminal receipt for a server completion observed after local cancellation. */
function createPostProviderCompletedReceipt(
  idempotencyKey: string,
  request: GenerateAiAssistanceRequest,
): Record<string, unknown> {
  const started = createPostProviderStartedReceipt(idempotencyKey, request)
  if (!isRecord(started.attempt)) {
    throw new Error('Expected a strict started attempt in the fake receipt.')
  }
  const generation = createPostProviderCompletedGeneration()
  return {
    ...started,
    status: 'completed',
    attempt: {
      ...started.attempt,
      status: 'succeeded',
      endedAt: '2026-08-31T00:04:01.000Z',
      latencyMs: generation.details.usage.latencyMs,
      usage: generation.details.usage,
      providerOutcome: 'succeeded',
    },
  }
}

/** Creates the strict generation returned when the server finishes after client abort. */
function createPostProviderCompletedGeneration(): AiAssistanceGeneration {
  return {
    ...createAvailableGeneration('work-item', 'valid'),
    id: POST_PROVIDER_GENERATION_ID,
  }
}

/** Creates the canonical generation row linked from a late-completed receipt. */
function createPostProviderCompletedGenerationItem(
  request: GenerateAiAssistanceRequest,
): Record<string, unknown> {
  const generation = createPostProviderCompletedGeneration()
  return {
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    recordKey: createAiAssistanceGenerationRecordKey(generation.id),
    recordType: 'ai-assistance-generation',
    memberId: SYNTHETIC_MEMBER_ID,
    generation,
    request,
    authorizationToken: 'opaque-authorization-snapshot',
    auditedInput: SAFE_AUDITED_INPUT,
    expiresAt: GENERATION_TTL_EPOCH_SECONDS,
  }
}

/** Creates one strictly valid available generation for a fixed journey. */
function createAvailableGeneration(
  journey: AiAssistanceLiveJourney,
  variant:
    | 'valid'
    | 'canary'
    | 'access-token'
    | 'jwt'
    | 'oversized'
    | 'provider-mismatch'
    | 'usage-missing'
    | 'over-budget',
): AiAssistanceGeneration {
  const task = taskForJourney(journey)
  const citationId = 'private-citation-identifier'
  const citationSourceType = sourceTypeForJourney(journey)
  const safeText = variant === 'canary'
    ? FORBIDDEN_CANARY
    : variant === 'access-token'
      ? ACCESS_TOKEN
      : variant === 'jwt'
        ? PRIVATE_JWT
        : variant === 'oversized'
          ? 'x'.repeat(600 * 1024)
          : 'Safe synthetic generated evidence.'
  const citations = citationSourceType === undefined
    ? []
    : [{
        id: citationId,
        sourceType: citationSourceType,
        label: 'Synthetic source',
        href: '/synthetic/source',
        capturedRevision: 1,
      }]
  const usage: AiAssistanceGeneration['details']['usage'] = variant === 'usage-missing'
    ? {
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 500,
        costUnavailableReason: 'provider-not-reported',
      }
    : variant === 'over-budget'
      ? {
          inputTokens: 2_001,
          outputTokens: 1_001,
          latencyMs: 12_001,
          costUsd: 0.101,
        }
      : {
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 500,
          costUsd: 0.002,
        }
  return {
    schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION,
    id: `private-generation-${journey}`,
    task,
    revision: 1,
    content: {
      availability: 'available',
      draft: createDraft(task, citationId, safeText),
      citations,
      uncertainty: {
        level: 'medium',
        reason: 'Synthetic evidence has bounded uncertainty.',
      },
    },
    details: {
      provider: 'bedrock',
      modelId: variant === 'provider-mismatch'
        ? MISMATCHED_MODEL_ID
        : PRIVATE_MODEL_ID,
      promptVersion: variant === 'provider-mismatch'
        ? 'private-mismatched-prompt-version'
        : 'ai-assistance-v1',
      traceId: PRIVATE_TRACE_ID,
      usage,
    },
    createdAt: '2026-08-31T00:00:00.000Z',
    expiresAt: GENERATION_EXPIRES_AT,
  }
}

/** Creates one strict task-specific draft with grounded evidence where applicable. */
function createDraft(
  task: AiAssistanceGeneration['task'],
  citationId: string,
  text: string,
): AiAssistanceDraft {
  switch (task) {
    case 'triage':
      return {
        kind: 'triage',
        title: {
          value: text,
          reason: 'The synthetic source supports this suggestion.',
          confidence: 'high',
          citationIds: [citationId],
        },
        customFields: [],
      }
    case 'summary':
      return {
        kind: 'summary',
        overview: {
          id: 'server-summary-row',
          text,
          confidence: 'high',
          citationIds: [citationId],
        },
        decisions: [],
        actions: [],
        risks: [],
      }
    case 'planning':
      return {
        kind: 'planning',
        title: {
          value: text,
          reason: 'The synthetic planning target supports this proposal.',
          confidence: 'medium',
          citationIds: [citationId],
        },
        subtasks: [],
        dependencies: [],
      }
    case 'search':
      return {
        kind: 'search',
        interpretation: text,
        filters: { entityTypes: ['work-item'] },
        caveats: ['Synthetic search scope only.'],
      }
  }
}

/** Creates a reviewed generation response after an approval has already committed. */
function createDecidedGeneration(invalidMutation: boolean): AiAssistanceGeneration {
  const task: AiAssistanceGeneration['task'] = invalidMutation ? 'planning' : 'summary'
  return {
    ...createAvailableGeneration('work-item', 'valid'),
    task,
    revision: 2,
    decision: {
      outcome: 'approved',
      decidedAt: '2026-08-31T00:01:00.000Z',
    },
  }
}

/** Resolves one fixed withheld fixture from an exact generation GET path. */
function readWithheldFixture(path: string): {
  /** Opaque generation identifier returned only inside the fake. */
  generationId: string
  /** Exact disclosure reason expected for this fake row. */
  reasonCode: 'permission-changed' | 'source-changed' | 'retention-expired'
} | undefined {
  for (const fixture of [
    {
      generationId: PERMISSION_WITHHELD_GENERATION_ID,
      reasonCode: 'permission-changed',
    },
    {
      generationId: WITHHELD_GENERATION_ID,
      reasonCode: 'source-changed',
    },
    {
      generationId: RETENTION_WITHHELD_GENERATION_ID,
      reasonCode: 'retention-expired',
    },
  ] satisfies readonly {
    generationId: string
    reasonCode: 'permission-changed' | 'source-changed' | 'retention-expired'
  }[]) {
    if (path === `/api/ai-assistance/generations/${fixture.generationId}`) return fixture
  }
  return undefined
}

/** Creates a retained generation whose original content is no longer disclosable. */
function createWithheldGeneration(
  generationId: string,
  reasonCode: 'permission-changed' | 'source-changed' | 'retention-expired',
  invalidGenerationId: boolean,
): AiAssistanceGeneration {
  return {
    ...createAvailableGeneration('document', 'valid'),
    id: invalidGenerationId
      ? 'private-unexpected-withheld-generation-id'
      : generationId,
    content: { availability: 'withheld', reasonCode },
  }
}

/** Maps a fixed journey to its public task discriminator. */
function taskForJourney(
  journey: AiAssistanceLiveJourney,
): AiAssistanceGeneration['task'] {
  switch (journey) {
    case 'request':
    case 'triage':
      return 'triage'
    case 'work-item':
    case 'document':
      return 'summary'
    case 'planning':
      return 'planning'
    case 'search':
      return 'search'
  }
}

/** Maps a fixed source journey to the expected citation discriminator. */
function sourceTypeForJourney(
  journey: AiAssistanceLiveJourney,
): AiAssistanceSource['type'] | undefined {
  switch (journey) {
    case 'request':
      return 'request-submission'
    case 'triage':
      return 'triage-entry'
    case 'work-item':
      return 'work-item'
    case 'planning':
      return 'planning-target'
    case 'document':
      return 'document'
    case 'search':
      return undefined
  }
}

/** Creates a JSON response with an optional server-owned replay marker. */
function jsonResponse(
  status: number,
  body: unknown,
  replayed = false,
): AiAssistanceLiveHttpResponse {
  const text = JSON.stringify(body)
  return {
    status,
    headers: createResponseHeaders(replayed),
    async text() {
      return text
    },
  }
}

/** Creates an empty response with an optional server-owned replay marker. */
function emptyResponse(
  status: number,
  replayed: boolean,
): AiAssistanceLiveHttpResponse {
  return {
    status,
    headers: createResponseHeaders(replayed),
    async text() {
      return ''
    },
  }
}

/** Waits for the fake mutation barrier while honoring evaluator cancellation. */
async function waitForFakePostProviderMutation(
  completion: Promise<void>,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (signal === undefined || signal === null) {
    await completion
    return
  }
  if (signal.aborted) throw new Error('Synthetic generation aborted.')
  await new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      signal.removeEventListener('abort', handleAbort)
      reject(new Error('Synthetic generation aborted.'))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    void completion.then(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, (error: unknown) => {
      signal.removeEventListener('abort', handleAbort)
      reject(error)
    })
  })
}

/** Waits until the evaluator cancels only its local HTTP request. */
async function waitForFakeClientAbort(
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (signal === undefined || signal === null) {
    throw new Error('Expected a cancellable fake generation request.')
  }
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** Creates a minimal case-insensitive response-header reader. */
function createResponseHeaders(replayed: boolean): AiAssistanceLiveHttpResponse['headers'] {
  return {
    get(name) {
      return replayed && name.toLowerCase() === 'idempotency-replayed'
        ? 'true'
        : null
    },
  }
}

/** Reads one request header through the platform's canonical Headers parser. */
function readHeader(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name)
}

/** Requires one non-empty request header from a fake evaluator call. */
function requireHeader(init: RequestInit, name: string): string {
  const value = readHeader(init, name)
  if (value === null || value === '') throw new Error('Required fake request header missing.')
  return value
}

/** Parses one fake request body as an untrusted record. */
function readRequestRecord(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('Fake request body must be JSON text.')
  const value: unknown = JSON.parse(init.body)
  if (!isRecord(value)) throw new Error('Fake request body must be an object.')
  return value
}

/** Detects the dedicated stale-revision fixture without retaining its resource identifiers. */
function containsStaleRevision(value: Record<string, unknown>): boolean {
  if (!isRecord(value.source)) return false
  return value.source.expectedRevision === 999
}

/** Detects the dynamically revisioned drill-only Work Item generation request. */
function containsPostProviderSourceFence(
  value: Record<string, unknown>,
): boolean {
  if (!Array.isArray(value.sources) || value.sources.length !== 1) return false
  const source: unknown = value.sources[0]
  return isRecord(source) &&
    source.type === 'work-item' &&
    source.teamId === POST_PROVIDER_TEAM_ID &&
    source.workItemId === POST_PROVIDER_WORK_ITEM_ID &&
    source.expectedRevision === POST_PROVIDER_INITIAL_REVISION
}

/** Checks whether an untrusted value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates deterministic opaque keys for generation and feedback operations. */
function createKeyGenerator(): () => string {
  let index = 0
  return () => {
    index += 1
    return `private-idempotency-key-${index}`
  }
}

/** Returns the exact canonical sort keys read by one deterministic successful run. */
function expectedDurabilityRecordKeys(): string[] {
  const postProviderReceiptKey = createAiAssistanceIdempotencyRecordKey(
    SYNTHETIC_MEMBER_ID,
    'private-idempotency-key-9',
  )
  const postProviderGenerationKey = createAiAssistanceGenerationRecordKey(
    POST_PROVIDER_GENERATION_ID,
  )
  const keys: string[] = [
    postProviderReceiptKey,
    postProviderReceiptKey,
    postProviderGenerationKey,
    postProviderReceiptKey,
    postProviderGenerationKey,
  ]
  LIVE_CASES.forEach((fixtureCase, index) => {
    const idempotencyKey = `private-idempotency-key-${index + 1}`
    keys.push(
      createAiAssistanceIdempotencyRecordKey(
        SYNTHETIC_MEMBER_ID,
        idempotencyKey,
      ),
      createAiAssistanceGenerationRecordKey(
        createAvailableGeneration(fixtureCase.journey, 'valid').id,
      ),
    )
  })
  const feedback = { rating: 'helpful' } satisfies { rating: 'helpful' }
  const workItemGenerationId = createAvailableGeneration('work-item', 'valid').id
  const feedbackIdentity = createAiAssistanceFeedbackIdentity(
    SYNTHETIC_WORKSPACE_ID,
    SYNTHETIC_MEMBER_ID,
    workItemGenerationId,
    feedback,
    'private-idempotency-key-7',
  )
  keys.push(
    createAiAssistanceIdempotencyRecordKey(
      SYNTHETIC_MEMBER_ID,
      'private-idempotency-key-8',
    ),
    createAiAssistanceGenerationRecordKey(STALE_GENERATION_ID),
    createAiAssistanceFeedbackRecordKey(
      workItemGenerationId,
      feedbackIdentity.feedbackId,
    ),
  )
  return keys
}

describe('evaluateAiAssistanceLive', () => {
  test('isolates OIDC permission in the downstream protected live job', async () => {
    const source = await Bun.file(
      new URL('../../../.github/workflows/ai-assistance-live-eval.yml', import.meta.url),
    ).text()
    const workflow: unknown = Bun.YAML.parse(source)
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
      throw new Error('Expected live workflow jobs.')
    }
    const preflight = workflow.jobs['commit-preflight']
    const live = workflow.jobs['live-evaluation']
    const metricApproval = workflow.jobs['metric-evidence-approval']
    if (
      !isRecord(preflight) ||
      !isRecord(live) ||
      !isRecord(metricApproval) ||
      !Array.isArray(preflight.steps) ||
      !Array.isArray(live.steps) ||
      !Array.isArray(metricApproval.steps)
    ) throw new Error('Expected exact live workflow jobs.')

    expect(workflow.permissions).toBeUndefined()
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      'commit-preflight',
      'live-evaluation',
      'metric-evidence-approval',
    ])
    expect(preflight.permissions).toEqual({ contents: 'read' })
    expect(preflight.environment).toBe('ai-assistance-live-evaluation')
    expect(live.needs).toBe('commit-preflight')
    expect(live.environment).toBe('ai-assistance-live-evaluation')
    expect(live.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    })
    expect(metricApproval.needs).toBe('live-evaluation')
    expect(metricApproval.environment).toBe(
      'ai-assistance-live-metric-evidence-approval',
    )
    expect(metricApproval.permissions).toEqual({})
    expect(metricApproval.if).toBe(
      "github.repository == 'mnmn0/mukuroji' && github.ref == 'refs/heads/main'",
    )
    const metricGateStep = metricApproval.steps.find((step) =>
      isRecord(step) && step.name === 'Require provisioned metric-evidence gate')
    if (
      !isRecord(metricGateStep) ||
      !isRecord(metricGateStep.env) ||
      typeof metricGateStep.run !== 'string'
    ) throw new Error('Expected exact metric-evidence approval gate.')
    expect(Object.keys(metricGateStep.env)).toEqual([
      'AI_ASSISTANCE_LIVE_METRIC_EVIDENCE_GATE',
    ])
    expect(metricGateStep.env.AI_ASSISTANCE_LIVE_METRIC_EVIDENCE_GATE).toBe(
      '${{ vars.AI_ASSISTANCE_LIVE_METRIC_EVIDENCE_GATE }}',
    )
    expect(metricGateStep.run).toBe(
      'test "$AI_ASSISTANCE_LIVE_METRIC_EVIDENCE_GATE" = "required-reviewers-enabled"',
    )
    const metricApprovalText = JSON.stringify(metricApproval)
    for (const privilegedText of [
      'id-token',
      'secrets.',
      'AWS_ACCESS_KEY_ID',
      'configure-aws-credentials',
    ]) expect(metricApprovalText).not.toContain(privilegedText)
    expect(metricApprovalText.match(/vars\./g)?.length).toBe(1)
    const preflightText = JSON.stringify(preflight)
    for (const protectedName of [
      'AI_ASSISTANCE_LIVE_EVAL_AWS_ROLE_ARN',
      'AI_ASSISTANCE_LIVE_EVAL_AWS_REGION',
      'AI_ASSISTANCE_LIVE_EVAL_TABLE_NAME',
      'AI_ASSISTANCE_LIVE_EVAL_EMAIL',
      'AI_ASSISTANCE_LIVE_EVAL_PASSWORD',
      'AI_ASSISTANCE_LIVE_EVAL_FIXTURE_JSON',
      'configure-aws-credentials',
    ]) expect(preflightText).not.toContain(protectedName)

    const configureStep = live.steps.find((step) =>
      isRecord(step) && step.name === 'Acquire synthetic-partition read credentials')
    const evaluationStep = live.steps.find((step) =>
      isRecord(step) && step.name === 'Run content-free production-like evaluation')
    const validationStep = live.steps.find((step) =>
      isRecord(step) && step.name === 'Validate content-free evidence schema')
    const uploadStep = live.steps.find((step) =>
      isRecord(step) && step.name === 'Upload content-free evaluation evidence')
    if (
      !isRecord(configureStep) ||
      !isRecord(configureStep.with) ||
      !isRecord(evaluationStep) ||
      typeof evaluationStep.run !== 'string' ||
      !isRecord(validationStep) ||
      !isRecord(validationStep.env) ||
      typeof validationStep.run !== 'string' ||
      !isRecord(uploadStep) ||
      !isRecord(uploadStep.env) ||
      !isRecord(uploadStep.with)
    ) throw new Error('Expected protected live workflow steps.')
    expect(configureStep.uses).toBe(
      'aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c',
    )
    expect(configureStep.with['role-duration-seconds']).toBe(900)
    expect(configureStep.with['mask-aws-account-id']).toBe(true)
    const evaluationIndex = live.steps.indexOf(evaluationStep)
    const validationIndex = live.steps.indexOf(validationStep)
    const uploadIndex = live.steps.indexOf(uploadStep)
    expect(evaluationIndex).toBeGreaterThan(-1)
    expect(validationIndex).toBeGreaterThan(evaluationIndex)
    expect(uploadIndex).toBeGreaterThan(validationIndex)
    expect(evaluationStep.run).toContain('ai-assistance-live-eval-report.raw.json')
    expect(validationStep.run).toContain('ai-assistance-live-eval-report.raw.json')
    expect(validationStep.run).toContain('ai-assistance-live-eval-report.validated.json')
    expect(validationStep.run.match(/type == "number"/g)?.length).toBe(8)
    expect(validationStep.run.match(/floor == \./g)?.length).toBe(6)
    expect(uploadStep.if).toBeUndefined()
    expect(uploadStep.with.path).toBe('ai-assistance-live-eval-report.validated.json')
    expect(JSON.stringify(uploadStep)).not.toContain('.raw.json')
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
    ]) {
      expect(validationStep.env[name]).toBe('')
      expect(uploadStep.env[name]).toBe('')
    }
  })

  test('runs an unauthenticated commit-only preflight without credentials', async () => {
    const api = createFakeLiveApi()
    const passed = await runAiAssistanceLiveCommitPreflight({
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: 'https://production.example.test:443/',
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
    }, { fetch: api.fetch, apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST })

    expect(passed).toBe(true)
    expect(api.requestPaths()).toEqual(['/api/health'])
    expect(api.dynamoCommands()).toEqual([])
  })

  test('denies the production API target before network access when no URL is reviewed', async () => {
    let requestCount = 0
    const passed = await runAiAssistanceLiveCommitPreflight({
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: TEST_API_BASE_URL,
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
    }, {
      fetch: async () => {
        requestCount += 1
        return jsonResponse(500, {})
      },
    })

    expect(passed).toBe(false)
    expect(requestCount).toBe(0)
  })

  test('requires an exact normalized path and validates every approved API target', async () => {
    let requestCount = 0
    const fetch: AiAssistanceLiveFetch = async () => {
      requestCount += 1
      return jsonResponse(500, {})
    }
    const mismatchedPath = await runAiAssistanceLiveCommitPreflight({
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: TEST_API_BASE_URL,
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
    }, {
      fetch,
      apiBaseUrlAllowlist: [`${TEST_API_BASE_URL}/reviewed-stage`],
    })
    expect(mismatchedPath).toBe(false)

    const invalidAdditionalEntry = await runAiAssistanceLiveCommitPreflight({
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: TEST_API_BASE_URL,
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
    }, {
      fetch,
      apiBaseUrlAllowlist: [TEST_API_BASE_URL, 'http://unreviewed.example.test'],
    })
    expect(invalidAdditionalEntry).toBe(false)

    for (const invalidApprovedUrl of [
      'http://production.example.test',
      'https://user@production.example.test',
      'https://production.example.test:444',
      'https://production.example.test?private=value',
      'https://production.example.test?',
      'https://production.example.test#private-fragment',
      'https://production.example.test#',
      'https://localhost',
      'https://service.localhost',
      'https://127.0.0.1',
      'https://[::1]',
    ]) {
      const passed = await runAiAssistanceLiveCommitPreflight({
        AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: invalidApprovedUrl,
        AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
      }, { fetch, apiBaseUrlAllowlist: [invalidApprovedUrl] })
      expect(passed).toBe(false)
    }
    expect(requestCount).toBe(0)
  })

  test('probes the deployed SHA before login and keeps credentials out of CLI evidence', async () => {
    const api = createFakeLiveApi()
    const report = await runAiAssistanceLiveEvalCli({
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: 'https://production.example.test',
      ...DURABILITY_ENVIRONMENT,
      AI_ASSISTANCE_LIVE_EVAL_EMAIL: SYNTHETIC_EMAIL,
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
      AI_ASSISTANCE_LIVE_EVAL_FIXTURE_JSON: JSON.stringify(LIVE_FIXTURE),
      AI_ASSISTANCE_LIVE_EVAL_PASSWORD: SYNTHETIC_PASSWORD,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(true)
    expect(api.requestPaths().slice(0, 3)).toEqual([
      '/api/health',
      '/api/auth/login',
      '/api/health',
    ])
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(SYNTHETIC_EMAIL)
    expect(serialized).not.toContain(SYNTHETIC_PASSWORD)
    expect(serialized).not.toContain(ACCESS_TOKEN)
  })

  test('does not send login credentials when CLI preflight commit verification fails', async () => {
    const api = createFakeLiveApi({ commitSha: OTHER_COMMIT_SHA })
    const report = await runAiAssistanceLiveEvalCli({
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: 'https://production.example.test',
      ...DURABILITY_ENVIRONMENT,
      AI_ASSISTANCE_LIVE_EVAL_EMAIL: SYNTHETIC_EMAIL,
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
      AI_ASSISTANCE_LIVE_EVAL_FIXTURE_JSON: JSON.stringify(LIVE_FIXTURE),
      AI_ASSISTANCE_LIVE_EVAL_PASSWORD: SYNTHETIC_PASSWORD,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
    })

    expect(report.failures).toEqual(['deployed-commit-mismatch'])
    expect(api.requestPaths()).toEqual(['/api/health'])
    expect(api.dynamoCommands()).toEqual([])
  })

  test('rejects login access tokens outside the short-lived validity window', async () => {
    const longLivedApi = createFakeLiveApi({
      accessTokenExpiresAt: 24 * 60 * 60 * 1_000 + 1,
    })
    const environment = {
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: 'https://production.example.test',
      ...DURABILITY_ENVIRONMENT,
      AI_ASSISTANCE_LIVE_EVAL_EMAIL: SYNTHETIC_EMAIL,
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
      AI_ASSISTANCE_LIVE_EVAL_FIXTURE_JSON: JSON.stringify(LIVE_FIXTURE),
      AI_ASSISTANCE_LIVE_EVAL_PASSWORD: SYNTHETIC_PASSWORD,
    }
    const longLivedReport = await runAiAssistanceLiveEvalCli(
      environment,
      {
        fetch: longLivedApi.fetch,
        apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
        now: () => 0,
      },
    )
    const expiringApi = createFakeLiveApi({ accessTokenExpiresAt: 599_999 })
    const expiringReport = await runAiAssistanceLiveEvalCli(
      environment,
      {
        fetch: expiringApi.fetch,
        apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
        now: () => 0,
      },
    )

    expect(longLivedReport.failures).toEqual(['authentication-failed'])
    expect(expiringReport.failures).toEqual(['authentication-failed'])
    expect(longLivedApi.requestPaths()).toEqual(['/api/health', '/api/auth/login'])
    expect(expiringApi.requestPaths()).toEqual(['/api/health', '/api/auth/login'])
    expect(longLivedApi.dynamoCommands()).toEqual([])
    expect(expiringApi.dynamoCommands()).toEqual([])
  })

  test('rejects durability configuration before login or a DynamoDB read', async () => {
    const api = createFakeLiveApi()
    const report = await runAiAssistanceLiveEvalCli({
      AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL: 'https://production.example.test',
      AI_ASSISTANCE_LIVE_EVAL_AWS_REGION: 'private-invalid-region',
      AI_ASSISTANCE_LIVE_EVAL_EMAIL: SYNTHETIC_EMAIL,
      AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA: EXPECTED_COMMIT_SHA,
      AI_ASSISTANCE_LIVE_EVAL_FIXTURE_JSON: JSON.stringify(LIVE_FIXTURE),
      AI_ASSISTANCE_LIVE_EVAL_PASSWORD: SYNTHETIC_PASSWORD,
      AI_ASSISTANCE_LIVE_EVAL_TABLE_NAME: DURABILITY_TABLE_NAME,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      dynamoGet: api.dynamoGet,
    })

    expect(report.failures).toEqual(['configuration-invalid'])
    expect(api.requestPaths()).toEqual(['/api/health'])
    expect(api.dynamoCommands()).toEqual([])
  })

  test('runs six journeys and emits only content-free replay and provider evidence', async () => {
    const api = createFakeLiveApi()
    const waits: number[] = []
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => LIVE_EVALUATION_NOW_MS,
      wait: async (durationMs) => {
        waits.push(durationMs)
      },
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(true)
    expect(report.journeyCount).toBe(6)
    expect(report.passedJourneyCount).toBe(6)
    expect(report.checks).toEqual({
      commitMatched: true,
      staleRevisionRejected: true,
      postProviderSourceFencePassed: true,
      decisionReplayPassed: true,
      feedbackReplayPassed: true,
      withheldDisclosurePassed: true,
      withheldPermissionChangedPassed: true,
      withheldSourceChangedPassed: true,
      withheldRetentionExpiredPassed: true,
    })
    expect(report.journeys.map((journey) => journey.journey)).toEqual([
      'request',
      'triage',
      'work-item',
      'planning',
      'document',
      'search',
    ])
    expect(report.journeys.every((journey) => journey.metrics?.replayMatched)).toBe(true)
    expect(report.totals).toEqual({
      inputTokens: 700,
      outputTokens: 350,
      costUsd: 0.014,
    })
    expect(report.schemaVersion).toBe(2)
    expect(Object.keys(report).sort()).toEqual([
      'checks',
      'durability',
      'failures',
      'journeyCount',
      'journeys',
      'passed',
      'passedJourneyCount',
      'schemaVersion',
      'totals',
    ])
    expect(report.durability).toEqual({
      passed: true,
      receiptCount: 7,
      successfulAttemptCount: 6,
      auditEnvelopeCount: 6,
      generationCount: 6,
      feedbackCount: 1,
      staleAttemptAbsent: true,
      staleGenerationAbsent: true,
      postProviderFailedReceiptCount: 1,
      postProviderFailedAttemptCount: 1,
      postProviderAuditEnvelopeCount: 1,
      postProviderGenerationAbsent: true,
      approvedDecisionPersisted: true,
    })
    const expectedRecordKeys = expectedDurabilityRecordKeys()
    const commands = api.dynamoCommands()
    expect(commands).toHaveLength(expectedRecordKeys.length)
    commands.forEach((command, index) => {
      expect(command).toBeInstanceOf(GetCommand)
      expect(Object.keys(command.input).sort()).toEqual([
        'ConsistentRead',
        'Key',
        'TableName',
      ])
      expect(command.input).toEqual({
        TableName: DURABILITY_TABLE_NAME,
        Key: {
          workspaceId: SYNTHETIC_WORKSPACE_ID,
          recordKey: expectedRecordKeys[index],
        },
        ConsistentRead: true,
      })
    })
    expect(api.operationEvents().at(-1)).toBe('http:/api/health')
    expect(waits).toEqual([
      16_000,
      16_000,
      16_000,
      16_000,
      16_000,
      16_000,
      16_000,
    ])
    expect(api.postProviderInvocationCount()).toBe(1)
    expect(api.commitProbeWasFirst()).toBe(true)
    expect(api.discardedBodyCount()).toBe(3)
    expect(api.discardedBodyAfterReadCount()).toBe(0)
    expect(api.responseTextCallCount()).toBe(0)

    const serialized = JSON.stringify(report)
    for (const forbidden of [
      ACCESS_TOKEN,
      FORBIDDEN_CANARY,
      PRIVATE_MODEL_ID,
      PRIVATE_TRACE_ID,
      PERMISSION_WITHHELD_GENERATION_ID,
      GENERATION_EXPIRES_AT,
      WITHHELD_GENERATION_ID,
      RETENTION_WITHHELD_GENERATION_ID,
      DURABILITY_TABLE_NAME,
      SYNTHETIC_WORKSPACE_ID,
      SYNTHETIC_MEMBER_ID,
      'private-request-submission-id',
      'Private synthetic search text',
    ]) expect(serialized).not.toContain(forbidden)
  })

  test('recovers a lost Work Item mutation response and accepts either stable fence conflict', async () => {
    const api = createFakeLiveApi({
      postProviderMutationResponseLoss: true,
      postProviderFailureCode: 'AiAssistanceAuthorizationChanged',
    })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: TEST_API_BASE_URL,
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => LIVE_EVALUATION_NOW_MS,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(true)
    expect(report.checks.postProviderSourceFencePassed).toBe(true)
    expect(report.totals).toEqual({
      inputTokens: 700,
      outputTokens: 350,
      costUsd: 0.014,
    })
    expect(api.postProviderInvocationCount()).toBe(1)
  })

  test('fails closed on an invalid paid-attempt outcome, zero usage, or replay overwrite', async () => {
    for (const [mutation, expectedFailure] of [
      [
        'post-provider-outcome',
        'post-provider-source-fence-durability-mismatch',
      ],
      [
        'post-provider-zero-usage',
        'post-provider-source-fence-unreconciled',
      ],
      [
        'post-provider-replay-overwrite',
        'post-provider-source-fence-durability-mismatch',
      ],
    ] satisfies readonly [
      FakeDurabilityMutation,
      AiAssistanceLiveEvalFailureCode,
    ][]) {
      const api = createFakeLiveApi({ durabilityMutation: mutation })
      const report = await evaluateAiAssistanceLive({
        apiBaseUrl: TEST_API_BASE_URL,
        accessToken: ACCESS_TOKEN,
        expectedCommitSha: EXPECTED_COMMIT_SHA,
        ...DURABILITY_INPUT,
        fixture: LIVE_FIXTURE,
      }, {
        fetch: api.fetch,
        apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
        now: () => LIVE_EVALUATION_NOW_MS,
        wait: async () => undefined,
        createIdempotencyKey: createKeyGenerator(),
        dynamoGet: api.dynamoGet,
      })

      expect(report.passed).toBe(false)
      expect(report.checks.postProviderSourceFencePassed).toBe(false)
      expect(report.failures).toContain(expectedFailure)
      expect(api.postProviderInvocationCount()).toBe(1)
    }
  })

  test('bounds a missing provider-start marker without mutating the Work Item', async () => {
    const api = createFakeLiveApi({
      durabilityMutation: 'post-provider-attempt-timeout',
    })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: TEST_API_BASE_URL,
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => LIVE_EVALUATION_NOW_MS,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.failures).toContain(
      'post-provider-source-fence-attempt-timeout',
    )
    expect(api.postProviderInvocationCount()).toBe(0)
    expect(api.requestPaths().filter((path) =>
      path.includes(POST_PROVIDER_WORK_ITEM_ID))).toHaveLength(1)
  })

  test('accounts a server completion that becomes durable after local cancellation', async () => {
    const api = createFakeLiveApi({
      postProviderInitialReceiptReadFailure: true,
      postProviderCompletesAfterClientAbort: true,
    })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: TEST_API_BASE_URL,
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => LIVE_EVALUATION_NOW_MS,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(false)
    expect(report.failures).toContain(
      'post-provider-source-fence-durability-mismatch',
    )
    expect(report.failures).not.toContain(
      'post-provider-source-fence-unreconciled',
    )
    expect(report.totals).toEqual({
      inputTokens: 700,
      outputTokens: 350,
      costUsd: 0.014,
    })
    expect(report.durability.postProviderGenerationAbsent).toBe(false)
    expect(api.postProviderInvocationCount()).toBe(1)
    expect(api.requestPaths().filter((path) =>
      path.includes(POST_PROVIDER_WORK_ITEM_ID))).toHaveLength(1)
  })

  test('fails as unreconciled when a locally canceled server attempt stays pending', async () => {
    const api = createFakeLiveApi({
      postProviderInitialReceiptReadFailure: true,
    })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: TEST_API_BASE_URL,
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => LIVE_EVALUATION_NOW_MS,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(false)
    expect(report.failures).toContain(
      'post-provider-source-fence-unreconciled',
    )
    expect(report.totals).toEqual({
      inputTokens: 600,
      outputTokens: 300,
      costUsd: 0.012,
    })
    expect(api.postProviderInvocationCount()).toBe(1)
    expect(api.requestPaths().filter((path) =>
      path.includes(POST_PROVIDER_WORK_ITEM_ID))).toHaveLength(1)
  })

  test('reserves worst-case aggregate headroom before the seventh paid call', async () => {
    const fixture = structuredClone(LIVE_FIXTURE)
    if (!isRecord(fixture) || !isRecord(fixture.budgets)) {
      throw new TypeError('Expected the strict live fixture budgets.')
    }
    fixture.budgets.maxTotalInputTokens = 2_000
    fixture.budgets.maxTotalOutputTokens = 1_000
    fixture.budgets.maxTotalCostUsd = 0.1
    const api = createFakeLiveApi()
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: TEST_API_BASE_URL,
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => LIVE_EVALUATION_NOW_MS,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(false)
    expect(report.checks.postProviderSourceFencePassed).toBe(false)
    expect(report.failures).toContain(
      'post-provider-source-fence-budget-headroom-insufficient',
    )
    expect(api.postProviderInvocationCount()).toBe(0)
    expect(api.requestPaths().some((path) =>
      path.includes(POST_PROVIDER_WORK_ITEM_ID))).toBe(false)
  })

  test('stops before authenticated requests when the deployed commit does not match', async () => {
    const api = createFakeLiveApi({ commitSha: OTHER_COMMIT_SHA })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, { fetch: api.fetch, apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST })

    expect(report.passed).toBe(false)
    expect(report.failures).toEqual(['deployed-commit-mismatch'])
    expect(report.journeys).toEqual([])
    expect(api.requestCount()).toBe(1)
    expect(api.dynamoCommands()).toEqual([])
  })

  test('fails when the deployed commit changes during the evaluation window', async () => {
    const api = createFakeLiveApi({
      healthCommitShas: [EXPECTED_COMMIT_SHA, OTHER_COMMIT_SHA],
    })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(false)
    expect(report.checks.commitMatched).toBe(false)
    expect(report.failures).toContain('deployed-commit-mismatch')
    expect(api.requestPaths().at(-1)).toBe('/api/health')
  })

  test('fails redaction without copying unsafe response content into the report', async () => {
    const api = createFakeLiveApi({ unsafeJourney: 'document' })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(false)
    expect(report.journeys.find(
      (journey) => journey.journey === 'document',
    )?.failures).toContain('redaction-failed')
    expect(JSON.stringify(report)).not.toContain(FORBIDDEN_CANARY)
  })

  test('does not approve or rate a generation that failed safety checks', async () => {
    const api = createFakeLiveApi({ unsafeJourney: 'work-item' })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(false)
    expect(report.failures).toEqual(['decision-failed', 'feedback-failed'])
    expect(report.checks.decisionReplayPassed).toBe(false)
    expect(report.checks.feedbackReplayPassed).toBe(false)
    expect(api.reviewMutationCount()).toBe(0)
  })

  test('bounds streamed response bytes and emits only a stable size failure', async () => {
    const api = createFakeLiveApi({ oversizedJourney: 'document' })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.journeys.find(
      (journey) => journey.journey === 'document',
    )?.failures).toEqual(['response-too-large'])
    expect(JSON.stringify(report).length).toBeLessThan(10_000)
    expect(api.discardedBodyAfterReadCount()).toBe(1)
  })

  test('detects echoed access-token and JWT credentials without retaining them', async () => {
    const accessTokenApi = createFakeLiveApi({ leakedAccessTokenJourney: 'work-item' })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: accessTokenApi.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: accessTokenApi.dynamoGet,
    })
    const jwtApi = createFakeLiveApi({ leakedJwtJourney: 'document' })
    const jwtReport = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: jwtApi.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: jwtApi.dynamoGet,
    })

    expect(report.journeys.find(
      (journey) => journey.journey === 'work-item',
    )?.failures).toContain('redaction-failed')
    expect(jwtReport.journeys.find(
      (journey) => journey.journey === 'document',
    )?.failures).toContain('redaction-failed')
    expect(accessTokenApi.reviewMutationCount()).toBe(0)
    expect(JSON.stringify(report)).not.toContain(ACCESS_TOKEN)
    expect(JSON.stringify(jwtReport)).not.toContain(PRIVATE_JWT)
  })

  test('rejects a deployed model or prompt mismatch before review mutations', async () => {
    const api = createFakeLiveApi({ providerMismatchJourney: 'work-item' })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.journeys.find(
      (journey) => journey.journey === 'work-item',
    )?.failures).toContain('provider-configuration-mismatch')
    expect(api.reviewMutationCount()).toBe(0)
    expect(JSON.stringify(report)).not.toContain(MISMATCHED_MODEL_ID)
  })

  test('fails closed on unavailable usage and every per-case provider budget', async () => {
    const usageApi = createFakeLiveApi({ missingUsageJourney: 'document' })
    const usageReport = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: usageApi.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: usageApi.dynamoGet,
    })
    const budgetApi = createFakeLiveApi({ overBudgetJourney: 'document' })
    const budgetReport = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: budgetApi.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: budgetApi.dynamoGet,
    })

    expect(usageReport.journeys.find(
      (journey) => journey.journey === 'document',
    )?.failures).toContain('usage-missing')
    const budgetFailures = budgetReport.journeys.find(
      (journey) => journey.journey === 'document',
    )?.failures
    expect(budgetFailures).toContain('latency-budget-exceeded')
    expect(budgetFailures).toContain('input-token-budget-exceeded')
    expect(budgetFailures).toContain('output-token-budget-exceeded')
    expect(budgetFailures).toContain('cost-budget-exceeded')
  })

  test('requires a withheld response to match the requested generation', async () => {
    const api = createFakeLiveApi({ invalidWithheldGenerationId: true })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.checks.withheldDisclosurePassed).toBe(false)
    expect(report.checks.withheldPermissionChangedPassed).toBe(true)
    expect(report.checks.withheldSourceChangedPassed).toBe(false)
    expect(report.checks.withheldRetentionExpiredPassed).toBe(true)
    expect(report.failures).toContain('withheld-disclosure-failed')
    expect(api.requestPaths().filter((path) => path.includes('withheld'))).toEqual([
      `/api/ai-assistance/generations/${PERMISSION_WITHHELD_GENERATION_ID}`,
      `/api/ai-assistance/generations/${WITHHELD_GENERATION_ID}`,
      `/api/ai-assistance/generations/${RETENTION_WITHHELD_GENERATION_ID}`,
    ])
    expect(JSON.stringify(report)).not.toContain('private-unexpected-withheld-generation-id')
  })

  test('requires server-owned replay evidence on every generation and feedback retry', async () => {
    const generationApi = createFakeLiveApi({ missingReplayJourney: 'request' })
    const generationReport = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: generationApi.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: generationApi.dynamoGet,
    })
    const feedbackApi = createFakeLiveApi({ missingFeedbackReplay: true })
    const feedbackReport = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: feedbackApi.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: feedbackApi.dynamoGet,
    })

    expect(generationReport.journeys[0]?.failures).toContain('replay-evidence-missing')
    expect(feedbackReport.checks.feedbackReplayPassed).toBe(false)
    expect(feedbackReport.failures).toContain('feedback-replay-failed')
  })

  test('rejects replay evidence on a first generation response', async () => {
    const api = createFakeLiveApi({ unexpectedFirstReplayJourney: 'triage' })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.journeys.find(
      (journey) => journey.journey === 'triage',
    )?.failures).toContain('replay-evidence-missing')
  })

  test('rejects an approval response that changes immutable generation fields', async () => {
    const api = createFakeLiveApi({ invalidDecisionMutation: true })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.checks.decisionReplayPassed).toBe(false)
    expect(report.failures).toContain('decision-replay-mismatch')
  })

  test('fails closed on receipt, attempt, audit, linkage, stale, decision, and feedback drift', async () => {
    const cases = [
      { mutation: 'receipt-link', failure: 'durability-receipt-mismatch' },
      { mutation: 'attempt-status', failure: 'durability-attempt-mismatch' },
      { mutation: 'attempt-provider-start', failure: 'durability-attempt-mismatch' },
      { mutation: 'attempt-usage', failure: 'durability-attempt-mismatch' },
      { mutation: 'audit-schema', failure: 'durability-attempt-mismatch' },
      { mutation: 'audit-canary', failure: 'durability-attempt-mismatch' },
      { mutation: 'audit-credential', failure: 'durability-attempt-mismatch' },
      { mutation: 'receipt-retention', failure: 'durability-receipt-mismatch' },
      { mutation: 'generation-link', failure: 'durability-generation-mismatch' },
      { mutation: 'generation-retention', failure: 'durability-generation-mismatch' },
      { mutation: 'stale-attempt', failure: 'durability-attempt-mismatch' },
      { mutation: 'stale-generation', failure: 'durability-generation-mismatch' },
      { mutation: 'stale-retention', failure: 'durability-receipt-mismatch' },
      { mutation: 'decision', failure: 'durability-generation-mismatch' },
      { mutation: 'feedback', failure: 'durability-feedback-mismatch' },
      { mutation: 'feedback-retention', failure: 'durability-feedback-mismatch' },
    ] satisfies readonly {
      mutation: FakeDurabilityMutation
      failure:
        | 'durability-receipt-mismatch'
        | 'durability-attempt-mismatch'
        | 'durability-generation-mismatch'
        | 'durability-feedback-mismatch'
    }[]

    for (const durabilityCase of cases) {
      const api = createFakeLiveApi({
        durabilityMutation: durabilityCase.mutation,
      })
      const report = await evaluateAiAssistanceLive({
        apiBaseUrl: 'https://production.example.test',
        accessToken: ACCESS_TOKEN,
        expectedCommitSha: EXPECTED_COMMIT_SHA,
        ...DURABILITY_INPUT,
        fixture: LIVE_FIXTURE,
      }, {
        fetch: api.fetch,
        apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
        now: () => 0,
        wait: async () => undefined,
        createIdempotencyKey: createKeyGenerator(),
        dynamoGet: api.dynamoGet,
      })

      expect(report.passed).toBe(false)
      expect(report.failures).toContain(durabilityCase.failure)
      const serialized = JSON.stringify(report)
      expect(serialized).not.toContain(FORBIDDEN_CANARY)
      expect(serialized).not.toContain(ACCESS_TOKEN)
      expect(serialized).not.toContain(DURABILITY_TABLE_NAME)
      expect(serialized).not.toContain(SYNTHETIC_WORKSPACE_ID)
      expect(serialized).not.toContain(SYNTHETIC_MEMBER_ID)
    }
  })

  test('requires every retained row deadline to remain future at evaluation time', async () => {
    const api = createFakeLiveApi()
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => EXPIRED_EVALUATION_NOW_MS,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.passed).toBe(false)
    expect(report.failures).toContain('durability-receipt-mismatch')
    expect(report.failures).toContain('durability-generation-mismatch')
    expect(report.failures).toContain('durability-feedback-mismatch')
    expect(report.durability.receiptCount).toBe(0)
    expect(report.durability.generationCount).toBe(0)
    expect(report.durability.feedbackCount).toBe(0)
    expect(JSON.stringify(report)).not.toContain(GENERATION_EXPIRES_AT)
  })

  test('maps raw AWS read failures to one content-free stable durability failure', async () => {
    const api = createFakeLiveApi({ durabilityMutation: 'aws-error' })
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: LIVE_FIXTURE,
    }, {
      fetch: api.fetch,
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      now: () => 0,
      wait: async () => undefined,
      createIdempotencyKey: createKeyGenerator(),
      dynamoGet: api.dynamoGet,
    })

    expect(report.failures).toEqual([
      'post-provider-source-fence-unreconciled',
      'durability-read-failed',
    ])
    expect(report.durability).toEqual({
      passed: false,
      receiptCount: 0,
      successfulAttemptCount: 0,
      auditEnvelopeCount: 0,
      generationCount: 0,
      feedbackCount: 0,
      staleAttemptAbsent: false,
      staleGenerationAbsent: false,
      postProviderFailedReceiptCount: 0,
      postProviderFailedAttemptCount: 0,
      postProviderAuditEnvelopeCount: 0,
      postProviderGenerationAbsent: false,
      approvedDecisionPersisted: false,
    })
    expect(api.dynamoCommands()).toHaveLength(3)
    const serialized = JSON.stringify(report)
    for (const forbidden of [
      'private raw AWS error',
      PRIVATE_AWS_ACCOUNT_ID,
      DURABILITY_TABLE_NAME,
      SYNTHETIC_WORKSPACE_ID,
      SYNTHETIC_MEMBER_ID,
      PRIVATE_MODEL_ID,
      PRIVATE_TRACE_ID,
    ]) expect(serialized).not.toContain(forbidden)
  })

  test('rejects non-HTTPS and incomplete fixtures without making a request', async () => {
    let requestCount = 0
    const fetch: AiAssistanceLiveFetch = async () => {
      requestCount += 1
      return jsonResponse(500, {})
    }
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'http://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture: { schemaVersion: 1, cases: [] },
    }, { fetch, apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST })

    expect(report).toMatchObject({
      passed: false,
      journeyCount: 0,
      failures: ['configuration-invalid'],
    })
    expect(requestCount).toBe(0)
    expect(JSON.stringify(report)).not.toContain('production.example.test')
  })

  test('rejects unknown protected fixture properties before making a request', async () => {
    const fixture = structuredClone(LIVE_FIXTURE)
    if (!isRecord(fixture)) throw new Error('Expected record fixture.')
    fixture.unexpectedPrivateField = 'private-value'
    let requestCount = 0
    const report = await evaluateAiAssistanceLive({
      apiBaseUrl: 'https://production.example.test',
      accessToken: ACCESS_TOKEN,
      expectedCommitSha: EXPECTED_COMMIT_SHA,
      ...DURABILITY_INPUT,
      fixture,
    }, {
      apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
      fetch: async () => {
        requestCount += 1
        return jsonResponse(500, {})
      },
    })

    expect(report.failures).toEqual(['configuration-invalid'])
    expect(requestCount).toBe(0)
    expect(JSON.stringify(report)).not.toContain('private-value')
  })

  test('requires exactly one fixture for every withheld disclosure reason', async () => {
    const missing = structuredClone(LIVE_FIXTURE)
    const duplicate = structuredClone(LIVE_FIXTURE)
    if (
      !isRecord(missing) ||
      !Array.isArray(missing.withheld) ||
      !isRecord(duplicate) ||
      !Array.isArray(duplicate.withheld)
    ) throw new Error('Expected withheld fixture arrays.')
    missing.withheld = missing.withheld.slice(0, 2)
    duplicate.withheld = [
      duplicate.withheld[0],
      duplicate.withheld[0],
      duplicate.withheld[2],
    ]

    for (const fixture of [missing, duplicate]) {
      let requestCount = 0
      const report = await evaluateAiAssistanceLive({
        apiBaseUrl: TEST_API_BASE_URL,
        accessToken: ACCESS_TOKEN,
        expectedCommitSha: EXPECTED_COMMIT_SHA,
        ...DURABILITY_INPUT,
        fixture,
      }, {
        apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
        fetch: async () => {
          requestCount += 1
          return jsonResponse(500, {})
        },
      })
      expect(report.failures).toEqual(['configuration-invalid'])
      expect(requestCount).toBe(0)
    }
  })

  test('requires an exact, alternating, journey-distinct post-provider fixture', async () => {
    const unknownField = structuredClone(LIVE_FIXTURE)
    const duplicateTitle = structuredClone(LIVE_FIXTURE)
    const reusedWorkItem = structuredClone(LIVE_FIXTURE)
    if (
      !isRecord(unknownField) ||
      !isRecord(unknownField.postProviderSourceFence) ||
      !isRecord(duplicateTitle) ||
      !isRecord(duplicateTitle.postProviderSourceFence) ||
      !isRecord(reusedWorkItem) ||
      !isRecord(reusedWorkItem.postProviderSourceFence)
    ) throw new Error('Expected post-provider fixture records.')
    unknownField.postProviderSourceFence.unexpected = true
    duplicateTitle.postProviderSourceFence.titleB = POST_PROVIDER_TITLE_A
    reusedWorkItem.postProviderSourceFence.teamId = 'private-work-item-team-id'
    reusedWorkItem.postProviderSourceFence.workItemId = 'private-work-item-id'

    for (const fixture of [unknownField, duplicateTitle, reusedWorkItem]) {
      let requestCount = 0
      const report = await evaluateAiAssistanceLive({
        apiBaseUrl: TEST_API_BASE_URL,
        accessToken: ACCESS_TOKEN,
        expectedCommitSha: EXPECTED_COMMIT_SHA,
        ...DURABILITY_INPUT,
        fixture,
      }, {
        apiBaseUrlAllowlist: TEST_API_BASE_URL_ALLOWLIST,
        fetch: async () => {
          requestCount += 1
          return jsonResponse(500, {})
        },
      })
      expect(report.failures).toEqual(['configuration-invalid'])
      expect(requestCount).toBe(0)
    }
  })
})
