import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandOutput,
} from '@aws-sdk/lib-dynamodb'
import type {
  AiAssistanceDraft,
  AiAssistanceGeneration,
  AiAssistanceSource,
  CreateAiAssistanceFeedbackRequest,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import {
  createAiAssistanceFeedbackIdentity,
  createAiAssistanceFeedbackRecordKey,
  createAiAssistanceGenerationInputFingerprint,
  createAiAssistanceGenerationRecordKey,
  createAiAssistanceIdempotencyRecordKey,
  parseAiAssistanceGeneration,
  parseCreateAiAssistanceFeedbackRequest,
  parseGenerateAiAssistanceRequest,
  redactAiAssistanceText,
  redactGenerateAiAssistanceRequest,
} from '../../src/modules/ai-assistance'

/** Stable production journey names that are safe to include in evaluation artifacts. */
export type AiAssistanceLiveJourney =
  | 'request'
  | 'triage'
  | 'work-item'
  | 'planning'
  | 'document'
  | 'search'

/** Content-free failure codes emitted by the production-like evaluator. */
export type AiAssistanceLiveEvalFailureCode =
  | 'configuration-invalid'
  | 'authentication-failed'
  | 'transport-failed'
  | 'response-too-large'
  | 'response-json-invalid'
  | 'commit-probe-failed'
  | 'deployed-commit-mismatch'
  | 'generation-http-failed'
  | 'generation-schema-invalid'
  | 'generation-withheld'
  | 'journey-task-mismatch'
  | 'idempotent-replay-mismatch'
  | 'replay-evidence-missing'
  | 'evidence-missing'
  | 'citation-invalid'
  | 'uncertainty-missing'
  | 'redaction-failed'
  | 'provider-configuration-mismatch'
  | 'usage-missing'
  | 'latency-budget-exceeded'
  | 'input-token-budget-exceeded'
  | 'output-token-budget-exceeded'
  | 'cost-budget-exceeded'
  | 'aggregate-input-token-budget-exceeded'
  | 'aggregate-output-token-budget-exceeded'
  | 'aggregate-cost-budget-exceeded'
  | 'stale-revision-accepted'
  | 'stale-revision-error-mismatch'
  | 'post-provider-source-fence-setup-failed'
  | 'post-provider-source-fence-attempt-timeout'
  | 'post-provider-source-fence-mutation-failed'
  | 'post-provider-source-fence-error-mismatch'
  | 'post-provider-source-fence-replay-mismatch'
  | 'post-provider-source-fence-durability-mismatch'
  | 'post-provider-source-fence-unreconciled'
  | 'post-provider-source-fence-budget-headroom-insufficient'
  | 'decision-failed'
  | 'decision-replay-mismatch'
  | 'feedback-failed'
  | 'feedback-replay-failed'
  | 'withheld-disclosure-failed'
  | 'withheld-reason-mismatch'
  | 'durability-read-failed'
  | 'durability-receipt-mismatch'
  | 'durability-attempt-mismatch'
  | 'durability-generation-mismatch'
  | 'durability-feedback-mismatch'

/** Non-content provider metrics safe to retain for one live journey. */
export type AiAssistanceLiveEvalMetrics = {
  /** Provider-reported input token count. */
  inputTokens: number
  /** Provider-reported output token count. */
  outputTokens: number
  /** Provider-reported end-to-end latency in milliseconds. */
  latencyMs: number
  /** Deployment-calculated provider cost in USD. */
  costUsd: number
  /** Number of permission-safe citations returned for the journey. */
  citationCount: number
  /** Whether an uncertainty disclosure was present. */
  uncertaintyPresent: boolean
  /** Whether the identical-key replay returned the exact generation. */
  replayMatched: boolean
}

/** Content-free result for one fixed production journey. */
export type AiAssistanceLiveEvalJourneyResult = {
  /** Stable journey category; never a tenant or resource identifier. */
  journey: AiAssistanceLiveJourney
  /** Whether every live check for the journey passed. */
  passed: boolean
  /** Stable failure codes without request, response, identifier, or error text. */
  failures: AiAssistanceLiveEvalFailureCode[]
  /** Provider metrics, present only after a strict generation was parsed. */
  metrics?: AiAssistanceLiveEvalMetrics
}

/** Cross-journey mutation and disclosure checks included in the live gate. */
export type AiAssistanceLiveEvalChecks = {
  /** Whether the deployed API reported the exact evaluated Git commit. */
  commitMatched: boolean
  /** Whether a stale source revision failed with the stable source-change contract. */
  staleRevisionRejected: boolean
  /** Whether a real provider result was discarded after its Work Item source changed. */
  postProviderSourceFencePassed: boolean
  /** Whether an approved decision replayed exactly with its original revision. */
  decisionReplayPassed: boolean
  /** Whether identical feedback safely replayed with the same idempotency key. */
  feedbackReplayPassed: boolean
  /** Whether all three pre-arranged inaccessible generations disclosed no retained content. */
  withheldDisclosurePassed: boolean
  /** Whether the permission-change disclosure case returned only its withheld reason. */
  withheldPermissionChangedPassed: boolean
  /** Whether the source-change disclosure case returned only its withheld reason. */
  withheldSourceChangedPassed: boolean
  /** Whether the retention-expiry disclosure case returned only its withheld reason. */
  withheldRetentionExpiredPassed: boolean
}

/** Fixed content-free durability evidence for one complete production-like run. */
export type AiAssistanceLiveEvalDurability = {
  /** Whether every expected exact-key DynamoDB invariant passed. */
  passed: boolean
  /** Number of six successful receipts plus the terminal stale-source receipt. */
  receiptCount: number
  /** Number of singleton provider attempts finalized as succeeded. */
  successfulAttemptCount: number
  /** Number of strict, redacted attempt audit envelopes verified in memory. */
  auditEnvelopeCount: number
  /** Number of linked generation rows verified by canonical key. */
  generationCount: number
  /** Number of deterministic feedback rows verified by canonical key. */
  feedbackCount: number
  /** Whether the stale-source receipt was terminal without starting an attempt. */
  staleAttemptAbsent: boolean
  /** Whether no generation row exists for the stale-source receipt. */
  staleGenerationAbsent: boolean
  /** Number of terminal failed receipts verified for the post-provider source fence. */
  postProviderFailedReceiptCount: number
  /** Number of singleton failed attempts proving a successful provider outcome was discarded. */
  postProviderFailedAttemptCount: number
  /** Number of strict redacted audit envelopes verified for the discarded provider result. */
  postProviderAuditEnvelopeCount: number
  /** Whether the post-provider source-fence receipt has no linked generation row. */
  postProviderGenerationAbsent: boolean
  /** Whether the Work Item generation retained exactly one approved decision revision. */
  approvedDecisionPersisted: boolean
}

/** Content-free aggregate report suitable for protected release evidence. */
export type AiAssistanceLiveEvalReport = {
  /** Version of this content-free report contract. */
  schemaVersion: 2
  /** Whether all journey, mutation, disclosure, and aggregate-budget checks passed. */
  passed: boolean
  /** Number of fixed journeys attempted after commit verification. */
  journeyCount: number
  /** Number of journeys whose complete live checks passed. */
  passedJourneyCount: number
  /** Ordered fixed-journey results without opaque identifiers or content. */
  journeys: AiAssistanceLiveEvalJourneyResult[]
  /** Cross-journey fail-closed checks. */
  checks: AiAssistanceLiveEvalChecks
  /** Stable aggregate failures that are not owned by one journey. */
  failures: AiAssistanceLiveEvalFailureCode[]
  /** Exact-key, strongly consistent persistence evidence without opaque identifiers. */
  durability: AiAssistanceLiveEvalDurability
  /** Provider totals counted once per paid attempt, including the discarded drill call. */
  totals: {
    /** Total provider-reported input tokens. */
    inputTokens: number
    /** Total provider-reported output tokens. */
    outputTokens: number
    /** Total deployment-calculated provider cost in USD. */
    costUsd: number
  }
}

/** External input supplied only from a protected evaluation environment. */
export type AiAssistanceLiveEvaluationInput = {
  /** HTTPS origin or stage base URL for the deployed API. */
  apiBaseUrl: string
  /** Short-lived Cognito access token for the synthetic evaluation operator. */
  accessToken: string
  /** Full Git commit SHA checked out by the trusted workflow. */
  expectedCommitSha: string
  /** AWS Region containing the synthetic evaluation Workspace table. */
  awsRegion: string
  /** Exact Workspace Search table name provisioned for the evaluated deployment. */
  durabilityTableName: string
  /** Untrusted secret fixture parsed without ever being returned or logged. */
  fixture: unknown
}

/** Minimal response surface used by the injectable live HTTP boundary. */
export type AiAssistanceLiveHttpResponse = {
  /** HTTP response status. */
  readonly status: number
  /** Reads server-owned response metadata without exposing header values. */
  readonly headers: {
    /** Returns one response header value. */
    get(name: string): string | null
  }
  /** Optional byte stream read with a hard in-memory limit or canceled unread. */
  readonly body?: ReadableStream<Uint8Array> | null
  /** Native full-body reader retained only to model the platform Response surface. */
  text(): Promise<string>
}

/** Injectable HTTPS client used by production and deterministic unit tests. */
export type AiAssistanceLiveFetch = (
  url: string,
  init: RequestInit,
) => Promise<AiAssistanceLiveHttpResponse>

/** Injectable runtime boundaries for deterministic evaluator tests. */
export type AiAssistanceLiveEvaluationRuntime = {
  /** HTTPS request implementation, defaulting to the runtime fetch. */
  fetch?: AiAssistanceLiveFetch
  /** Test/library-only exact API bases replacing the checked-in production allowlist. */
  apiBaseUrlAllowlist?: readonly string[]
  /** Wall-clock reader used to pace requests and prove retention remains current. */
  now?: () => number
  /** Wait boundary used to remain below the production per-member minute limit. */
  wait?: (durationMs: number) => Promise<void>
  /** Generates opaque idempotency keys that never enter the report. */
  createIdempotencyKey?: () => string
  /** Exact DynamoDB GetItem transport used by the protected CLI and deterministic tests. */
  dynamoGet?: AiAssistanceLiveDynamoGet
}

/** Read-only DynamoDB transport that accepts only GetCommand instances. */
export type AiAssistanceLiveDynamoGet = (
  command: GetCommand,
) => Promise<GetCommandOutput>

/** Secret fixture for one fixed journey and its exact API request. */
type AiAssistanceLiveFixtureCase = {
  /** Stable non-tenant journey category. */
  journey: AiAssistanceLiveJourney
  /** Strict API request containing only synthetic pre-provisioned resource identifiers. */
  request: GenerateAiAssistanceRequest
}

/** Fail-closed provider and aggregate budgets for the protected run. */
type AiAssistanceLiveBudgets = {
  /** Maximum provider latency for one new generation. */
  maxLatencyMsPerGeneration: number
  /** Maximum provider input tokens for one new generation. */
  maxInputTokensPerGeneration: number
  /** Maximum provider output tokens for one new generation. */
  maxOutputTokensPerGeneration: number
  /** Maximum provider cost for one new generation. */
  maxCostUsdPerGeneration: number
  /** Maximum total provider input tokens for all seven paid generations. */
  maxTotalInputTokens: number
  /** Maximum total provider output tokens for all seven paid generations. */
  maxTotalOutputTokens: number
  /** Maximum total provider cost for all seven paid generations. */
  maxTotalCostUsd: number
}

/** Pre-arranged retained generation whose disclosure must now be withheld. */
type AiAssistanceLiveWithheldFixture = {
  /** Opaque generation identifier used in memory and never emitted. */
  generationId: string
  /** Expected fail-closed disclosure reason for the pre-arranged state. */
  reasonCode: 'permission-changed' | 'retention-expired' | 'source-changed'
}

/** Dedicated repeatable Work Item mutation used to exercise the post-provider source fence. */
type AiAssistanceLivePostProviderSourceFenceFixture = {
  /** Team owning the synthetic drill-only Work Item. */
  teamId: string
  /** Drill-only Work Item identifier, distinct from the six journey sources. */
  workItemId: string
  /** Locale used by the real summary generation. */
  locale: GenerateAiAssistanceRequest['locale']
  /** First exact synthetic title permitted at the start of a run. */
  titleA: string
  /** Second exact synthetic title permitted at the start of a run. */
  titleB: string
}

/** Strict parsed secret fixture used by a production-like run. */
type AiAssistanceLiveFixture = {
  /** Exactly one request for each of the six required journeys. */
  cases: AiAssistanceLiveFixtureCase[]
  /** Request containing a known stale positive source revision. */
  staleRevisionRequest: GenerateAiAssistanceRequest
  /** Dedicated alternating-title source used for an active post-provider revision race. */
  postProviderSourceFence: AiAssistanceLivePostProviderSourceFenceFixture
  /** Exact permission, source, and retention cases that must disclose only withheld reasons. */
  withheld: AiAssistanceLiveWithheldFixture[]
  /** Seeded sensitive canaries forbidden in every API response. */
  forbiddenSubstrings: string[]
  /** Exact Bedrock model or inference-profile identifier expected from the deployment. */
  expectedModelId: string
  /** Exact prompt contract revision expected from the deployment. */
  expectedPromptVersion: string
  /** Explicit per-generation and aggregate provider budgets. */
  budgets: AiAssistanceLiveBudgets
  /** Synthetic partition and member identities used only for exact durability reads. */
  durability: AiAssistanceLiveDurabilityFixture
}

/** Synthetic partition identifiers required for exact-key durability evidence. */
type AiAssistanceLiveDurabilityFixture = {
  /** Dedicated synthetic Workspace partition allowed by the read-only role. */
  workspaceId: string
  /** Synthetic member that owns every generated receipt in this run. */
  memberId: string
}

/** Parsed evaluator input kept separate from the public untrusted boundary. */
type ParsedAiAssistanceLiveEvaluationInput = {
  /** Normalized HTTPS API base URL without a trailing slash. */
  apiBaseUrl: string
  /** Validated short-lived access token. */
  accessToken: string
  /** Normalized full lowercase Git commit SHA. */
  expectedCommitSha: string
  /** Strict AWS Region used by the default DynamoDB client. */
  awsRegion: string
  /** Strict physical Workspace Search table name. */
  durabilityTableName: string
  /** Strict secret fixture. */
  fixture: AiAssistanceLiveFixture
}

/** Bounded parsed HTTP response retained only in process memory. */
type LiveJsonResponse = {
  /** HTTP response status. */
  status: number
  /** Response headers used only for fixed replay evidence. */
  headers: AiAssistanceLiveHttpResponse['headers']
  /** Raw bounded response used only for in-memory canary detection. */
  text: string
  /** Parsed JSON value. */
  body: unknown
}

/** Internal generation-case result including the response needed by later mutation checks. */
type EvaluatedLiveGeneration = {
  /** Content-free public case result. */
  result: AiAssistanceLiveEvalJourneyResult
  /** Strict generation retained only in memory. */
  generation?: AiAssistanceGeneration
  /** Opaque request identity retained only until exact durability reads complete. */
  durabilityCase?: AiAssistanceLiveSuccessfulDurabilityCase
}

/** One successful journey and its in-memory exact-key persistence identity. */
type AiAssistanceLiveSuccessfulDurabilityCase = {
  /** Fixed content-free journey classification. */
  journey: AiAssistanceLiveJourney
  /** Original strict request used to derive the durable input fingerprint. */
  request: GenerateAiAssistanceRequest
  /** Opaque client key used to derive the canonical receipt key. */
  idempotencyKey: string
  /** Strict generation returned by both the first request and its replay. */
  generation: AiAssistanceGeneration
}

/** Terminal stale-source request identity retained only for exact durability reads. */
type AiAssistanceLiveStaleDurabilityCase = {
  /** Original strict stale-source request used to derive the receipt fingerprint. */
  request: GenerateAiAssistanceRequest
  /** Opaque client key used for both stale-source requests. */
  idempotencyKey: string
}

/** Opaque in-memory evidence for the active post-provider source-fence drill. */
type AiAssistanceLivePostProviderSourceFenceEvidence = {
  /** Whether the complete HTTP, replay, and persistence drill passed. */
  passed: boolean
  /** Stable content-free failure describing the first failed drill invariant. */
  failure?: AiAssistanceLiveEvalFailureCode
  /** Number of terminal failed receipts that passed strict validation. */
  failedReceiptCount: number
  /** Number of singleton failed attempts with a successful provider outcome. */
  failedAttemptCount: number
  /** Number of strict redacted audit envelopes on the failed attempt. */
  auditEnvelopeCount: number
  /** Whether the server-generated generation identity has no canonical row. */
  generationAbsent: boolean
  /** Strict provider usage charged by the discarded real-model attempt. */
  usage?: AiAssistanceLivePostProviderUsage
}

/** Provider usage charged by the discarded seventh live generation. */
type AiAssistanceLivePostProviderUsage = {
  /** Provider-reported input token count. */
  inputTokens: number
  /** Provider-reported output token count. */
  outputTokens: number
  /** Provider-reported provider latency in milliseconds. */
  latencyMs: number
  /** Deployment-calculated provider cost in USD. */
  costUsd: number
}

/** Stable source-fence conflicts accepted from post-resolver or commit-time fencing. */
type PostProviderSourceFenceErrorCode =
  | 'AiAssistanceSourceChanged'
  | 'AiAssistanceAuthorizationChanged'

/** Runtime boundaries required by the active post-provider source-fence drill. */
type VerifyPostProviderSourceFenceInput = {
  /** Strict protected evaluator input. */
  input: ParsedAiAssistanceLiveEvaluationInput
  /** Authenticated production-like HTTP boundary. */
  fetchLive: AiAssistanceLiveFetch
  /** Strongly consistent exact-key DynamoDB boundary. */
  dynamoGet: AiAssistanceLiveDynamoGet
  /** Wall-clock reader used for retention checks. */
  now: () => number
  /** Bounded polling wait boundary. */
  wait: (durationMs: number) => Promise<void>
  /** Opaque key generator used separately for generation and mutation requests. */
  createIdempotencyKey: () => string
}

/** Strict current Work Item fields needed to construct a revision-fenced drill request. */
type PostProviderSourceFenceWorkItemSnapshot = {
  /** Current optimistic-concurrency revision. */
  revision: number
  /** Exact currently permitted synthetic title. */
  title: string
}

/** Strongly observed started-attempt identity retained until terminal verification. */
type PostProviderSourceFenceStartedAttempt = {
  /** Canonical receipt sort key used by both strong reads. */
  receiptKey: string
  /** Server-generated generation identity used only for an exact absence read. */
  generationId: string
}

/** Strict terminal receipt snapshot taken before and after the same-key replay. */
type PostProviderSourceFenceTerminalSnapshot = {
  /** Exact receipt value used to prove replay did not overwrite the attempt. */
  receipt: unknown
  /** Strict paid-provider usage retained for budget accounting. */
  usage: AiAssistanceLivePostProviderUsage
}

/** Bounded terminal accounting performed after an active-drill failure. */
type PostProviderSourceFenceReconciliation = {
  /** Whether a coherent provider-free or usage-accounted terminal state was observed. */
  accounted: boolean
  /** Whether the canonical generation row was absent at the accounted terminal state. */
  generationAbsent: boolean
  /** Positive paid-provider usage recovered from a failed or completed attempt. */
  usage?: AiAssistanceLivePostProviderUsage
}

/** One strong-read reconciliation probe without protected identifiers or content. */
type PostProviderSourceFenceReconciliationProbe = {
  /** Whether the exact receipt remains pending, is accounted, or cannot be trusted. */
  state: 'pending' | 'accounted' | 'unreconciled'
  /** Whether the canonical generation row was proven absent for this probe. */
  generationAbsent: boolean
  /** Positive paid-provider usage recovered even when another invariant is malformed. */
  usage?: AiAssistanceLivePostProviderUsage
}

/** Strict classification of one terminal drill receipt before its generation-row check. */
type PostProviderSourceFenceTerminalAccounting = {
  /** Whether the terminal receipt represents a provider-free, paid-failed, or paid-completed run. */
  outcome: 'provider-free' | 'paid-failed' | 'paid-completed'
  /** Server-owned generation identity used for the canonical strong read. */
  generationId: string
  /** Positive paid-provider usage when a provider outcome can be accounted. */
  usage?: AiAssistanceLivePostProviderUsage
}

/** Inputs required to account one drill request after its primary invariant failed. */
type ReconcilePostProviderSourceFenceFailureInput = {
  /** Strict evaluator, HTTP, clock, polling, and DynamoDB boundaries. */
  verification: VerifyPostProviderSourceFenceInput
  /** Exact generation request whose receipt and generation rows must be reconciled. */
  request: GenerateAiAssistanceRequest
  /** Opaque idempotency key used by both the original call and safe replay. */
  idempotencyKey: string
  /** Exact authenticated request reused without changing the request fingerprint. */
  generationRequest: RequestInit
  /** Client-local controller for the original request. */
  originalController: AbortController
  /** Already-caught original request settlement. */
  originalSettlement: Promise<LiveJsonRequestSettlement>
  /** Stable primary invariant failure retained when terminal accounting succeeds. */
  failure: AiAssistanceLiveEvalFailureCode
}

/** Content-free settlement of one bounded JSON request. */
type LiveJsonRequestSettlement = {
  /** Whether the bounded request and JSON parse completed. */
  fulfilled: boolean
  /** Parsed response when the request completed; absent after any transport failure. */
  response?: LiveJsonResponse
}

/** Deterministic feedback identity retained only for exact durability reads. */
type AiAssistanceLiveFeedbackDurabilityCase = {
  /** Generation that received feedback. */
  generationId: string
  /** Public retention deadline inherited by the feedback row. */
  generationExpiresAt: string
  /** Exact redacted feedback body submitted twice. */
  feedback: CreateAiAssistanceFeedbackRequest
  /** Opaque feedback idempotency key used for both submissions. */
  idempotencyKey: string
}

/** Complete in-memory input for the exact-key durability verification phase. */
type AiAssistanceLiveDurabilityVerificationInput = {
  /** Strict protected evaluator input. */
  input: ParsedAiAssistanceLiveEvaluationInput
  /** Evaluation wall-clock instant used for every retention comparison. */
  evaluatedAtMs: number
  /** Six successful journey identities and their parsed API generations. */
  cases: readonly AiAssistanceLiveSuccessfulDurabilityCase[]
  /** Deterministic feedback identity submitted by the successful HTTP phase. */
  feedback: AiAssistanceLiveFeedbackDurabilityCase
  /** Terminal stale-source receipt identity submitted by the HTTP phase. */
  stale: AiAssistanceLiveStaleDurabilityCase
  /** Strongly consistent exact-key DynamoDB boundary. */
  dynamoGet: AiAssistanceLiveDynamoGet
}

/** Content-free evidence and stable failures returned by durability verification. */
type AiAssistanceLiveDurabilityVerificationResult = {
  /** Fixed booleans and counts safe for the release artifact. */
  evidence: AiAssistanceLiveEvalDurability
  /** Stable failures without identifiers, configuration values, or AWS error text. */
  failures: AiAssistanceLiveEvalFailureCode[]
}

/** Mutable pacing state for unique paid generation keys. */
type UniqueGenerationPacer = {
  /** Waits until another unique generation may safely begin. */
  beforeNext(): Promise<void>
}

const REQUIRED_JOURNEYS: readonly AiAssistanceLiveJourney[] = [
  'request',
  'triage',
  'work-item',
  'planning',
  'document',
  'search',
]
const REQUIRED_WITHHELD_REASONS = [
  'permission-changed',
  'source-changed',
  'retention-expired',
] satisfies readonly AiAssistanceLiveWithheldFixture['reasonCode'][]
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/
const DYNAMODB_TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/
const UNIQUE_GENERATION_INTERVAL_MS = 16_000
const POST_PROVIDER_RECEIPT_POLL_INTERVAL_MS = 250
const POST_PROVIDER_RECEIPT_POLL_LIMIT = 80
const POST_PROVIDER_RECONCILIATION_POLL_LIMIT = 240
const POST_PROVIDER_ABORT_SETTLE_TIMEOUT_MS = 1_000
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_FIXTURE_BYTES = 64 * 1024
const DEFAULT_HTTP_TIMEOUT_OVERHEAD_MS = 8_000
const MAX_HTTP_TIMEOUT_MS = 45_000
const MIN_ACCESS_TOKEN_VALIDITY_MS = 10 * 60 * 1_000
const MAX_ACCESS_TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1_000
/**
 * Reviewed production API bases allowed to receive synthetic login credentials.
 *
 * @remarks Intentionally empty until an environment owner adds an exact normalized
 * deployment URL in a reviewed commit. Runtime environment variables cannot extend it.
 */
const REVIEWED_AI_ASSISTANCE_LIVE_API_BASE_URLS: readonly string[] = []

/**
 * Runs six real-model API journeys and the associated replay, fence, and disclosure checks.
 *
 * The returned report never includes request bodies, response bodies, bearer material,
 * opaque resource identifiers, model identifiers, trace identifiers, or raw error text.
 *
 * @param input - Protected environment values and an untrusted secret fixture.
 * @param runtime - Optional deterministic HTTP, clock, wait, and key boundaries.
 * @returns Content-free live release evidence.
 */
export async function evaluateAiAssistanceLive(
  input: AiAssistanceLiveEvaluationInput,
  runtime: AiAssistanceLiveEvaluationRuntime = {},
): Promise<AiAssistanceLiveEvalReport> {
  let parsed: ParsedAiAssistanceLiveEvaluationInput
  try {
    parsed = parseEvaluationInput(
      input,
      runtime.apiBaseUrlAllowlist ?? REVIEWED_AI_ASSISTANCE_LIVE_API_BASE_URLS,
    )
  } catch {
    return createEmptyReport(['configuration-invalid'])
  }

  const fetchLive: AiAssistanceLiveFetch = runtime.fetch ??
    ((url, init) => fetch(url, init))
  const now = runtime.now ?? Date.now
  const wait = runtime.wait ?? waitForDuration
  const createIdempotencyKey = runtime.createIdempotencyKey ?? randomUUID
  const pacer = createUniqueGenerationPacer(now, wait)
  const failures: AiAssistanceLiveEvalFailureCode[] = []
  const journeys: AiAssistanceLiveEvalJourneyResult[] = []
  const generations = new Map<AiAssistanceLiveJourney, AiAssistanceGeneration>()
  const durabilityCases: AiAssistanceLiveSuccessfulDurabilityCase[] = []
  let feedbackDurabilityCase: AiAssistanceLiveFeedbackDurabilityCase | undefined
  let staleDurabilityCase: AiAssistanceLiveStaleDurabilityCase | undefined
  let postProviderSourceFenceEvidence = createEmptyPostProviderSourceFenceEvidence()
  let durability = createEmptyDurabilityEvidence()
  let checks: AiAssistanceLiveEvalChecks = {
    commitMatched: false,
    staleRevisionRejected: false,
    postProviderSourceFencePassed: false,
    decisionReplayPassed: false,
    feedbackReplayPassed: false,
    withheldDisclosurePassed: false,
    withheldPermissionChangedPassed: false,
    withheldSourceChangedPassed: false,
    withheldRetentionExpiredPassed: false,
  }

  const commitCheck = await verifyDeployedCommit(parsed, fetchLive)
  checks = { ...checks, commitMatched: commitCheck.passed }
  if (!commitCheck.passed) {
    failures.push(commitCheck.failure)
    return createReport(journeys, checks, durability, failures, parsed.fixture.budgets)
  }
  const dynamoGet = runtime.dynamoGet ?? createDefaultDynamoGet(parsed.awsRegion)

  for (const fixtureCase of parsed.fixture.cases) {
    await pacer.beforeNext()
    const evaluated = await evaluateGenerationCase(
      parsed,
      fixtureCase,
      fetchLive,
      createIdempotencyKey,
    )
    journeys.push(evaluated.result)
    if (evaluated.result.passed && evaluated.generation !== undefined) {
      generations.set(fixtureCase.journey, evaluated.generation)
      if (evaluated.durabilityCase !== undefined) {
        durabilityCases.push(evaluated.durabilityCase)
      }
    }
  }

  const reviewGeneration = generations.get('work-item')
  if (reviewGeneration === undefined) {
    failures.push('decision-failed', 'feedback-failed')
  } else {
    const decisionPassed = await verifyDecisionReplay(
      parsed,
      fetchLive,
      reviewGeneration,
    )
    checks = { ...checks, decisionReplayPassed: decisionPassed }
    if (!decisionPassed) failures.push('decision-replay-mismatch')

    const feedbackResult = await verifyFeedbackReplay(
      parsed,
      fetchLive,
      reviewGeneration,
      createIdempotencyKey,
    )
    checks = { ...checks, feedbackReplayPassed: feedbackResult.passed }
    feedbackDurabilityCase = feedbackResult.durabilityCase
    if (!feedbackResult.passed) failures.push('feedback-replay-failed')
  }

  const withheld = await verifyWithheldDisclosures(parsed, fetchLive)
  checks = { ...checks, ...withheld.checks }
  failures.push(...withheld.failures)

  await pacer.beforeNext()
  const staleRevisionRejected = await verifyStaleRevision(
    parsed,
    fetchLive,
    createIdempotencyKey,
  )
  checks = { ...checks, staleRevisionRejected: staleRevisionRejected.passed }
  staleDurabilityCase = staleRevisionRejected.durabilityCase
  if (!staleRevisionRejected.passed) failures.push(staleRevisionRejected.failure)

  const preDrillTotals = summarizeJourneyProviderUsage(journeys)
  const activeDrillPriorChecksPassed =
    journeys.length === REQUIRED_JOURNEYS.length &&
    journeys.every((journey) => journey.passed) &&
    checks.decisionReplayPassed &&
    checks.feedbackReplayPassed &&
    checks.withheldDisclosurePassed &&
    checks.withheldPermissionChangedPassed &&
    checks.withheldSourceChangedPassed &&
    checks.withheldRetentionExpiredPassed &&
    staleRevisionRejected.passed
  const activeDrillBudgetHeadroomAvailable =
    preDrillTotals.inputTokens +
        parsed.fixture.budgets.maxInputTokensPerGeneration <=
      parsed.fixture.budgets.maxTotalInputTokens &&
    preDrillTotals.outputTokens +
        parsed.fixture.budgets.maxOutputTokensPerGeneration <=
      parsed.fixture.budgets.maxTotalOutputTokens &&
    preDrillTotals.costUsd + parsed.fixture.budgets.maxCostUsdPerGeneration <=
      parsed.fixture.budgets.maxTotalCostUsd
  if (activeDrillPriorChecksPassed && activeDrillBudgetHeadroomAvailable) {
    await pacer.beforeNext()
    postProviderSourceFenceEvidence = await verifyPostProviderSourceFence({
      input: parsed,
      fetchLive,
      dynamoGet,
      now,
      wait,
      createIdempotencyKey,
    })
    checks = {
      ...checks,
      postProviderSourceFencePassed: postProviderSourceFenceEvidence.passed,
    }
    if (postProviderSourceFenceEvidence.failure !== undefined) {
      failures.push(postProviderSourceFenceEvidence.failure)
    }
    if (postProviderSourceFenceEvidence.usage !== undefined) {
      const accountedBudgetFailure = readPostProviderSourceFenceBudgetFailure(
        postProviderSourceFenceEvidence.usage,
        parsed.fixture.budgets,
      )
      if (accountedBudgetFailure !== undefined) failures.push(accountedBudgetFailure)
    }
  } else if (activeDrillPriorChecksPassed) {
    failures.push('post-provider-source-fence-budget-headroom-insufficient')
  }

  if (
    durabilityCases.length === REQUIRED_JOURNEYS.length &&
    feedbackDurabilityCase !== undefined &&
    staleDurabilityCase !== undefined
  ) {
    const durabilityResult = await verifyLiveDurabilityEvidence({
      input: parsed,
      evaluatedAtMs: now(),
      cases: durabilityCases,
      feedback: feedbackDurabilityCase,
      stale: staleDurabilityCase,
      dynamoGet,
    })
    durability = durabilityResult.evidence
    failures.push(...durabilityResult.failures)
  }
  durability = mergePostProviderSourceFenceEvidence(
    durability,
    postProviderSourceFenceEvidence,
  )

  const finalCommitCheck = await verifyDeployedCommit(parsed, fetchLive)
  checks = { ...checks, commitMatched: finalCommitCheck.passed }
  if (!finalCommitCheck.passed) failures.push(finalCommitCheck.failure)

  return createReport(
    journeys,
    checks,
    durability,
    failures,
    parsed.fixture.budgets,
    postProviderSourceFenceEvidence.usage,
  )
}

/** Parses and validates every protected evaluator input without retaining raw failures. */
function parseEvaluationInput(
  input: AiAssistanceLiveEvaluationInput,
  apiBaseUrlAllowlist: readonly string[],
): ParsedAiAssistanceLiveEvaluationInput {
  const apiBaseUrl = parseAllowlistedApiBaseUrl(input.apiBaseUrl, apiBaseUrlAllowlist)
  const accessToken = input.accessToken.trim()
  if (!accessToken || accessToken.length > 16_384 || /\s/.test(accessToken)) {
    throw new TypeError('invalid access token')
  }
  const expectedCommitSha = input.expectedCommitSha.trim().toLowerCase()
  if (!FULL_COMMIT_SHA.test(expectedCommitSha)) {
    throw new TypeError('invalid commit')
  }
  const awsRegion = input.awsRegion.trim()
  const durabilityTableName = input.durabilityTableName.trim()
  if (!AWS_REGION.test(awsRegion) || !DYNAMODB_TABLE_NAME.test(durabilityTableName)) {
    throw new TypeError('invalid durability configuration')
  }
  return {
    apiBaseUrl,
    accessToken,
    expectedCommitSha,
    awsRegion,
    durabilityTableName,
    fixture: parseFixture(input.fixture),
  }
}

/**
 * Requires one configured API base to equal a checked-in or test-injected reviewed entry.
 *
 * @param value - Protected configured API base URL.
 * @param allowlist - Exact reviewed base URLs; production uses only the checked-in constant.
 * @returns Canonical HTTPS base including its exact normalized path.
 */
function parseAllowlistedApiBaseUrl(
  value: string,
  allowlist: readonly string[],
): string {
  if (allowlist.length === 0 || allowlist.length > 16) {
    throw new TypeError('API URL is not approved')
  }
  const approved = allowlist.map(parseApprovedApiBaseUrl)
  if (new Set(approved).size !== approved.length) {
    throw new TypeError('duplicate API URL approval')
  }
  const parsed = parseApprovedApiBaseUrl(value)
  if (!approved.includes(parsed)) throw new TypeError('API URL is not approved')
  return parsed
}

/**
 * Canonicalizes one exact reviewed HTTPS API base without resolving or contacting it.
 *
 * @param value - Checked-in or configured URL candidate.
 * @returns Canonical origin plus normalized exact base path.
 */
function parseApprovedApiBaseUrl(value: string): string {
  if (value.length === 0 || value.length > 2_048 || value.trim() !== value) {
    throw new TypeError('invalid API URL')
  }
  const parsed = new URL(value)
  const hostname = parsed.hostname.toLowerCase()
  const addressHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    value.includes('?') ||
    value.includes('#') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.port !== '' ||
    hostname === '' ||
    hostname.endsWith('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    isIP(addressHostname) !== 0
  ) {
    throw new TypeError('invalid API URL')
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${pathname}`
}

/** Strictly parses the secret production fixture and its six journey contracts. */
function parseFixture(value: unknown): AiAssistanceLiveFixture {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new TypeError('invalid fixture')
  }
  requireExactKeys(value, [
    'schemaVersion',
    'cases',
    'staleRevisionRequest',
    'postProviderSourceFence',
    'withheld',
    'forbiddenSubstrings',
    'expectedModelId',
    'expectedPromptVersion',
    'budgets',
    'durability',
  ])
  const serializedFixture = JSON.stringify(value)
  if (new TextEncoder().encode(serializedFixture).byteLength > MAX_FIXTURE_BYTES) {
    throw new TypeError('fixture too large')
  }
  if (!Array.isArray(value.cases)) throw new TypeError('invalid cases')
  const parsedCases = value.cases.map(parseFixtureCase)
  const cases = REQUIRED_JOURNEYS.map((journey) =>
    requireSingleJourneyCase(parsedCases, journey))
  const staleRevisionRequest = parseGenerateAiAssistanceRequest(
    value.staleRevisionRequest,
  )
  if (!hasRevisionedSource(staleRevisionRequest)) {
    throw new TypeError('invalid stale fixture')
  }
  const forbiddenSubstrings = parseForbiddenSubstrings(value.forbiddenSubstrings)
  const postProviderSourceFence = parsePostProviderSourceFenceFixture(
    value.postProviderSourceFence,
  )
  if (
    cases.some((fixtureCase) => requestUsesWorkItem(
      fixtureCase.request,
      postProviderSourceFence.teamId,
      postProviderSourceFence.workItemId,
    )) ||
    requestUsesWorkItem(
      staleRevisionRequest,
      postProviderSourceFence.teamId,
      postProviderSourceFence.workItemId,
    ) ||
    containsForbiddenContent(postProviderSourceFence.titleA, forbiddenSubstrings) ||
    containsForbiddenContent(postProviderSourceFence.titleB, forbiddenSubstrings)
  ) {
    throw new TypeError('invalid post-provider source fence fixture')
  }
  return {
    cases,
    staleRevisionRequest,
    postProviderSourceFence,
    withheld: parseWithheldFixtures(value.withheld),
    forbiddenSubstrings,
    expectedModelId: readBoundedConfigurationValue(value.expectedModelId, 2_048),
    expectedPromptVersion: readBoundedConfigurationValue(
      value.expectedPromptVersion,
      128,
    ),
    budgets: parseBudgets(value.budgets),
    durability: parseDurabilityFixture(value.durability),
  }
}

/** Parses the exact repeatable Work Item source-fence drill fixture. */
function parsePostProviderSourceFenceFixture(
  value: unknown,
): AiAssistanceLivePostProviderSourceFenceFixture {
  if (!isRecord(value)) throw new TypeError('invalid post-provider source fence fixture')
  requireExactKeys(value, [
    'teamId',
    'workItemId',
    'locale',
    'titleA',
    'titleB',
  ])
  const locale = value.locale
  if (locale !== 'ja' && locale !== 'en') {
    throw new TypeError('invalid post-provider source fence locale')
  }
  const titleA = readBoundedSyntheticTitle(value.titleA)
  const titleB = readBoundedSyntheticTitle(value.titleB)
  if (titleA === titleB) {
    throw new TypeError('post-provider source fence titles must differ')
  }
  return {
    teamId: readBoundedIdentifier(value.teamId),
    workItemId: readBoundedIdentifier(value.workItemId),
    locale,
    titleA,
    titleB,
  }
}

/** Reads one exact bounded synthetic title without silently normalizing it. */
function readBoundedSyntheticTitle(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 160 ||
    value.trim() !== value
  ) {
    throw new TypeError('invalid synthetic Work Item title')
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      throw new TypeError('invalid synthetic Work Item title')
    }
  }
  return value
}

/** Checks whether one request references the dedicated drill-only Work Item. */
function requestUsesWorkItem(
  request: GenerateAiAssistanceRequest,
  teamId: string,
  workItemId: string,
): boolean {
  if (request.task === 'search') return false
  const sources = request.task === 'summary' ? request.sources : [request.source]
  return sources.some((source) =>
    source.type === 'work-item' &&
    source.teamId === teamId &&
    source.workItemId === workItemId)
}

/** Parses exact synthetic identities used exclusively for scoped durability reads. */
function parseDurabilityFixture(value: unknown): AiAssistanceLiveDurabilityFixture {
  if (!isRecord(value)) throw new TypeError('invalid durability fixture')
  requireExactKeys(value, ['workspaceId', 'memberId'])
  return {
    workspaceId: readBoundedIdentifier(value.workspaceId),
    memberId: readBoundedIdentifier(value.memberId),
  }
}

/** Parses one journey fixture and verifies that it exercises the named source domain. */
function parseFixtureCase(value: unknown): AiAssistanceLiveFixtureCase {
  if (!isRecord(value) || !isLiveJourney(value.journey)) {
    throw new TypeError('invalid journey case')
  }
  requireExactKeys(value, ['journey', 'request'])
  const request = parseGenerateAiAssistanceRequest(value.request)
  if (!requestMatchesJourney(value.journey, request)) {
    throw new TypeError('journey request mismatch')
  }
  return { journey: value.journey, request }
}

/** Returns exactly one case for a fixed journey and rejects duplicates or omissions. */
function requireSingleJourneyCase(
  cases: readonly AiAssistanceLiveFixtureCase[],
  journey: AiAssistanceLiveJourney,
): AiAssistanceLiveFixtureCase {
  const matches = cases.filter((candidate) => candidate.journey === journey)
  const match = matches[0]
  if (matches.length !== 1 || match === undefined) {
    throw new TypeError('journey coverage mismatch')
  }
  return match
}

/** Checks whether an unknown value is one fixed content-free journey label. */
function isLiveJourney(value: unknown): value is AiAssistanceLiveJourney {
  return typeof value === 'string' && REQUIRED_JOURNEYS.some(
    (journey) => journey === value,
  )
}

/** Ensures each fixed journey resolves the intended production source boundary. */
function requestMatchesJourney(
  journey: AiAssistanceLiveJourney,
  request: GenerateAiAssistanceRequest,
): boolean {
  switch (journey) {
    case 'request':
      return request.task === 'triage' && request.source.type === 'request-submission'
    case 'triage':
      return request.task === 'triage' && request.source.type === 'triage-entry'
    case 'work-item':
      return request.task === 'summary' && request.sources.length === 1 &&
        request.sources[0]?.type === 'work-item'
    case 'planning':
      return request.task === 'planning' && request.source.type === 'planning-target'
    case 'document':
      return request.task === 'summary' && request.sources.length === 1 &&
        request.sources[0]?.type === 'document'
    case 'search':
      return request.task === 'search'
  }
}

/** Checks whether a request contains a positive optimistic source revision. */
function hasRevisionedSource(request: GenerateAiAssistanceRequest): boolean {
  if (request.task === 'search') return false
  const sources = request.task === 'summary' ? request.sources : [request.source]
  return sources.length > 0 && sources.every(
    (source) => Number.isSafeInteger(source.expectedRevision) && source.expectedRevision > 0,
  )
}

/** Parses seeded secret canaries without allowing a vacuous redaction check. */
function parseForbiddenSubstrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError('invalid redaction canaries')
  }
  const parsed: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') throw new TypeError('invalid redaction canary')
    const normalized = candidate.trim()
    if (normalized.length < 8 || normalized.length > 256 || parsed.includes(normalized)) {
      throw new TypeError('invalid redaction canary')
    }
    parsed.push(normalized)
  }
  return parsed
}

/** Parses all three required withheld-generation fixtures in a stable reason order. */
function parseWithheldFixtures(value: unknown): AiAssistanceLiveWithheldFixture[] {
  if (!Array.isArray(value)) throw new TypeError('invalid withheld fixtures')
  const fixtures = value.map(parseWithheldFixture)
  return REQUIRED_WITHHELD_REASONS.map((reasonCode) => {
    const matches = fixtures.filter((fixture) => fixture.reasonCode === reasonCode)
    const match = matches[0]
    if (matches.length !== 1 || match === undefined) {
      throw new TypeError('withheld coverage mismatch')
    }
    return match
  })
}

/** Parses one pre-arranged withheld-generation fixture. */
function parseWithheldFixture(value: unknown): AiAssistanceLiveWithheldFixture {
  if (!isRecord(value)) throw new TypeError('invalid withheld fixture')
  requireExactKeys(value, ['generationId', 'reasonCode'])
  const generationId = readBoundedIdentifier(value.generationId)
  const reasonCode = value.reasonCode
  if (
    reasonCode !== 'permission-changed' &&
    reasonCode !== 'retention-expired' &&
    reasonCode !== 'source-changed'
  ) {
    throw new TypeError('invalid withheld reason')
  }
  return { generationId, reasonCode }
}

/** Parses explicit provider budgets and requires aggregate limits to cover one case. */
function parseBudgets(value: unknown): AiAssistanceLiveBudgets {
  if (!isRecord(value)) throw new TypeError('invalid budgets')
  requireExactKeys(value, [
    'maxLatencyMsPerGeneration',
    'maxInputTokensPerGeneration',
    'maxOutputTokensPerGeneration',
    'maxCostUsdPerGeneration',
    'maxTotalInputTokens',
    'maxTotalOutputTokens',
    'maxTotalCostUsd',
  ])
  const budgets: AiAssistanceLiveBudgets = {
    maxLatencyMsPerGeneration: readPositiveNumber(
      value.maxLatencyMsPerGeneration,
      30_000,
    ),
    maxInputTokensPerGeneration: readPositiveInteger(
      value.maxInputTokensPerGeneration,
      1_000_000,
    ),
    maxOutputTokensPerGeneration: readPositiveInteger(
      value.maxOutputTokensPerGeneration,
      1_000_000,
    ),
    maxCostUsdPerGeneration: readPositiveNumber(value.maxCostUsdPerGeneration, 100),
    maxTotalInputTokens: readPositiveInteger(value.maxTotalInputTokens, 6_000_000),
    maxTotalOutputTokens: readPositiveInteger(value.maxTotalOutputTokens, 6_000_000),
    maxTotalCostUsd: readPositiveNumber(value.maxTotalCostUsd, 600),
  }
  if (
    budgets.maxTotalInputTokens < budgets.maxInputTokensPerGeneration ||
    budgets.maxTotalOutputTokens < budgets.maxOutputTokensPerGeneration ||
    budgets.maxTotalCostUsd < budgets.maxCostUsdPerGeneration
  ) {
    throw new TypeError('invalid aggregate budgets')
  }
  return budgets
}

/** Reads one finite positive number under an absolute operational ceiling. */
function readPositiveNumber(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new TypeError('invalid positive number')
  }
  return value
}

/** Reads one positive safe integer under an absolute operational ceiling. */
function readPositiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0 || value > maximum) {
    throw new TypeError('invalid positive integer')
  }
  return value
}

/** Rejects unknown or missing object properties at a protected fixture boundary. */
function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeys.includes(key))
  ) throw new TypeError('invalid fixture properties')
}

/** Reads one bounded opaque identifier solely for an in-memory request path. */
function readBoundedIdentifier(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('invalid identifier')
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new TypeError('invalid identifier')
  return normalized
}

/** Reads one in-memory deployment expectation without allowing control characters. */
function readBoundedConfigurationValue(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError('invalid configuration value')
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > maximumLength ||
    containsAsciiControlCharacter(normalized)
  ) {
    throw new TypeError('invalid configuration value')
  }
  return normalized
}

/** Checks for ASCII control bytes forbidden in deployment expectation values. */
function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
}

/** Verifies liveness and the full commit SHA before sending any bearer-authenticated request. */
async function verifyDeployedCommit(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fetchLive: AiAssistanceLiveFetch,
): Promise<{
  /** Whether the deployed API is the exact evaluated commit. */
  passed: boolean
  /** Stable failure when the probe did not pass. */
  failure: 'commit-probe-failed' | 'deployed-commit-mismatch'
}> {
  return await verifyDeployedCommitValues(
    input.apiBaseUrl,
    input.expectedCommitSha,
    fetchLive,
  )
}

/** Verifies one HTTPS API liveness document against an expected full commit SHA. */
async function verifyDeployedCommitValues(
  apiBaseUrl: string,
  expectedCommitSha: string,
  fetchLive: AiAssistanceLiveFetch,
): Promise<{
  /** Whether the deployed API is the exact evaluated commit. */
  passed: boolean
  /** Stable failure when the probe did not pass. */
  failure: 'commit-probe-failed' | 'deployed-commit-mismatch'
}> {
  try {
    const response = await requestJson(
      apiBaseUrl,
      '/api/health',
      { method: 'GET' },
      fetchLive,
      10_000,
    )
    if (
      response.status !== 200 ||
      !isRecord(response.body) ||
      response.body.ok !== true ||
      response.body.status !== 'alive' ||
      typeof response.body.applicationCommitSha !== 'string'
    ) {
      return { passed: false, failure: 'commit-probe-failed' }
    }
    const deployedCommitSha = response.body.applicationCommitSha.trim().toLowerCase()
    return deployedCommitSha === expectedCommitSha && FULL_COMMIT_SHA.test(deployedCommitSha)
      ? { passed: true, failure: 'commit-probe-failed' }
      : { passed: false, failure: 'deployed-commit-mismatch' }
  } catch {
    return { passed: false, failure: 'commit-probe-failed' }
  }
}

/** Evaluates one real-model journey and its identical-key replay. */
async function evaluateGenerationCase(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fixtureCase: AiAssistanceLiveFixtureCase,
  fetchLive: AiAssistanceLiveFetch,
  createIdempotencyKey: () => string,
): Promise<EvaluatedLiveGeneration> {
  const failures: AiAssistanceLiveEvalFailureCode[] = []
  const idempotencyKey = readBoundedIdentifier(createIdempotencyKey())
  let first: LiveJsonResponse | undefined
  let replay: LiveJsonResponse
  try {
    if (fixtureCase.journey === 'work-item') {
      const discarded = await requestAndDiscardBody(
        input.apiBaseUrl,
        '/api/ai-assistance/generations',
        createJsonRequest(input.accessToken, fixtureCase.request, idempotencyKey),
        fetchLive,
        generationHttpTimeout(input.fixture.budgets),
      )
      if (discarded.status !== 201) failures.push('generation-http-failed')
      if (discarded.replayed) failures.push('replay-evidence-missing')
    } else {
      first = await requestJson(
        input.apiBaseUrl,
        '/api/ai-assistance/generations',
        createJsonRequest(input.accessToken, fixtureCase.request, idempotencyKey),
        fetchLive,
        generationHttpTimeout(input.fixture.budgets),
      )
      if (first.status !== 201) failures.push('generation-http-failed')
    }
    replay = await requestJson(
      input.apiBaseUrl,
      '/api/ai-assistance/generations',
      createJsonRequest(input.accessToken, fixtureCase.request, idempotencyKey),
      fetchLive,
      generationHttpTimeout(input.fixture.budgets),
    )
    if (replay.status !== 201) failures.push('generation-http-failed')
    if (
      (first !== undefined && hasReplayEvidence(first)) ||
      !hasReplayEvidence(replay)
    ) {
      failures.push('replay-evidence-missing')
    }
  } catch (error) {
    failures.push(classifyTransportFailure(error))
    return createFailedJourney(fixtureCase.journey, failures)
  }

  if (
    (first !== undefined && containsForbiddenResponseContent(first.text, input)) ||
    containsForbiddenResponseContent(replay.text, input)
  ) failures.push('redaction-failed')

  let generation: AiAssistanceGeneration
  let replayGeneration: AiAssistanceGeneration
  try {
    replayGeneration = parseAiAssistanceGeneration(replay.body)
    generation = first === undefined
      ? replayGeneration
      : parseAiAssistanceGeneration(first.body)
  } catch {
    failures.push('generation-schema-invalid')
    return createFailedJourney(fixtureCase.journey, failures)
  }

  const replayMatched = hasReplayEvidence(replay) &&
    (first === undefined || !hasReplayEvidence(first)) &&
    (fixtureCase.journey === 'work-item' ||
      isDeepStrictEqual(generation, replayGeneration))
  if (!replayMatched) {
    failures.push('idempotent-replay-mismatch')
  }
  if (
    generation.task !== fixtureCase.request.task ||
    !draftMatchesTask(generation.content, fixtureCase.request.task)
  ) failures.push('journey-task-mismatch')
  if (generation.content.availability !== 'available') {
    failures.push('generation-withheld')
    return createFailedJourney(fixtureCase.journey, failures, generation)
  }

  const expectedSourceType = expectedCitationSourceType(fixtureCase.journey)
  const citationIds = new Set(generation.content.citations.map((citation) => citation.id))
  const claimCitationIds = collectDraftCitationIds(generation.content.draft)
  const minimumCitations = fixtureCase.journey === 'search' ? 0 : 1
  if (
    generation.content.citations.length < minimumCitations ||
    claimCitationIds.length < minimumCitations
  ) failures.push('evidence-missing')
  if (
    claimCitationIds.some((citationId) => !citationIds.has(citationId)) ||
    generation.content.citations.some(
      (citation) => expectedSourceType !== undefined &&
        citation.sourceType !== expectedSourceType,
    )
  ) failures.push('citation-invalid')
  const uncertaintyPresent = generation.content.uncertainty.reason.trim().length > 0
  if (!uncertaintyPresent) failures.push('uncertainty-missing')

  const usage = generation.details.usage
  const inputTokens = usage.inputTokens
  const outputTokens = usage.outputTokens
  const costUsd = usage.costUsd
  if (
    generation.details.provider !== 'bedrock' ||
    generation.details.modelId !== input.fixture.expectedModelId ||
    generation.details.promptVersion !== input.fixture.expectedPromptVersion
  ) failures.push('provider-configuration-mismatch')
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens === undefined ||
    inputTokens <= 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens === undefined ||
    outputTokens <= 0 ||
    typeof costUsd !== 'number' ||
    !Number.isFinite(costUsd) ||
    costUsd <= 0 ||
    !Number.isFinite(usage.latencyMs) ||
    usage.latencyMs <= 0
  ) {
    failures.push('usage-missing')
    return createFailedJourney(fixtureCase.journey, failures, generation)
  }

  const budgets = input.fixture.budgets
  if (usage.latencyMs > budgets.maxLatencyMsPerGeneration) {
    failures.push('latency-budget-exceeded')
  }
  if (inputTokens > budgets.maxInputTokensPerGeneration) {
    failures.push('input-token-budget-exceeded')
  }
  if (outputTokens > budgets.maxOutputTokensPerGeneration) {
    failures.push('output-token-budget-exceeded')
  }
  if (costUsd > budgets.maxCostUsdPerGeneration) {
    failures.push('cost-budget-exceeded')
  }

  return {
    generation,
    durabilityCase: {
      journey: fixtureCase.journey,
      request: fixtureCase.request,
      idempotencyKey,
      generation,
    },
    result: {
      journey: fixtureCase.journey,
      passed: failures.length === 0,
      failures: uniqueFailures(failures),
      metrics: {
        inputTokens,
        outputTokens,
        latencyMs: usage.latencyMs,
        costUsd,
        citationCount: generation.content.citations.length,
        uncertaintyPresent,
        replayMatched,
      },
    },
  }
}

/** Creates a failed journey result without adding any raw response evidence. */
function createFailedJourney(
  journey: AiAssistanceLiveJourney,
  failures: readonly AiAssistanceLiveEvalFailureCode[],
  generation?: AiAssistanceGeneration,
): EvaluatedLiveGeneration {
  return {
    ...(generation === undefined ? {} : { generation }),
    result: {
      journey,
      passed: false,
      failures: uniqueFailures(failures),
    },
  }
}

/** Verifies an approval and identical stale-revision replay without applying a domain mutation. */
async function verifyDecisionReplay(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fetchLive: AiAssistanceLiveFetch,
  generation: AiAssistanceGeneration,
): Promise<boolean> {
  const path = `/api/ai-assistance/generations/${encodeURIComponent(generation.id)}/decision`
  const body = { outcome: 'approved', expectedRevision: generation.revision }
  try {
    const discarded = await requestAndDiscardBody(
      input.apiBaseUrl,
      path,
      createJsonRequest(input.accessToken, body),
      fetchLive,
      15_000,
    )
    const replay = await requestJson(
      input.apiBaseUrl,
      path,
      createJsonRequest(input.accessToken, body),
      fetchLive,
      15_000,
    )
    const confirmation = await requestJson(
      input.apiBaseUrl,
      path,
      createJsonRequest(input.accessToken, body),
      fetchLive,
      15_000,
    )
    if (discarded.status !== 200 || replay.status !== 200 || confirmation.status !== 200) {
      return false
    }
    if (
      containsForbiddenResponseContent(replay.text, input) ||
      containsForbiddenResponseContent(confirmation.text, input)
    ) return false
    const replayGeneration = parseAiAssistanceGeneration(replay.body)
    const confirmedGeneration = parseAiAssistanceGeneration(confirmation.body)
    return approvedDecisionPreservesGeneration(generation, replayGeneration) &&
      isDeepStrictEqual(replayGeneration, confirmedGeneration)
  } catch {
    return false
  }
}

/** Checks that approval changed only the review decision and optimistic revision. */
function approvedDecisionPreservesGeneration(
  original: AiAssistanceGeneration,
  approved: AiAssistanceGeneration,
): boolean {
  return original.decision === undefined &&
    approved.decision?.outcome === 'approved' &&
    approved.schemaVersion === original.schemaVersion &&
    approved.id === original.id &&
    approved.task === original.task &&
    approved.revision === original.revision + 1 &&
    isDeepStrictEqual(approved.content, original.content) &&
    isDeepStrictEqual(approved.details, original.details) &&
    approved.createdAt === original.createdAt &&
    approved.expiresAt === original.expiresAt
}

/** Verifies feedback response-loss retry semantics with one opaque key and no response body. */
async function verifyFeedbackReplay(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fetchLive: AiAssistanceLiveFetch,
  generation: AiAssistanceGeneration,
  createIdempotencyKey: () => string,
): Promise<{
  /** Whether HTTP response-loss replay semantics passed. */
  passed: boolean
  /** Opaque feedback identity retained only for the durability read. */
  durabilityCase: AiAssistanceLiveFeedbackDurabilityCase
}> {
  const path = `/api/ai-assistance/generations/${encodeURIComponent(generation.id)}/feedback`
  const key = readBoundedIdentifier(createIdempotencyKey())
  const feedback = parseCreateAiAssistanceFeedbackRequest({ rating: 'helpful' })
  const request = createJsonRequest(
    input.accessToken,
    feedback,
    key,
  )
  const durabilityCase = {
    generationId: generation.id,
    generationExpiresAt: generation.expiresAt,
    feedback,
    idempotencyKey: key,
  }
  try {
    const first = await requestAndDiscardBody(
      input.apiBaseUrl,
      path,
      request,
      fetchLive,
      15_000,
    )
    const replay = await requestText(input.apiBaseUrl, path, request, fetchLive, 15_000)
    return {
      passed: first.status === 204 && !first.replayed &&
        replay.status === 204 && replay.text === '' &&
        hasReplayEvidence(replay),
      durabilityCase,
    }
  } catch {
    return { passed: false, durabilityCase }
  }
}

/** Verifies all fixed withheld reasons and returns individual content-free checks. */
async function verifyWithheldDisclosures(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fetchLive: AiAssistanceLiveFetch,
): Promise<{
  /** Aggregate and reason-specific fixed booleans for the release report. */
  checks: Pick<
    AiAssistanceLiveEvalChecks,
    | 'withheldDisclosurePassed'
    | 'withheldPermissionChangedPassed'
    | 'withheldSourceChangedPassed'
    | 'withheldRetentionExpiredPassed'
  >
  /** Stable content-free failures observed while checking all three cases. */
  failures: AiAssistanceLiveEvalFailureCode[]
}> {
  let withheldPermissionChangedPassed = false
  let withheldSourceChangedPassed = false
  let withheldRetentionExpiredPassed = false
  const failures: AiAssistanceLiveEvalFailureCode[] = []
  for (const fixture of input.fixture.withheld) {
    const result = await verifyWithheldDisclosure(input, fixture, fetchLive)
    if (!result.passed) failures.push(result.failure)
    switch (fixture.reasonCode) {
      case 'permission-changed':
        withheldPermissionChangedPassed = result.passed
        break
      case 'source-changed':
        withheldSourceChangedPassed = result.passed
        break
      case 'retention-expired':
        withheldRetentionExpiredPassed = result.passed
        break
    }
  }
  return {
    checks: {
      withheldDisclosurePassed: withheldPermissionChangedPassed &&
        withheldSourceChangedPassed && withheldRetentionExpiredPassed,
      withheldPermissionChangedPassed,
      withheldSourceChangedPassed,
      withheldRetentionExpiredPassed,
    },
    failures,
  }
}

/** Verifies that one pre-arranged generation returns only its exact withheld reason. */
async function verifyWithheldDisclosure(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fixture: AiAssistanceLiveWithheldFixture,
  fetchLive: AiAssistanceLiveFetch,
): Promise<{
  /** Whether the response contained only the expected withheld contract. */
  passed: boolean
  /** Stable failure when disclosure was not withheld correctly. */
  failure: 'withheld-disclosure-failed' | 'withheld-reason-mismatch'
}> {
  const path = `/api/ai-assistance/generations/${encodeURIComponent(
    fixture.generationId,
  )}`
  try {
    const response = await requestJson(
      input.apiBaseUrl,
      path,
      createAuthenticatedRequest(input.accessToken, 'GET'),
      fetchLive,
      15_000,
    )
    if (
      response.status !== 200 ||
      containsForbiddenResponseContent(response.text, input)
    ) return { passed: false, failure: 'withheld-disclosure-failed' }
    const generation = parseAiAssistanceGeneration(response.body)
    if (
      generation.id !== fixture.generationId ||
      generation.content.availability !== 'withheld'
    ) {
      return { passed: false, failure: 'withheld-disclosure-failed' }
    }
    return generation.content.reasonCode === fixture.reasonCode
      ? { passed: true, failure: 'withheld-disclosure-failed' }
      : { passed: false, failure: 'withheld-reason-mismatch' }
  } catch {
    return { passed: false, failure: 'withheld-disclosure-failed' }
  }
}

/** Verifies that a known stale source revision fails before producing a generation. */
async function verifyStaleRevision(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fetchLive: AiAssistanceLiveFetch,
  createIdempotencyKey: () => string,
): Promise<{
  /** Whether the stable stale-source failure was observed. */
  passed: boolean
  /** Stable failure when stale input was accepted or misclassified. */
  failure: 'stale-revision-accepted' | 'stale-revision-error-mismatch'
  /** Opaque stale receipt identity retained only for the durability read. */
  durabilityCase: AiAssistanceLiveStaleDurabilityCase
}> {
  const key = readBoundedIdentifier(createIdempotencyKey())
  const durabilityCase = {
    request: input.fixture.staleRevisionRequest,
    idempotencyKey: key,
  }
  try {
    const request = createJsonRequest(
      input.accessToken,
      input.fixture.staleRevisionRequest,
      key,
    )
    const response = await requestJson(
      input.apiBaseUrl,
      '/api/ai-assistance/generations',
      request,
      fetchLive,
      generationHttpTimeout(input.fixture.budgets),
    )
    const replay = await requestJson(
      input.apiBaseUrl,
      '/api/ai-assistance/generations',
      request,
      fetchLive,
      generationHttpTimeout(input.fixture.budgets),
    )
    if (
      containsForbiddenResponseContent(response.text, input) ||
      containsForbiddenResponseContent(replay.text, input)
    ) return { passed: false, failure: 'stale-revision-error-mismatch', durabilityCase }
    if (response.status === 201 || replay.status === 201) {
      return { passed: false, failure: 'stale-revision-accepted', durabilityCase }
    }
    const code = isRecord(response.body) ? response.body.code : undefined
    const replayCode = isRecord(replay.body) ? replay.body.code : undefined
    return response.status === 409 && replay.status === 409 &&
        code === 'AiAssistanceSourceChanged' &&
        replayCode === 'AiAssistanceSourceChanged' &&
        !hasReplayEvidence(response) &&
        hasReplayEvidence(replay)
      ? { passed: true, failure: 'stale-revision-accepted', durabilityCase }
      : { passed: false, failure: 'stale-revision-error-mismatch', durabilityCase }
  } catch {
    return { passed: false, failure: 'stale-revision-error-mismatch', durabilityCase }
  }
}

/**
 * Mutates a dedicated Work Item after the durable provider-start marker is visible.
 *
 * @param verification - Strict evaluator, HTTP, clock, polling, and DynamoDB boundaries.
 * @returns Content-free proof that the successful provider result was discarded and replayed.
 */
async function verifyPostProviderSourceFence(
  verification: VerifyPostProviderSourceFenceInput,
): Promise<AiAssistanceLivePostProviderSourceFenceEvidence> {
  const emptyEvidence = createEmptyPostProviderSourceFenceEvidence()
  const fixture = verification.input.fixture.postProviderSourceFence
  const path = createWorkItemPath(fixture.teamId, fixture.workItemId)
  let snapshot: PostProviderSourceFenceWorkItemSnapshot
  try {
    const response = await requestJson(
      verification.input.apiBaseUrl,
      path,
      createAuthenticatedRequest(verification.input.accessToken, 'GET'),
      verification.fetchLive,
      15_000,
    )
    if (
      response.status !== 200 ||
      hasReplayEvidence(response) ||
      containsForbiddenResponseContent(response.text, verification.input)
    ) {
      return {
        ...emptyEvidence,
        failure: 'post-provider-source-fence-setup-failed',
      }
    }
    const parsedSnapshot = parsePostProviderSourceFenceWorkItemSnapshot(
      response.body,
      fixture,
    )
    if (parsedSnapshot === undefined) {
      return {
        ...emptyEvidence,
        failure: 'post-provider-source-fence-setup-failed',
      }
    }
    snapshot = parsedSnapshot
  } catch {
    return {
      ...emptyEvidence,
      failure: 'post-provider-source-fence-setup-failed',
    }
  }

  const nextTitle = snapshot.title === fixture.titleA
    ? fixture.titleB
    : fixture.titleA
  const request = parseGenerateAiAssistanceRequest({
    task: 'summary',
    locale: fixture.locale,
    sources: [{
      type: 'work-item',
      teamId: fixture.teamId,
      workItemId: fixture.workItemId,
      expectedRevision: snapshot.revision,
    }],
  })
  let generationIdempotencyKey: string
  try {
    generationIdempotencyKey = readBoundedIdentifier(
      verification.createIdempotencyKey(),
    )
  } catch {
    return {
      ...emptyEvidence,
      failure: 'post-provider-source-fence-setup-failed',
    }
  }
  const generationRequest = createJsonRequest(
    verification.input.accessToken,
    request,
    generationIdempotencyKey,
  )
  const generationAbortController = new AbortController()
  const generationResponsePromise = settleLiveJsonRequest(requestJson(
    verification.input.apiBaseUrl,
    '/api/ai-assistance/generations',
    generationRequest,
    verification.fetchLive,
    generationHttpTimeout(verification.input.fixture.budgets),
    generationAbortController.signal,
  ))
  const reconcileFailure = async (
    failure: AiAssistanceLiveEvalFailureCode,
  ): Promise<AiAssistanceLivePostProviderSourceFenceEvidence> =>
    await reconcilePostProviderSourceFenceFailure({
      verification,
      request,
      idempotencyKey: generationIdempotencyKey,
      generationRequest,
      originalController: generationAbortController,
      originalSettlement: generationResponsePromise,
      failure,
    })

  let startedAttempt: PostProviderSourceFenceStartedAttempt | undefined
  try {
    startedAttempt = await pollForPostProviderSourceFenceStartedAttempt({
      input: verification.input,
      request,
      idempotencyKey: generationIdempotencyKey,
      dynamoGet: verification.dynamoGet,
      now: verification.now,
      wait: verification.wait,
    })
  } catch {
    return await reconcileFailure('post-provider-source-fence-durability-mismatch')
  }
  if (startedAttempt === undefined) {
    return await reconcileFailure('post-provider-source-fence-attempt-timeout')
  }

  let mutationIdempotencyKey: string
  try {
    mutationIdempotencyKey = readBoundedIdentifier(
      verification.createIdempotencyKey(),
    )
    const mutationPassed = await commitPostProviderSourceFenceMutation(
      verification.input,
      verification.fetchLive,
      path,
      mutationIdempotencyKey,
      snapshot.revision,
      nextTitle,
    )
    if (!mutationPassed) {
      return await reconcileFailure('post-provider-source-fence-mutation-failed')
    }
  } catch {
    return await reconcileFailure('post-provider-source-fence-mutation-failed')
  }

  const generationSettlement = await generationResponsePromise
  const firstFailureCode = generationSettlement.response === undefined
    ? undefined
    : readPostProviderSourceFenceFailureCode(
        generationSettlement.response,
        verification.input,
        false,
      )
  if (!generationSettlement.fulfilled || firstFailureCode === undefined) {
    return await reconcileFailure('post-provider-source-fence-error-mismatch')
  }

  let beforeReplay: PostProviderSourceFenceTerminalSnapshot
  try {
    const snapshotBeforeReplay = await readPostProviderSourceFenceTerminalSnapshot(
      verification,
      startedAttempt,
      request,
      firstFailureCode,
    )
    if (snapshotBeforeReplay === undefined) {
      return await reconcileFailure('post-provider-source-fence-durability-mismatch')
    }
    beforeReplay = snapshotBeforeReplay
  } catch {
    return await reconcileFailure('post-provider-source-fence-durability-mismatch')
  }

  try {
    const replay = await requestJson(
      verification.input.apiBaseUrl,
      '/api/ai-assistance/generations',
      generationRequest,
      verification.fetchLive,
      generationHttpTimeout(verification.input.fixture.budgets),
    )
    const replayFailureCode = readPostProviderSourceFenceFailureCode(
      replay,
      verification.input,
      true,
    )
    if (replayFailureCode !== firstFailureCode) {
      return {
        ...emptyEvidence,
        failedReceiptCount: 1,
        failedAttemptCount: 1,
        auditEnvelopeCount: 1,
        generationAbsent: true,
        usage: beforeReplay.usage,
        failure: 'post-provider-source-fence-replay-mismatch',
      }
    }
  } catch {
    return {
      ...emptyEvidence,
      failedReceiptCount: 1,
      failedAttemptCount: 1,
      auditEnvelopeCount: 1,
      generationAbsent: true,
      usage: beforeReplay.usage,
      failure: 'post-provider-source-fence-replay-mismatch',
    }
  }

  try {
    const afterReplay = await readPostProviderSourceFenceTerminalSnapshot(
      verification,
      startedAttempt,
      request,
      firstFailureCode,
    )
    if (
      afterReplay === undefined ||
      !isDeepStrictEqual(afterReplay.receipt, beforeReplay.receipt) ||
      !isDeepStrictEqual(afterReplay.usage, beforeReplay.usage)
    ) {
      return {
        ...emptyEvidence,
        usage: beforeReplay.usage,
        failure: 'post-provider-source-fence-durability-mismatch',
      }
    }
    const budgetFailure = readPostProviderSourceFenceBudgetFailure(
      afterReplay.usage,
      verification.input.fixture.budgets,
    )
    if (budgetFailure !== undefined) {
      return {
        passed: false,
        failedReceiptCount: 1,
        failedAttemptCount: 1,
        auditEnvelopeCount: 1,
        generationAbsent: true,
        usage: afterReplay.usage,
        failure: budgetFailure,
      }
    }
    return {
      passed: true,
      failedReceiptCount: 1,
      failedAttemptCount: 1,
      auditEnvelopeCount: 1,
      generationAbsent: true,
      usage: afterReplay.usage,
    }
  } catch {
    return {
      ...emptyEvidence,
      usage: beforeReplay.usage,
      failure: 'post-provider-source-fence-durability-mismatch',
    }
  }
}

/**
 * Reconciles the server-side outcome after a launched drill request fails locally.
 *
 * @param reconciliation - Exact request identity and bounded runtime boundaries.
 * @returns Content-free failure evidence with every trustworthy paid usage accounted.
 */
async function reconcilePostProviderSourceFenceFailure(
  reconciliation: ReconcilePostProviderSourceFenceFailureInput,
): Promise<AiAssistanceLivePostProviderSourceFenceEvidence> {
  await abortLocalLiveJsonRequest(
    reconciliation.originalController,
    reconciliation.originalSettlement,
  )

  let replayController: AbortController | undefined
  let replaySettlement: Promise<LiveJsonRequestSettlement> | undefined
  try {
    for (
      let index = 0;
      index < POST_PROVIDER_RECONCILIATION_POLL_LIMIT;
      index += 1
    ) {
      let probe: PostProviderSourceFenceReconciliationProbe
      try {
        probe = await probePostProviderSourceFenceReconciliation(
          reconciliation.verification,
          reconciliation.request,
          reconciliation.idempotencyKey,
        )
      } catch {
        return createPostProviderSourceFenceReconciledFailure(
          reconciliation.failure,
          { accounted: false, generationAbsent: false },
        )
      }
      if (probe.state !== 'pending') {
        return createPostProviderSourceFenceReconciledFailure(
          reconciliation.failure,
          {
            accounted: probe.state === 'accounted',
            generationAbsent: probe.generationAbsent,
            ...(probe.usage === undefined ? {} : { usage: probe.usage }),
          },
        )
      }
      if (replaySettlement === undefined) {
        replayController = new AbortController()
        replaySettlement = settleLiveJsonRequest(requestJson(
          reconciliation.verification.input.apiBaseUrl,
          '/api/ai-assistance/generations',
          reconciliation.generationRequest,
          reconciliation.verification.fetchLive,
          generationHttpTimeout(reconciliation.verification.input.fixture.budgets),
          replayController.signal,
        ))
      }
      if (index + 1 < POST_PROVIDER_RECONCILIATION_POLL_LIMIT) {
        await reconciliation.verification.wait(
          POST_PROVIDER_RECEIPT_POLL_INTERVAL_MS,
        )
      }
    }
    return createPostProviderSourceFenceReconciledFailure(
      reconciliation.failure,
      { accounted: false, generationAbsent: false },
    )
  } finally {
    if (replayController !== undefined && replaySettlement !== undefined) {
      await abortLocalLiveJsonRequest(replayController, replaySettlement)
    }
  }
}

/**
 * Maps terminal reconciliation into the fixed active-drill evidence shape.
 *
 * @param failure - Primary invariant failure retained only after complete accounting.
 * @param reconciliation - Content-free terminal accounting result.
 * @returns Fixed drill evidence with a stable unreconciled fallback.
 */
function createPostProviderSourceFenceReconciledFailure(
  failure: AiAssistanceLiveEvalFailureCode,
  reconciliation: PostProviderSourceFenceReconciliation,
): AiAssistanceLivePostProviderSourceFenceEvidence {
  return {
    ...createEmptyPostProviderSourceFenceEvidence(),
    generationAbsent: reconciliation.generationAbsent,
    ...(reconciliation.usage === undefined
      ? {}
      : { usage: reconciliation.usage }),
    failure: reconciliation.accounted
      ? failure
      : 'post-provider-source-fence-unreconciled',
  }
}

/** Converts a bounded JSON request into content-free fulfilled/rejected evidence. */
async function settleLiveJsonRequest(
  request: Promise<LiveJsonResponse>,
): Promise<LiveJsonRequestSettlement> {
  try {
    return { fulfilled: true, response: await request }
  } catch {
    return { fulfilled: false }
  }
}

/** Aborts only the local HTTP wait and boundedly settles its already-caught promise. */
async function abortLocalLiveJsonRequest(
  controller: AbortController,
  settlement: Promise<LiveJsonRequestSettlement>,
): Promise<void> {
  controller.abort()
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, POST_PROVIDER_ABORT_SETTLE_TIMEOUT_MS)
    void settlement.then(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

/** Builds the canonical detail and mutation path for one drill-only Work Item. */
function createWorkItemPath(teamId: string, workItemId: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(workItemId)}`
}

/** Strictly reads only the current revision and alternating synthetic title. */
function parsePostProviderSourceFenceWorkItemSnapshot(
  value: unknown,
  fixture: AiAssistanceLivePostProviderSourceFenceFixture,
): PostProviderSourceFenceWorkItemSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.issue)) return undefined
  const issue = value.issue
  if (
    issue.id !== fixture.workItemId ||
    issue.teamId !== fixture.teamId ||
    !isNonNegativeSafeInteger(issue.revision) ||
    issue.revision < 1 ||
    (issue.title !== fixture.titleA && issue.title !== fixture.titleB)
  ) return undefined
  return { revision: issue.revision, title: issue.title }
}

/** Builds the exact revision-fenced, idempotent canonical Work Item title mutation. */
function createWorkItemPatchRequest(
  accessToken: string,
  idempotencyKey: string,
  expectedRevision: number,
  title: string,
): RequestInit {
  return {
    method: 'PATCH',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': idempotencyKey,
    },
    body: JSON.stringify({ expectedRevision, title }),
  }
}

/**
 * Commits the canonical title flip and retries only the same idempotent mutation after loss.
 *
 * @param input - Strict protected evaluator input.
 * @param fetchLive - Authenticated production-like HTTP boundary.
 * @param path - Canonical encoded Work Item path.
 * @param idempotencyKey - Opaque mutation and correlation identity.
 * @param expectedRevision - Strongly read Work Item revision.
 * @param nextTitle - Opposite exact synthetic title.
 * @returns Whether either the first response or its exact replay proved the mutation.
 */
async function commitPostProviderSourceFenceMutation(
  input: ParsedAiAssistanceLiveEvaluationInput,
  fetchLive: AiAssistanceLiveFetch,
  path: string,
  idempotencyKey: string,
  expectedRevision: number,
  nextTitle: string,
): Promise<boolean> {
  const request = createWorkItemPatchRequest(
    input.accessToken,
    idempotencyKey,
    expectedRevision,
    nextTitle,
  )
  const first = await settleLiveJsonRequest(requestJson(
    input.apiBaseUrl,
    path,
    request,
    fetchLive,
    15_000,
  ))
  if (first.fulfilled && first.response !== undefined) {
    return first.response.status === 200 &&
      !hasReplayEvidence(first.response) &&
      !containsForbiddenResponseContent(first.response.text, input) &&
      isExpectedPostProviderSourceFenceMutation(
        first.response.body,
        input.fixture.postProviderSourceFence,
        expectedRevision + 1,
        nextTitle,
      )
  }
  const recovery = await settleLiveJsonRequest(requestJson(
    input.apiBaseUrl,
    path,
    request,
    fetchLive,
    15_000,
  ))
  if (recovery.fulfilled &&
    recovery.response !== undefined &&
    recovery.response.status === 200 &&
    !containsForbiddenResponseContent(recovery.response.text, input) &&
    isExpectedPostProviderSourceFenceMutation(
      recovery.response.body,
      input.fixture.postProviderSourceFence,
      expectedRevision + 1,
      nextTitle,
    )) return true
  const reconciliation = await settleLiveJsonRequest(requestJson(
    input.apiBaseUrl,
    path,
    createAuthenticatedRequest(input.accessToken, 'GET'),
    fetchLive,
    15_000,
  ))
  return reconciliation.fulfilled &&
    reconciliation.response !== undefined &&
    reconciliation.response.status === 200 &&
    !hasReplayEvidence(reconciliation.response) &&
    !containsForbiddenResponseContent(reconciliation.response.text, input) &&
    isExpectedPostProviderSourceFenceMutation(
      reconciliation.response.body,
      input.fixture.postProviderSourceFence,
      expectedRevision + 1,
      nextTitle,
    )
}

/** Strongly reads a strict terminal receipt and proves its generation row is absent. */
async function readPostProviderSourceFenceTerminalSnapshot(
  verification: VerifyPostProviderSourceFenceInput,
  startedAttempt: PostProviderSourceFenceStartedAttempt,
  request: GenerateAiAssistanceRequest,
  failureCode: PostProviderSourceFenceErrorCode,
): Promise<PostProviderSourceFenceTerminalSnapshot | undefined> {
  const workspaceId = verification.input.fixture.durability.workspaceId
  const memberId = verification.input.fixture.durability.memberId
  const receipt = await readDurabilityItem(
    verification.input.durabilityTableName,
    workspaceId,
    startedAttempt.receiptKey,
    verification.dynamoGet,
  )
  const usage = readTerminalPostProviderSourceFenceUsage(
    receipt,
    workspaceId,
    memberId,
    startedAttempt.receiptKey,
    createAiAssistanceGenerationInputFingerprint(
      workspaceId,
      memberId,
      request,
    ),
    startedAttempt.generationId,
    failureCode,
    request,
    verification.input,
    verification.now(),
  )
  if (usage === undefined) return undefined
  const generation = await readDurabilityItem(
    verification.input.durabilityTableName,
    workspaceId,
    createAiAssistanceGenerationRecordKey(startedAttempt.generationId),
    verification.dynamoGet,
  )
  return generation === undefined ? { receipt, usage } : undefined
}

/**
 * Strongly probes the exact receipt and canonical generation row for cleanup accounting.
 *
 * @param verification - Strict protected evaluator and DynamoDB boundaries.
 * @param request - Exact drill generation request.
 * @param idempotencyKey - Opaque key shared by the original request and replay.
 * @returns Pending, accounted, or fail-closed unreconciled evidence.
 */
async function probePostProviderSourceFenceReconciliation(
  verification: VerifyPostProviderSourceFenceInput,
  request: GenerateAiAssistanceRequest,
  idempotencyKey: string,
): Promise<PostProviderSourceFenceReconciliationProbe> {
  const workspaceId = verification.input.fixture.durability.workspaceId
  const memberId = verification.input.fixture.durability.memberId
  const receiptKey = createAiAssistanceIdempotencyRecordKey(
    memberId,
    idempotencyKey,
  )
  const inputFingerprint = createAiAssistanceGenerationInputFingerprint(
    workspaceId,
    memberId,
    request,
  )
  const receipt = await readDurabilityItem(
    verification.input.durabilityTableName,
    workspaceId,
    receiptKey,
    verification.dynamoGet,
  )
  const generationId = isRecord(receipt) &&
      isBoundedNonEmptyString(receipt.generationId, 256)
    ? receipt.generationId
    : undefined
  const generation = generationId === undefined
    ? undefined
    : await readDurabilityItem(
        verification.input.durabilityTableName,
        workspaceId,
        createAiAssistanceGenerationRecordKey(generationId),
        verification.dynamoGet,
      )
  const recoveredUsage = readRecoverablePostProviderSourceFenceUsage(receipt)
  const terminal = readPostProviderSourceFenceTerminalAccounting(
    receipt,
    workspaceId,
    memberId,
    receiptKey,
    inputFingerprint,
    request,
    verification.input,
    verification.now(),
  )
  if (terminal !== undefined) {
    if (terminal.outcome === 'paid-completed') {
      return isReconciledPostProviderSourceFenceGeneration(
          generation,
          workspaceId,
          memberId,
          terminal.generationId,
          request,
          terminal.usage,
          verification.input,
          verification.now(),
        )
        ? {
            state: 'accounted',
            generationAbsent: false,
            ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
          }
        : {
            state: 'unreconciled',
            generationAbsent: generation === undefined,
            ...(recoveredUsage === undefined ? {} : { usage: recoveredUsage }),
          }
    }
    return generation === undefined
      ? {
          state: 'accounted',
          generationAbsent: true,
          ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
        }
      : {
          state: 'unreconciled',
          generationAbsent: false,
          ...(recoveredUsage === undefined ? {} : { usage: recoveredUsage }),
        }
  }
  if (
    isPollablePendingPostProviderSourceFenceReceipt(
      receipt,
      workspaceId,
      memberId,
      receiptKey,
      inputFingerprint,
      request,
      verification.input,
      verification.now(),
    ) &&
    generation === undefined
  ) {
    return { state: 'pending', generationAbsent: true }
  }
  return {
    state: 'unreconciled',
    generationAbsent: generationId !== undefined && generation === undefined,
    ...(recoveredUsage === undefined ? {} : { usage: recoveredUsage }),
  }
}

/**
 * Classifies one exact terminal receipt as provider-free, paid-failed, or paid-completed.
 *
 * @param value - Untrusted receipt row from a strongly consistent read.
 * @param workspaceId - Dedicated synthetic Workspace identity.
 * @param memberId - Synthetic member that owns the request.
 * @param recordKey - Canonical receipt key.
 * @param inputFingerprint - Exact request fingerprint.
 * @param request - Exact redacted request expected in the audit.
 * @param input - Strict protected evaluator input.
 * @param evaluatedAtMs - Wall-clock instant used for retention checks.
 * @returns Strict terminal accounting, or undefined for pending or malformed evidence.
 */
function readPostProviderSourceFenceTerminalAccounting(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  inputFingerprint: string,
  request: GenerateAiAssistanceRequest,
  input: ParsedAiAssistanceLiveEvaluationInput,
  evaluatedAtMs: number,
): PostProviderSourceFenceTerminalAccounting | undefined {
  if (
    !isRecord(value) ||
    !hasRequiredAndOptionalKeys(value, [
      'workspaceId',
      'recordKey',
      'recordType',
      'memberId',
      'inputFingerprint',
      'generationId',
      'status',
      'leaseExpiresAt',
      'expiresAt',
    ], ['attempt', 'failedAt', 'failureCategory', 'failureCode']) ||
    !hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-generation-idempotency',
    ) ||
    value.memberId !== memberId ||
    value.inputFingerprint !== inputFingerprint ||
    !isBoundedNonEmptyString(value.generationId, 256) ||
    !isNonNegativeSafeInteger(value.leaseExpiresAt) ||
    !isFutureRetentionTtl(value.expiresAt, evaluatedAtMs)
  ) return undefined

  if (value.status === 'completed') {
    if (
      value.failedAt !== undefined ||
      value.failureCategory !== undefined ||
      value.failureCode !== undefined ||
      !isRecord(value.attempt) ||
      !hasRequiredAndOptionalKeys(value.attempt, [
        'task',
        'modelId',
        'promptVersion',
        'traceId',
        'startedAt',
        'providerStartedAt',
        'audit',
        'status',
        'endedAt',
        'latencyMs',
        'usage',
        'providerOutcome',
      ], ['providerTraceId']) ||
      !isStrictTerminalPostProviderSourceFenceAttemptBase(
        value.attempt,
        request,
        input,
      ) ||
      value.attempt.status !== 'succeeded' ||
      !isIsoInstant(value.attempt.endedAt) ||
      !isNonNegativeSafeInteger(value.attempt.latencyMs) ||
      value.attempt.providerOutcome !== 'succeeded' ||
      (value.attempt.providerTraceId !== undefined &&
        !isBoundedNonEmptyString(value.attempt.providerTraceId, 256))
    ) return undefined
    const usage = readPostProviderSourceFenceUsage(value.attempt.usage)
    return usage !== undefined && usage.latencyMs === value.attempt.latencyMs
      ? { outcome: 'paid-completed', generationId: value.generationId, usage }
      : undefined
  }

  if (
    value.status !== 'failed' ||
    !isIsoInstant(value.failedAt) ||
    !isBoundedNonEmptyString(value.failureCategory, 64) ||
    !isBoundedNonEmptyString(value.failureCode, 128)
  ) return undefined
  if (value.attempt === undefined) {
    return {
      outcome: 'provider-free',
      generationId: value.generationId,
    }
  }
  if (
    !isRecord(value.attempt) ||
    !isStrictTerminalPostProviderSourceFenceAttemptBase(
      value.attempt,
      request,
      input,
    ) ||
    value.attempt.status !== 'failed' ||
    !isIsoInstant(value.attempt.endedAt) ||
    value.attempt.failureCategory !== value.failureCategory ||
    value.attempt.failureCode !== value.failureCode
  ) return undefined

  if (value.attempt.providerStartedAt === undefined) {
    return hasExactKeys(value.attempt, [
        'task',
        'modelId',
        'promptVersion',
        'traceId',
        'startedAt',
        'audit',
        'status',
        'endedAt',
        'latencyMs',
        'usageUnavailableReason',
        'failureCategory',
        'failureCode',
      ]) &&
      isNonNegativeSafeInteger(value.attempt.latencyMs) &&
      value.attempt.usageUnavailableReason === 'provider-did-not-report'
      ? { outcome: 'provider-free', generationId: value.generationId }
      : undefined
  }
  if (
    !hasRequiredAndOptionalKeys(value.attempt, [
      'task',
      'modelId',
      'promptVersion',
      'traceId',
      'startedAt',
      'providerStartedAt',
      'audit',
      'status',
      'endedAt',
      'latencyMs',
      'usage',
      'providerOutcome',
      'failureCategory',
      'failureCode',
    ], ['providerTraceId']) ||
    !isNonNegativeSafeInteger(value.attempt.latencyMs) ||
    value.attempt.providerOutcome === 'indeterminate' ||
    !isBoundedNonEmptyString(value.attempt.providerOutcome, 64) ||
    (value.attempt.providerTraceId !== undefined &&
      !isBoundedNonEmptyString(value.attempt.providerTraceId, 256))
  ) return undefined
  const usage = readPostProviderSourceFenceUsage(value.attempt.usage)
  return usage !== undefined && usage.latencyMs === value.attempt.latencyMs
    ? { outcome: 'paid-failed', generationId: value.generationId, usage }
    : undefined
}

/** Validates fields shared by every strict terminal drill attempt. */
function isStrictTerminalPostProviderSourceFenceAttemptBase(
  value: Readonly<Record<string, unknown>>,
  request: GenerateAiAssistanceRequest,
  input: ParsedAiAssistanceLiveEvaluationInput,
): boolean {
  return value.task === 'summary' &&
    value.modelId === input.fixture.expectedModelId &&
    value.promptVersion === input.fixture.expectedPromptVersion &&
    isBoundedNonEmptyString(value.traceId, 256) &&
    isIsoInstant(value.startedAt) &&
    (value.providerStartedAt === undefined ||
      (isIsoInstant(value.providerStartedAt) &&
        Date.parse(value.providerStartedAt) >= Date.parse(value.startedAt))) &&
    isStrictPostProviderSourceFenceAudit(value.audit, request, input)
}

/** Recovers only fully positive provider usage from an otherwise untrusted receipt. */
function readRecoverablePostProviderSourceFenceUsage(
  value: unknown,
): AiAssistanceLivePostProviderUsage | undefined {
  return isRecord(value) && isRecord(value.attempt)
    ? readPostProviderSourceFenceUsage(value.attempt.usage)
    : undefined
}

/**
 * Validates the canonical completed generation linked from a cleanup receipt.
 *
 * @param value - Untrusted canonical generation row.
 * @param workspaceId - Dedicated synthetic Workspace identity.
 * @param memberId - Synthetic member that owns the generation.
 * @param generationId - Server-generated receipt identity.
 * @param request - Exact drill request expected in persistence.
 * @param usage - Strict positive attempt usage.
 * @param input - Strict protected evaluator input.
 * @param evaluatedAtMs - Wall-clock instant used for retention checks.
 * @returns Whether every receipt-to-generation link is coherent.
 */
function isReconciledPostProviderSourceFenceGeneration(
  value: unknown,
  workspaceId: string,
  memberId: string,
  generationId: string,
  request: GenerateAiAssistanceRequest,
  usage: AiAssistanceLivePostProviderUsage | undefined,
  input: ParsedAiAssistanceLiveEvaluationInput,
  evaluatedAtMs: number,
): boolean {
  if (
    usage === undefined ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'workspaceId',
      'recordKey',
      'recordType',
      'memberId',
      'generation',
      'request',
      'authorizationToken',
      'auditedInput',
      'expiresAt',
    ]) ||
    !hasDurabilityRowIdentity(
      value,
      workspaceId,
      createAiAssistanceGenerationRecordKey(generationId),
      'ai-assistance-generation',
    ) ||
    value.memberId !== memberId ||
    !isBoundedNonEmptyString(value.authorizationToken, 8_192) ||
    typeof value.auditedInput !== 'string' ||
    value.auditedInput !== redactAiAssistanceText(value.auditedInput) ||
    containsForbiddenUnknown(value, input.fixture.forbiddenSubstrings, input.accessToken)
  ) return false
  try {
    const generation = parseAiAssistanceGeneration(value.generation)
    const storedRequest = parseGenerateAiAssistanceRequest(value.request)
    return generation.id === generationId &&
      generation.task === 'summary' &&
      generation.content.availability === 'available' &&
      generation.details.modelId === input.fixture.expectedModelId &&
      generation.details.promptVersion === input.fixture.expectedPromptVersion &&
      isDeepStrictEqual(generation.details.usage, usage) &&
      isDeepStrictEqual(storedRequest, redactGenerateAiAssistanceRequest(request)) &&
      isCurrentGenerationRetentionTtl(
        value.expiresAt,
        generation.expiresAt,
        evaluatedAtMs,
      )
  } catch {
    return false
  }
}

/** Validates that the canonical mutation committed exactly one title revision. */
function isExpectedPostProviderSourceFenceMutation(
  value: unknown,
  fixture: AiAssistanceLivePostProviderSourceFenceFixture,
  expectedRevision: number,
  expectedTitle: string,
): boolean {
  return isRecord(value) &&
    isRecord(value.issue) &&
    value.issue.id === fixture.workItemId &&
    value.issue.teamId === fixture.teamId &&
    value.issue.revision === expectedRevision &&
    value.issue.title === expectedTitle
}

/** Reads one bounded stable source-conflict code with its exact replay marker. */
function readPostProviderSourceFenceFailureCode(
  response: LiveJsonResponse,
  input: ParsedAiAssistanceLiveEvaluationInput,
  replayed: boolean,
): PostProviderSourceFenceErrorCode | undefined {
  if (
    response.status !== 409 ||
    !isRecord(response.body) ||
    hasReplayEvidence(response) !== replayed ||
    containsForbiddenResponseContent(response.text, input)
  ) return undefined
  const code = response.body.code
  return code === 'AiAssistanceSourceChanged' ||
      code === 'AiAssistanceAuthorizationChanged'
    ? code
    : undefined
}

/** Validates a pending reservation that can still acquire its provider-start marker. */
function isPollablePendingPostProviderSourceFenceReceipt(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  inputFingerprint: string,
  request: GenerateAiAssistanceRequest,
  input: ParsedAiAssistanceLiveEvaluationInput,
  evaluatedAtMs: number,
): boolean {
  if (value === undefined) return true
  if (
    !isRecord(value) ||
    !hasRequiredAndOptionalKeys(value, [
      'workspaceId',
      'recordKey',
      'recordType',
      'memberId',
      'inputFingerprint',
      'generationId',
      'status',
      'leaseExpiresAt',
      'expiresAt',
    ], ['attempt']) ||
    !hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-generation-idempotency',
    ) ||
    value.memberId !== memberId ||
    value.inputFingerprint !== inputFingerprint ||
    !isBoundedNonEmptyString(value.generationId, 256) ||
    value.status !== 'pending' ||
    !isNonNegativeSafeInteger(value.leaseExpiresAt) ||
    !isFutureRetentionTtl(value.expiresAt, evaluatedAtMs)
  ) return false
  if (value.attempt === undefined) return true
  return isRecord(value.attempt) &&
    hasRequiredAndOptionalKeys(value.attempt, [
      'task',
      'modelId',
      'promptVersion',
      'traceId',
      'startedAt',
      'audit',
      'status',
    ], ['providerStartedAt']) &&
    value.attempt.task === 'summary' &&
    value.attempt.modelId === input.fixture.expectedModelId &&
    value.attempt.promptVersion === input.fixture.expectedPromptVersion &&
    isBoundedNonEmptyString(value.attempt.traceId, 256) &&
    isIsoInstant(value.attempt.startedAt) &&
    (value.attempt.providerStartedAt === undefined ||
      (isIsoInstant(value.attempt.providerStartedAt) &&
        Date.parse(value.attempt.providerStartedAt) >=
          Date.parse(value.attempt.startedAt))) &&
    value.attempt.status === 'started' &&
    isStrictPostProviderSourceFenceAudit(value.attempt.audit, request, input)
}

/** Reads a strict singleton started attempt's generation identity, if present. */
function readStartedPostProviderSourceFenceGenerationId(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  inputFingerprint: string,
  request: GenerateAiAssistanceRequest,
  input: ParsedAiAssistanceLiveEvaluationInput,
  evaluatedAtMs: number,
): string | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'workspaceId',
      'recordKey',
      'recordType',
      'memberId',
      'inputFingerprint',
      'generationId',
      'status',
      'leaseExpiresAt',
      'expiresAt',
      'attempt',
    ]) ||
    !hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-generation-idempotency',
    ) ||
    value.memberId !== memberId ||
    value.inputFingerprint !== inputFingerprint ||
    !isBoundedNonEmptyString(value.generationId, 256) ||
    value.status !== 'pending' ||
    !isNonNegativeSafeInteger(value.leaseExpiresAt) ||
    !isFutureRetentionTtl(value.expiresAt, evaluatedAtMs) ||
    !isRecord(value.attempt) ||
    !hasExactKeys(value.attempt, [
      'task',
      'modelId',
      'promptVersion',
      'traceId',
      'startedAt',
      'providerStartedAt',
      'audit',
      'status',
    ]) ||
    value.attempt.task !== 'summary' ||
    value.attempt.modelId !== input.fixture.expectedModelId ||
    value.attempt.promptVersion !== input.fixture.expectedPromptVersion ||
    !isBoundedNonEmptyString(value.attempt.traceId, 256) ||
    !isIsoInstant(value.attempt.startedAt) ||
    !isIsoInstant(value.attempt.providerStartedAt) ||
    Date.parse(value.attempt.providerStartedAt) < Date.parse(value.attempt.startedAt) ||
    value.attempt.status !== 'started' ||
    !isStrictPostProviderSourceFenceAudit(value.attempt.audit, request, input)
  ) return undefined
  return value.generationId
}

/** Validates the exact redacted request and content-free attempt audit envelope. */
function isStrictPostProviderSourceFenceAudit(
  value: unknown,
  request: GenerateAiAssistanceRequest,
  input: ParsedAiAssistanceLiveEvaluationInput,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['request', 'auditedInput', 'citations']) ||
    !Array.isArray(value.citations) ||
    value.citations.length > 100 ||
    typeof value.auditedInput !== 'string' ||
    value.auditedInput.length < 1 ||
    value.auditedInput.length > 100_000 ||
    value.auditedInput !== redactAiAssistanceText(value.auditedInput) ||
    containsForbiddenUnknown(
      value,
      input.fixture.forbiddenSubstrings,
      input.accessToken,
    )
  ) return false
  try {
    return isDeepStrictEqual(
      parseGenerateAiAssistanceRequest(value.request),
      redactGenerateAiAssistanceRequest(request),
    )
  } catch {
    return false
  }
}

/** Reads strict usage from a terminal failed attempt that discarded provider output. */
function readTerminalPostProviderSourceFenceUsage(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  inputFingerprint: string,
  generationId: string,
  failureCode: PostProviderSourceFenceErrorCode,
  request: GenerateAiAssistanceRequest,
  input: ParsedAiAssistanceLiveEvaluationInput,
  evaluatedAtMs: number,
): AiAssistanceLivePostProviderUsage | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'workspaceId',
      'recordKey',
      'recordType',
      'memberId',
      'inputFingerprint',
      'generationId',
      'status',
      'leaseExpiresAt',
      'expiresAt',
      'attempt',
      'failedAt',
      'failureCategory',
      'failureCode',
    ]) ||
    !hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-generation-idempotency',
    ) ||
    value.memberId !== memberId ||
    value.inputFingerprint !== inputFingerprint ||
    value.generationId !== generationId ||
    value.status !== 'failed' ||
    value.failureCategory !== 'conflict' ||
    value.failureCode !== failureCode ||
    !isIsoInstant(value.failedAt) ||
    !isNonNegativeSafeInteger(value.leaseExpiresAt) ||
    !isFutureRetentionTtl(value.expiresAt, evaluatedAtMs) ||
    !isRecord(value.attempt) ||
    !hasRequiredAndOptionalKeys(value.attempt, [
      'task',
      'modelId',
      'promptVersion',
      'traceId',
      'startedAt',
      'providerStartedAt',
      'audit',
      'status',
      'endedAt',
      'latencyMs',
      'usage',
      'providerOutcome',
      'failureCategory',
      'failureCode',
    ], ['providerTraceId']) ||
    value.attempt.task !== 'summary' ||
    value.attempt.modelId !== input.fixture.expectedModelId ||
    value.attempt.promptVersion !== input.fixture.expectedPromptVersion ||
    !isBoundedNonEmptyString(value.attempt.traceId, 256) ||
    !isIsoInstant(value.attempt.startedAt) ||
    !isIsoInstant(value.attempt.providerStartedAt) ||
    Date.parse(value.attempt.providerStartedAt) < Date.parse(value.attempt.startedAt) ||
    value.attempt.status !== 'failed' ||
    !isIsoInstant(value.attempt.endedAt) ||
    !isNonNegativeSafeInteger(value.attempt.latencyMs) ||
    value.attempt.providerOutcome !== 'succeeded' ||
    value.attempt.failureCategory !== 'conflict' ||
    value.attempt.failureCode !== failureCode ||
    (value.attempt.providerTraceId !== undefined &&
      !isBoundedNonEmptyString(value.attempt.providerTraceId, 256)) ||
    !isStrictPostProviderSourceFenceAudit(value.attempt.audit, request, input)
  ) return undefined
  const usage = readPostProviderSourceFenceUsage(value.attempt.usage)
  return usage !== undefined && value.attempt.latencyMs === usage.latencyMs
    ? usage
    : undefined
}

/** Strictly parses provider usage from the paid failed attempt. */
function readPostProviderSourceFenceUsage(
  value: unknown,
): AiAssistanceLivePostProviderUsage | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['inputTokens', 'outputTokens', 'latencyMs', 'costUsd']) ||
    !isNonNegativeSafeInteger(value.inputTokens) ||
    value.inputTokens < 1 ||
    !isNonNegativeSafeInteger(value.outputTokens) ||
    value.outputTokens < 1 ||
    !isNonNegativeSafeInteger(value.latencyMs) ||
    value.latencyMs < 1 ||
    typeof value.costUsd !== 'number' ||
    !Number.isFinite(value.costUsd) ||
    value.costUsd <= 0
  ) return undefined
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    latencyMs: value.latencyMs,
    costUsd: value.costUsd,
  }
}

/** Checks that an object has exactly the required keys and no others. */
function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
}

/** Checks exact required keys plus a bounded set of optional keys. */
function hasRequiredAndOptionalKeys(
  value: Readonly<Record<string, unknown>>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value)
  return requiredKeys.every((key) => actualKeys.includes(key)) &&
    actualKeys.every((key) =>
      requiredKeys.includes(key) || optionalKeys.includes(key))
}

/** Maps the seventh call's per-generation budget overage to a stable failure. */
function readPostProviderSourceFenceBudgetFailure(
  usage: AiAssistanceLivePostProviderUsage,
  budgets: AiAssistanceLiveBudgets,
): AiAssistanceLiveEvalFailureCode | undefined {
  if (usage.latencyMs > budgets.maxLatencyMsPerGeneration) {
    return 'latency-budget-exceeded'
  }
  if (usage.inputTokens > budgets.maxInputTokensPerGeneration) {
    return 'input-token-budget-exceeded'
  }
  if (usage.outputTokens > budgets.maxOutputTokensPerGeneration) {
    return 'output-token-budget-exceeded'
  }
  if (usage.costUsd > budgets.maxCostUsdPerGeneration) {
    return 'cost-budget-exceeded'
  }
  return undefined
}

/** Polls one exact receipt until its strict singleton started attempt is visible. */
async function pollForPostProviderSourceFenceStartedAttempt(
  verification: {
    /** Strict protected evaluator input. */
    input: ParsedAiAssistanceLiveEvaluationInput
    /** Exact request whose fingerprint owns the receipt. */
    request: GenerateAiAssistanceRequest
    /** Opaque generation idempotency key. */
    idempotencyKey: string
    /** Strongly consistent exact-key DynamoDB boundary. */
    dynamoGet: AiAssistanceLiveDynamoGet
    /** Wall-clock reader used for retention checks. */
    now: () => number
    /** Bounded polling wait boundary. */
    wait: (durationMs: number) => Promise<void>
  },
): Promise<PostProviderSourceFenceStartedAttempt | undefined> {
  const workspaceId = verification.input.fixture.durability.workspaceId
  const memberId = verification.input.fixture.durability.memberId
  const receiptKey = createAiAssistanceIdempotencyRecordKey(
    memberId,
    verification.idempotencyKey,
  )
  const inputFingerprint = createAiAssistanceGenerationInputFingerprint(
    workspaceId,
    memberId,
    verification.request,
  )
  for (let index = 0; index < POST_PROVIDER_RECEIPT_POLL_LIMIT; index += 1) {
    const receipt = await readDurabilityItem(
      verification.input.durabilityTableName,
      workspaceId,
      receiptKey,
      verification.dynamoGet,
    )
    const generationId = readStartedPostProviderSourceFenceGenerationId(
      receipt,
      workspaceId,
      memberId,
      receiptKey,
      inputFingerprint,
      verification.request,
      verification.input,
      verification.now(),
    )
    if (generationId !== undefined) {
      return {
        receiptKey,
        generationId,
      }
    }
    if (!isPollablePendingPostProviderSourceFenceReceipt(
      receipt,
      workspaceId,
      memberId,
      receiptKey,
      inputFingerprint,
      verification.request,
      verification.input,
      verification.now(),
    )) return undefined
    if (index + 1 < POST_PROVIDER_RECEIPT_POLL_LIMIT) {
      await verification.wait(POST_PROVIDER_RECEIPT_POLL_INTERVAL_MS)
    }
  }
  return undefined
}

/**
 * Strongly reads only the canonical rows created by this run and validates their linkage.
 *
 * @param verification - Successful HTTP transcript identities and exact DynamoDB boundary.
 * @returns Fixed content-free evidence plus stable failure codes.
 */
async function verifyLiveDurabilityEvidence(
  verification: AiAssistanceLiveDurabilityVerificationInput,
): Promise<AiAssistanceLiveDurabilityVerificationResult> {
  const failures: AiAssistanceLiveEvalFailureCode[] = []
  let receiptCount = 0
  let successfulAttemptCount = 0
  let auditEnvelopeCount = 0
  let generationCount = 0
  let feedbackCount = 0
  let staleAttemptAbsent = false
  let staleGenerationAbsent = false
  let approvedDecisionPersisted = false
  const workspaceId = verification.input.fixture.durability.workspaceId
  const memberId = verification.input.fixture.durability.memberId

  try {
    for (const durabilityCase of verification.cases) {
      const receiptKey = createAiAssistanceIdempotencyRecordKey(
        memberId,
        durabilityCase.idempotencyKey,
      )
      const receipt = await readDurabilityItem(
        verification.input.durabilityTableName,
        workspaceId,
        receiptKey,
        verification.dynamoGet,
      )
      const receiptPassed = isCompletedGenerationReceipt(
        receipt,
        workspaceId,
        memberId,
        receiptKey,
        createAiAssistanceGenerationInputFingerprint(
          workspaceId,
          memberId,
          durabilityCase.request,
        ),
        durabilityCase.generation.id,
        durabilityCase.generation.expiresAt,
        verification.evaluatedAtMs,
      )
      if (receiptPassed) receiptCount += 1
      else failures.push('durability-receipt-mismatch')

      const attempt = isRecord(receipt) ? receipt.attempt : undefined
      const attemptPassed = isSucceededGenerationAttempt(
        attempt,
        receipt,
        durabilityCase,
        verification.input,
      )
      if (attemptPassed) successfulAttemptCount += 1
      else failures.push('durability-attempt-mismatch')
      if (
        attemptPassed &&
        isRecord(attempt) &&
        isValidGenerationAttemptAudit(
          attempt.audit,
          durabilityCase,
          verification.input,
        )
      ) auditEnvelopeCount += 1

      const generationKey = createAiAssistanceGenerationRecordKey(
        durabilityCase.generation.id,
      )
      const generationItem = await readDurabilityItem(
        verification.input.durabilityTableName,
        workspaceId,
        generationKey,
        verification.dynamoGet,
      )
      const generationResult = validateStoredGenerationItem(
        generationItem,
        workspaceId,
        memberId,
        generationKey,
        durabilityCase,
        attempt,
        verification.input,
        verification.evaluatedAtMs,
      )
      if (generationResult.passed) generationCount += 1
      else failures.push('durability-generation-mismatch')
      if (durabilityCase.journey === 'work-item') {
        approvedDecisionPersisted = generationResult.approvedDecisionPersisted
      }
    }

    const staleReceiptKey = createAiAssistanceIdempotencyRecordKey(
      memberId,
      verification.stale.idempotencyKey,
    )
    const staleReceipt = await readDurabilityItem(
      verification.input.durabilityTableName,
      workspaceId,
      staleReceiptKey,
      verification.dynamoGet,
    )
    const staleGenerationId = readStaleGenerationId(staleReceipt)
    const staleReceiptPassed = isTerminalStaleReceipt(
      staleReceipt,
      workspaceId,
      memberId,
      staleReceiptKey,
      createAiAssistanceGenerationInputFingerprint(
        workspaceId,
        memberId,
        verification.stale.request,
      ),
      verification.evaluatedAtMs,
    )
    if (staleReceiptPassed) receiptCount += 1
    else failures.push('durability-receipt-mismatch')
    staleAttemptAbsent = staleReceiptPassed &&
      isRecord(staleReceipt) &&
      staleReceipt.attempt === undefined &&
      staleReceipt.attempts === undefined
    if (!staleAttemptAbsent) failures.push('durability-attempt-mismatch')
    if (staleGenerationId === undefined) {
      failures.push('durability-generation-mismatch')
    } else {
      const staleGeneration = await readDurabilityItem(
        verification.input.durabilityTableName,
        workspaceId,
        createAiAssistanceGenerationRecordKey(staleGenerationId),
        verification.dynamoGet,
      )
      staleGenerationAbsent = staleGeneration === undefined
      if (!staleGenerationAbsent) failures.push('durability-generation-mismatch')
    }

    const feedbackIdentity = createAiAssistanceFeedbackIdentity(
      workspaceId,
      memberId,
      verification.feedback.generationId,
      verification.feedback.feedback,
      verification.feedback.idempotencyKey,
    )
    const feedbackKey = createAiAssistanceFeedbackRecordKey(
      verification.feedback.generationId,
      feedbackIdentity.feedbackId,
    )
    const feedbackItem = await readDurabilityItem(
      verification.input.durabilityTableName,
      workspaceId,
      feedbackKey,
      verification.dynamoGet,
    )
    if (isStoredFeedbackItem(
      feedbackItem,
      workspaceId,
      memberId,
      feedbackKey,
      verification.feedback,
      feedbackIdentity.feedbackId,
      feedbackIdentity.inputFingerprint,
      verification.feedback.generationExpiresAt,
      verification.evaluatedAtMs,
    )) feedbackCount = 1
    else failures.push('durability-feedback-mismatch')
  } catch {
    return {
      evidence: createEmptyDurabilityEvidence(),
      failures: ['durability-read-failed'],
    }
  }

  const uniqueDurabilityFailures = uniqueFailures(failures)
  const evidence: AiAssistanceLiveEvalDurability = {
    passed: receiptCount === 7 &&
      successfulAttemptCount === 6 &&
      auditEnvelopeCount === 6 &&
      generationCount === 6 &&
      feedbackCount === 1 &&
      staleAttemptAbsent &&
      staleGenerationAbsent &&
      approvedDecisionPersisted &&
      uniqueDurabilityFailures.length === 0,
    receiptCount,
    successfulAttemptCount,
    auditEnvelopeCount,
    generationCount,
    feedbackCount,
    staleAttemptAbsent,
    staleGenerationAbsent,
    postProviderFailedReceiptCount: 0,
    postProviderFailedAttemptCount: 0,
    postProviderAuditEnvelopeCount: 0,
    postProviderGenerationAbsent: false,
    approvedDecisionPersisted,
  }
  return { evidence, failures: uniqueDurabilityFailures }
}

/** Creates the production read boundary without exposing any broader DynamoDB operation. */
function createDefaultDynamoGet(region: string): AiAssistanceLiveDynamoGet {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
  return async (command) => await documentClient.send(command)
}

/**
 * Reads one exact Workspace row with strong consistency.
 *
 * @param tableName - Exact protected physical table name.
 * @param workspaceId - Dedicated synthetic partition key.
 * @param recordKey - Canonical row key derived in process.
 * @param dynamoGet - Read-only GetCommand transport.
 * @returns The untrusted DynamoDB item, or undefined when the exact row is absent.
 */
async function readDurabilityItem(
  tableName: string,
  workspaceId: string,
  recordKey: string,
  dynamoGet: AiAssistanceLiveDynamoGet,
): Promise<unknown> {
  const output = await dynamoGet(new GetCommand({
    TableName: tableName,
    Key: { workspaceId, recordKey },
    ConsistentRead: true,
  }))
  const item: unknown = output.Item
  return item
}

/** Validates the identity, input linkage, and terminal status of one successful receipt. */
function isCompletedGenerationReceipt(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  inputFingerprint: string,
  generationId: string,
  generationExpiresAt: string,
  evaluatedAtMs: number,
): boolean {
  return isRecord(value) &&
    hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-generation-idempotency',
    ) &&
    value.memberId === memberId &&
    value.inputFingerprint === inputFingerprint &&
    value.generationId === generationId &&
    value.status === 'completed' &&
    isNonNegativeSafeInteger(value.leaseExpiresAt) &&
    isCurrentGenerationRetentionTtl(
      value.expiresAt,
      generationExpiresAt,
      evaluatedAtMs,
    ) &&
    value.attempts === undefined
}

/** Validates one terminal successful provider attempt and its redacted audit envelope. */
function isSucceededGenerationAttempt(
  value: unknown,
  receipt: unknown,
  durabilityCase: AiAssistanceLiveSuccessfulDurabilityCase,
  input: ParsedAiAssistanceLiveEvaluationInput,
): boolean {
  if (!isRecord(value) || !isRecord(receipt)) return false
  const statusPassed = value.status === 'succeeded' &&
    value.providerOutcome === 'succeeded' &&
    (value.outcome === undefined || value.outcome === 'succeeded')
  const tracePassed = isBoundedNonEmptyString(value.traceId, 256) &&
    (value.providerTraceId === undefined
      ? durabilityCase.generation.details.traceId === value.traceId
      : isBoundedNonEmptyString(value.providerTraceId, 256) &&
        durabilityCase.generation.details.traceId === value.providerTraceId)
  return receipt.attempt === value &&
    receipt.attempts === undefined &&
    statusPassed &&
    value.task === durabilityCase.generation.task &&
    value.modelId === input.fixture.expectedModelId &&
    value.promptVersion === input.fixture.expectedPromptVersion &&
    tracePassed &&
    isIsoInstant(value.startedAt) &&
    isIsoInstant(value.providerStartedAt) &&
    Date.parse(value.providerStartedAt) >= Date.parse(value.startedAt) &&
    isIsoInstant(value.endedAt) &&
    isNonNegativeSafeInteger(value.latencyMs) &&
    isDeepStrictEqual(value.usage, durabilityCase.generation.details.usage) &&
    value.failureCategory === undefined &&
    value.failureCode === undefined &&
    isValidGenerationAttemptAudit(value.audit, durabilityCase, input)
}

/** Validates the strict request, redacted context, citations, and leak-free audit envelope. */
function isValidGenerationAttemptAudit(
  value: unknown,
  durabilityCase: AiAssistanceLiveSuccessfulDurabilityCase,
  input: ParsedAiAssistanceLiveEvaluationInput,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.citations)) return false
  let request: GenerateAiAssistanceRequest
  try {
    request = parseGenerateAiAssistanceRequest(value.request)
  } catch {
    return false
  }
  const citations = durabilityCase.generation.content.availability === 'available'
    ? durabilityCase.generation.content.citations
    : []
  return isDeepStrictEqual(
    request,
    redactGenerateAiAssistanceRequest(durabilityCase.request),
  ) &&
    typeof value.auditedInput === 'string' &&
    value.auditedInput.length > 0 &&
    value.auditedInput.length <= 100_000 &&
    value.auditedInput === redactAiAssistanceText(value.auditedInput) &&
    isDeepStrictEqual(value.citations, citations) &&
    !containsForbiddenUnknown(
      value,
      input.fixture.forbiddenSubstrings,
      input.accessToken,
    )
}

/** Validates one canonical generation row and the persisted approval when applicable. */
function validateStoredGenerationItem(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  durabilityCase: AiAssistanceLiveSuccessfulDurabilityCase,
  attempt: unknown,
  input: ParsedAiAssistanceLiveEvaluationInput,
  evaluatedAtMs: number,
): {
  /** Whether the canonical generation row and all links passed. */
  passed: boolean
  /** Whether the Work Item approval alone passed its preservation invariant. */
  approvedDecisionPersisted: boolean
} {
  if (
    !isRecord(value) ||
    !hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-generation',
    ) ||
    value.memberId !== memberId ||
    !isBoundedNonEmptyString(value.authorizationToken, 8_192) ||
    !isCurrentGenerationRetentionTtl(
      value.expiresAt,
      durabilityCase.generation.expiresAt,
      evaluatedAtMs,
    )
  ) return { passed: false, approvedDecisionPersisted: false }

  let generation: AiAssistanceGeneration
  let request: GenerateAiAssistanceRequest
  try {
    generation = parseAiAssistanceGeneration(value.generation)
    request = parseGenerateAiAssistanceRequest(value.request)
  } catch {
    return { passed: false, approvedDecisionPersisted: false }
  }
  const approvedDecisionPersisted = durabilityCase.journey === 'work-item' &&
    approvedDecisionPreservesGeneration(durabilityCase.generation, generation)
  const generationPassed = durabilityCase.journey === 'work-item'
    ? approvedDecisionPersisted
    : isDeepStrictEqual(generation, durabilityCase.generation)
  const audit = isRecord(attempt) && isRecord(attempt.audit)
    ? attempt.audit
    : undefined
  const expectedRequest = redactGenerateAiAssistanceRequest(durabilityCase.request)
  return {
    passed: generationPassed &&
      generation.id === durabilityCase.generation.id &&
      isDeepStrictEqual(request, expectedRequest) &&
      typeof value.auditedInput === 'string' &&
      value.auditedInput === redactAiAssistanceText(value.auditedInput) &&
      audit !== undefined &&
      isDeepStrictEqual(audit.request, request) &&
      audit.auditedInput === value.auditedInput &&
      !containsForbiddenUnknown(
        { request, auditedInput: value.auditedInput },
        input.fixture.forbiddenSubstrings,
        input.accessToken,
      ),
    approvedDecisionPersisted,
  }
}

/** Extracts the server-owned generation identity from a terminal stale receipt. */
function readStaleGenerationId(value: unknown): string | undefined {
  if (!isRecord(value) || !isBoundedNonEmptyString(value.generationId, 256)) {
    return undefined
  }
  return value.generationId
}

/** Validates the stale-source failure receipt without accepting a provider attempt. */
function isTerminalStaleReceipt(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  inputFingerprint: string,
  evaluatedAtMs: number,
): boolean {
  return isRecord(value) &&
    hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-generation-idempotency',
    ) &&
    value.memberId === memberId &&
    value.inputFingerprint === inputFingerprint &&
    isBoundedNonEmptyString(value.generationId, 256) &&
    value.status === 'failed' &&
    value.failureCategory === 'conflict' &&
    value.failureCode === 'AiAssistanceSourceChanged' &&
    isIsoInstant(value.failedAt) &&
    isNonNegativeSafeInteger(value.leaseExpiresAt) &&
    isFutureRetentionTtl(value.expiresAt, evaluatedAtMs) &&
    value.attempt === undefined &&
    value.attempts === undefined
}

/** Validates one deterministic feedback row derived from the exact replay key. */
function isStoredFeedbackItem(
  value: unknown,
  workspaceId: string,
  memberId: string,
  recordKey: string,
  feedbackCase: AiAssistanceLiveFeedbackDurabilityCase,
  feedbackId: string,
  inputFingerprint: string,
  generationExpiresAt: string,
  evaluatedAtMs: number,
): boolean {
  if (
    !isRecord(value) ||
    !hasDurabilityRowIdentity(
      value,
      workspaceId,
      recordKey,
      'ai-assistance-feedback',
    ) ||
    value.memberId !== memberId ||
    value.generationId !== feedbackCase.generationId ||
    value.feedbackId !== feedbackId ||
    value.inputFingerprint !== inputFingerprint ||
    !isIsoInstant(value.createdAt) ||
    !isCurrentGenerationRetentionTtl(
      value.expiresAt,
      generationExpiresAt,
      evaluatedAtMs,
    )
  ) return false
  try {
    return isDeepStrictEqual(
      parseCreateAiAssistanceFeedbackRequest(value.feedback),
      feedbackCase.feedback,
    )
  } catch {
    return false
  }
}

/** Checks the fixed partition, sort key, and row discriminator for one read result. */
function hasDurabilityRowIdentity(
  value: Readonly<Record<string, unknown>>,
  workspaceId: string,
  recordKey: string,
  recordType: string,
): boolean {
  return value.workspaceId === workspaceId &&
    value.recordKey === recordKey &&
    value.recordType === recordType
}

/** Checks one untrusted epoch number without coercion. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Checks that one DynamoDB TTL remains strictly after the evaluation instant. */
function isFutureRetentionTtl(value: unknown, evaluatedAtMs: number): value is number {
  return isNonNegativeSafeInteger(value) &&
    isNonNegativeSafeInteger(evaluatedAtMs) &&
    value * 1_000 > evaluatedAtMs
}

/** Checks one inherited DynamoDB TTL against the public generation deadline. */
function isCurrentGenerationRetentionTtl(
  value: unknown,
  generationExpiresAt: string,
  evaluatedAtMs: number,
): boolean {
  const publicExpirationMs = Date.parse(generationExpiresAt)
  return Number.isFinite(publicExpirationMs) &&
    isFutureRetentionTtl(value, evaluatedAtMs) &&
    value === Math.floor(publicExpirationMs / 1_000)
}

/** Checks one bounded non-empty string without normalizing persisted evidence. */
function isBoundedNonEmptyString(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value
}

/** Checks one explicit ISO-like instant and a finite parsed timestamp. */
function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
}

/** Scans an untrusted evidence envelope for configured canaries or credential shapes. */
function containsForbiddenUnknown(
  value: unknown,
  forbiddenSubstrings: readonly string[],
  accessToken: string,
): boolean {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized !== 'string' || containsForbiddenContent(
      serialized,
      forbiddenSubstrings,
      accessToken,
    )
  } catch {
    return true
  }
}

/** Builds a bearer-authenticated JSON request with an optional opaque idempotency key. */
function createJsonRequest(
  accessToken: string,
  body: unknown,
  idempotencyKey?: string,
): RequestInit {
  return {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  }
}

/** Builds one bearer-authenticated request that never logs its access token. */
function createAuthenticatedRequest(
  accessToken: string,
  method: 'GET' | 'POST',
): RequestInit {
  return {
    method,
    redirect: 'error',
    headers: { Authorization: `Bearer ${accessToken}` },
  }
}

/** Adds the provider latency budget to bounded transport overhead. */
function generationHttpTimeout(budgets: AiAssistanceLiveBudgets): number {
  return Math.min(
    budgets.maxLatencyMsPerGeneration + DEFAULT_HTTP_TIMEOUT_OVERHEAD_MS,
    MAX_HTTP_TIMEOUT_MS,
  )
}

/** Sends one request and parses a bounded JSON response without exposing its body. */
async function requestJson(
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
  fetchLive: AiAssistanceLiveFetch,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<LiveJsonResponse> {
  const response = await requestText(
    apiBaseUrl,
    path,
    init,
    fetchLive,
    timeoutMs,
    externalSignal,
  )
  try {
    return { ...response, body: JSON.parse(response.text) }
  } catch {
    throw new Error('response-json-invalid')
  }
}

/** Sends one bounded, non-redirecting HTTPS request and reads its response once. */
async function requestText(
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
  fetchLive: AiAssistanceLiveFetch,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{
  /** HTTP response status. */
  status: number
  /** Response headers used only for fixed replay evidence. */
  headers: AiAssistanceLiveHttpResponse['headers']
  /** Bounded response text retained only in memory. */
  text: string
}> {
  const controller = new AbortController()
  const abortFromExternalSignal = () => controller.abort()
  if (externalSignal?.aborted === true) controller.abort()
  externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchLive(`${apiBaseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await readBoundedResponseText(response)
    return { status: response.status, headers: response.headers, text }
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternalSignal)
  }
}

/** Reads a response stream incrementally and cancels before retaining excess bytes. */
async function readBoundedResponseText(
  response: AiAssistanceLiveHttpResponse,
): Promise<string> {
  if (response.body === undefined || response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let byteCount = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteCount += chunk.value.byteLength
      if (byteCount > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The stable size failure still owns this already-failed response.
        }
        throw new Error('response-too-large')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/** Cancels one unread response body to simulate loss after status and headers arrive. */
async function requestAndDiscardBody(
  apiBaseUrl: string,
  path: string,
  init: RequestInit,
  fetchLive: AiAssistanceLiveFetch,
  timeoutMs: number,
): Promise<{
  /** HTTP response status observed before the body was discarded. */
  status: number
  /** Whether the server said this supposedly fresh request was already a replay. */
  replayed: boolean
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchLive(`${apiBaseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    })
    await response.body?.cancel()
    return {
      status: response.status,
      replayed: response.headers.get('Idempotency-Replayed')?.trim().toLowerCase() === 'true',
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** Checks the server-owned marker proving that a durable receipt served the response. */
function hasReplayEvidence(
  response: Pick<LiveJsonResponse, 'headers'> | {
    /** Response headers used only for fixed replay evidence. */
    headers: AiAssistanceLiveHttpResponse['headers']
  },
): boolean {
  return response.headers.get('Idempotency-Replayed')?.trim().toLowerCase() === 'true'
}

/** Maps internal transport sentinels to stable content-free report failures. */
function classifyTransportFailure(error: unknown): AiAssistanceLiveEvalFailureCode {
  return error instanceof Error && error.message === 'response-too-large'
    ? 'response-too-large'
    : error instanceof Error && error.message === 'response-json-invalid'
      ? 'response-json-invalid'
      : 'transport-failed'
}

/** Checks one authenticated response against dynamic and seeded secret material. */
function containsForbiddenResponseContent(
  value: string,
  input: ParsedAiAssistanceLiveEvaluationInput,
): boolean {
  return containsForbiddenContent(
    value,
    input.fixture.forbiddenSubstrings,
    input.accessToken,
  )
}

/** Checks seeded canaries and common credential forms without retaining a matched value. */
function containsForbiddenContent(
  value: string,
  forbiddenSubstrings: readonly string[],
  accessToken?: string,
): boolean {
  if (
    (accessToken !== undefined && value.includes(accessToken)) ||
    forbiddenSubstrings.some((candidate) => value.includes(candidate))
  ) return true
  return /(?:AKIA|ASIA)[A-Z0-9]{16}/.test(value) ||
    /["']?(?:authorization|proxy-authorization)["']?\s*:\s*["']?\s*(?:bearer|basic)\s+/i
      .test(value) ||
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/.test(value) ||
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) ||
    /https?:\/\/[^\s"']+[?&](?:X-Amz-(?:Credential|Security-Token|Signature)|X-Goog-(?:Credential|Signature)|GoogleAccessId|token|sig|signature)=/i
      .test(value)
}

/** Checks that an available draft discriminator matches the requested workflow. */
function draftMatchesTask(
  content: AiAssistanceGeneration['content'],
  task: GenerateAiAssistanceRequest['task'],
): boolean {
  if (content.availability !== 'available') return false
  return content.draft.kind === task
}

/** Returns the only citation source category allowed for one fixed source journey. */
function expectedCitationSourceType(
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

/** Collects every evidence citation reference from a strict task-specific draft. */
function collectDraftCitationIds(draft: AiAssistanceDraft): string[] {
  switch (draft.kind) {
    case 'triage':
      return [
        draft.title,
        draft.description,
        draft.priority,
        draft.assigneeUserId,
        draft.teamId,
        draft.projectId,
        ...draft.customFields,
      ].flatMap((value) => value?.citationIds ?? [])
    case 'summary':
      return [
        draft.overview,
        ...draft.decisions,
        ...draft.actions,
        ...draft.risks,
      ].flatMap((value) => value.citationIds)
    case 'search':
      return []
    case 'planning':
      return [
        draft.title,
        draft.description,
        draft.priority,
        draft.status,
        draft.plannedEffortMinutes,
        ...draft.subtasks,
        ...draft.dependencies,
        draft.statusUpdate,
      ].flatMap((value) => value?.citationIds ?? [])
  }
}

/** Creates a rate-limit-aware pacer for new keys while allowing immediate same-key replay. */
function createUniqueGenerationPacer(
  now: () => number,
  wait: (durationMs: number) => Promise<void>,
): UniqueGenerationPacer {
  let previousStartedAt: number | undefined
  return {
    async beforeNext() {
      const current = now()
      if (previousStartedAt !== undefined) {
        const remaining = UNIQUE_GENERATION_INTERVAL_MS - (current - previousStartedAt)
        if (remaining > 0) await wait(remaining)
      }
      previousStartedAt = now()
    },
  }
}

/** Waits for one bounded pacing duration. */
async function waitForDuration(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs))
}

/** Creates an aggregate content-free report and applies total provider budgets. */
function createReport(
  journeys: readonly AiAssistanceLiveEvalJourneyResult[],
  checks: AiAssistanceLiveEvalChecks,
  durability: AiAssistanceLiveEvalDurability,
  reportFailures: readonly AiAssistanceLiveEvalFailureCode[],
  budgets: AiAssistanceLiveBudgets,
  postProviderUsage?: AiAssistanceLivePostProviderUsage,
): AiAssistanceLiveEvalReport {
  const journeyTotals = summarizeJourneyProviderUsage(journeys)
  const totals = {
    inputTokens: journeyTotals.inputTokens + (postProviderUsage?.inputTokens ?? 0),
    outputTokens: journeyTotals.outputTokens + (postProviderUsage?.outputTokens ?? 0),
    costUsd: journeyTotals.costUsd + (postProviderUsage?.costUsd ?? 0),
  }
  const failures = [...reportFailures]
  if (totals.inputTokens > budgets.maxTotalInputTokens) {
    failures.push('aggregate-input-token-budget-exceeded')
  }
  if (totals.outputTokens > budgets.maxTotalOutputTokens) {
    failures.push('aggregate-output-token-budget-exceeded')
  }
  if (totals.costUsd > budgets.maxTotalCostUsd) {
    failures.push('aggregate-cost-budget-exceeded')
  }
  const passedJourneyCount = journeys.filter((journey) => journey.passed).length
  const allChecksPassed = Object.values(checks).every((passed) => passed)
  const uniqueReportFailures = uniqueFailures(failures)
  return {
    schemaVersion: 2,
    passed: journeys.length === REQUIRED_JOURNEYS.length &&
      passedJourneyCount === journeys.length &&
      allChecksPassed &&
      durability.passed &&
      uniqueReportFailures.length === 0,
    journeyCount: journeys.length,
    passedJourneyCount,
    journeys: [...journeys],
    checks,
    failures: uniqueReportFailures,
    durability,
    totals,
  }
}

/** Sums provider usage for the six successful-journey response records. */
function summarizeJourneyProviderUsage(
  journeys: readonly AiAssistanceLiveEvalJourneyResult[],
): AiAssistanceLiveEvalReport['totals'] {
  return journeys.reduce(
    (sum, journey) => ({
      inputTokens: sum.inputTokens + (journey.metrics?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (journey.metrics?.outputTokens ?? 0),
      costUsd: sum.costUsd + (journey.metrics?.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  )
}

/** Creates the fixed fail-closed durability shape without retaining read context. */
function createEmptyDurabilityEvidence(): AiAssistanceLiveEvalDurability {
  return {
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
  }
}

/** Creates a fixed fail-closed shape for the active post-provider source-fence drill. */
function createEmptyPostProviderSourceFenceEvidence():
  AiAssistanceLivePostProviderSourceFenceEvidence {
  return {
    passed: false,
    failedReceiptCount: 0,
    failedAttemptCount: 0,
    auditEnvelopeCount: 0,
    generationAbsent: false,
  }
}

/** Adds active-drill evidence to the existing six-journey durability contract. */
function mergePostProviderSourceFenceEvidence(
  durability: AiAssistanceLiveEvalDurability,
  postProvider: AiAssistanceLivePostProviderSourceFenceEvidence,
): AiAssistanceLiveEvalDurability {
  return {
    ...durability,
    passed: durability.passed && postProvider.passed,
    postProviderFailedReceiptCount: postProvider.failedReceiptCount,
    postProviderFailedAttemptCount: postProvider.failedAttemptCount,
    postProviderAuditEnvelopeCount: postProvider.auditEnvelopeCount,
    postProviderGenerationAbsent: postProvider.generationAbsent,
  }
}

/** Creates a configuration- or preflight-failure report without parsing secret data. */
function createEmptyReport(
  failures: readonly AiAssistanceLiveEvalFailureCode[],
): AiAssistanceLiveEvalReport {
  return {
    schemaVersion: 2,
    passed: false,
    journeyCount: 0,
    passedJourneyCount: 0,
    journeys: [],
    checks: {
      commitMatched: false,
      staleRevisionRejected: false,
      postProviderSourceFencePassed: false,
      decisionReplayPassed: false,
      feedbackReplayPassed: false,
      withheldDisclosurePassed: false,
      withheldPermissionChangedPassed: false,
      withheldSourceChangedPassed: false,
      withheldRetentionExpiredPassed: false,
    },
    failures: uniqueFailures(failures),
    durability: createEmptyDurabilityEvidence(),
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  }
}

/** Removes duplicate stable failure codes while preserving first-observed order. */
function uniqueFailures(
  failures: readonly AiAssistanceLiveEvalFailureCode[],
): AiAssistanceLiveEvalFailureCode[] {
  return [...new Set(failures)]
}

/** Checks whether an untrusted value is a plain string-keyed record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Runs the protected CLI sequence and returns only content-free release evidence.
 *
 * The unauthenticated commit probe always completes before credentials are sent.
 *
 * @param environment - Protected environment values read without logging them.
 * @param runtime - Optional deterministic HTTP, clock, wait, and key boundaries.
 * @returns Content-free CLI evaluation report.
 */
export async function runAiAssistanceLiveEvalCli(
  environment: Readonly<Record<string, string | undefined>>,
  runtime: AiAssistanceLiveEvaluationRuntime = {},
): Promise<AiAssistanceLiveEvalReport> {
  const apiBaseUrlValue = environment.AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL ?? ''
  const expectedCommitShaValue =
    environment.AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA ?? ''
  let apiBaseUrl: string
  let expectedCommitSha: string
  try {
    apiBaseUrl = parseAllowlistedApiBaseUrl(
      apiBaseUrlValue,
      runtime.apiBaseUrlAllowlist ?? REVIEWED_AI_ASSISTANCE_LIVE_API_BASE_URLS,
    )
    expectedCommitSha = expectedCommitShaValue.trim().toLowerCase()
    if (!FULL_COMMIT_SHA.test(expectedCommitSha)) throw new TypeError('invalid commit')
  } catch {
    return createEmptyReport(['configuration-invalid'])
  }
  const fetchLive: AiAssistanceLiveFetch = runtime.fetch ??
    ((url, init) => fetch(url, init))
  const commitCheck = await verifyDeployedCommitValues(
    apiBaseUrl,
    expectedCommitSha,
    fetchLive,
  )
  if (!commitCheck.passed) {
    return createEmptyReport([commitCheck.failure])
  }

  let fixture: unknown
  let awsRegion: string
  let durabilityTableName: string
  try {
    fixture = JSON.parse(environment.AI_ASSISTANCE_LIVE_EVAL_FIXTURE_JSON ?? '')
    parseFixture(fixture)
    awsRegion = environment.AI_ASSISTANCE_LIVE_EVAL_AWS_REGION?.trim() ?? ''
    durabilityTableName =
      environment.AI_ASSISTANCE_LIVE_EVAL_TABLE_NAME?.trim() ?? ''
    if (!AWS_REGION.test(awsRegion) || !DYNAMODB_TABLE_NAME.test(durabilityTableName)) {
      throw new TypeError('invalid durability configuration')
    }
  } catch {
    return createEmptyReport(['configuration-invalid'])
  }

  const email = environment.AI_ASSISTANCE_LIVE_EVAL_EMAIL ?? ''
  const password = environment.AI_ASSISTANCE_LIVE_EVAL_PASSWORD ?? ''
  const now = runtime.now ?? Date.now
  const accessToken = await loginSyntheticOperator(
    apiBaseUrl,
    email,
    password,
    fetchLive,
    now,
  )
  if (accessToken === undefined) {
    return createEmptyReport(['authentication-failed'])
  }
  try {
    return await evaluateAiAssistanceLive({
      apiBaseUrl,
      accessToken,
      expectedCommitSha,
      awsRegion,
      durabilityTableName,
      fixture,
    }, { ...runtime, fetch: fetchLive, now })
  } catch {
    return createEmptyReport(['transport-failed'])
  }
}

/**
 * Runs the unauthenticated commit-only workflow preflight without reading any secret input.
 *
 * @param environment - Workflow variables containing only the API URL and expected commit.
 * @param runtime - Optional deterministic HTTP boundary for tests.
 * @returns Whether the deployed API reports the exact expected commit.
 */
export async function runAiAssistanceLiveCommitPreflight(
  environment: Readonly<Record<string, string | undefined>>,
  runtime: Pick<AiAssistanceLiveEvaluationRuntime, 'fetch' | 'apiBaseUrlAllowlist'> = {},
): Promise<boolean> {
  let apiBaseUrl: string
  let expectedCommitSha: string
  try {
    apiBaseUrl = parseAllowlistedApiBaseUrl(
      environment.AI_ASSISTANCE_LIVE_EVAL_API_BASE_URL ?? '',
      runtime.apiBaseUrlAllowlist ?? REVIEWED_AI_ASSISTANCE_LIVE_API_BASE_URLS,
    )
    expectedCommitSha = (
      environment.AI_ASSISTANCE_LIVE_EVAL_EXPECTED_COMMIT_SHA ?? ''
    ).trim().toLowerCase()
    if (!FULL_COMMIT_SHA.test(expectedCommitSha)) throw new TypeError('invalid commit')
  } catch {
    return false
  }
  const fetchLive: AiAssistanceLiveFetch = runtime.fetch ??
    ((url, init) => fetch(url, init))
  const result = await verifyDeployedCommitValues(
    apiBaseUrl,
    expectedCommitSha,
    fetchLive,
  )
  return result.passed
}

/** Reads protected environment input and emits only the selected stable process result. */
async function main(): Promise<void> {
  if (process.argv.includes('--commit-preflight')) {
    const passed = await runAiAssistanceLiveCommitPreflight(process.env)
    if (!passed) process.exitCode = 1
    return
  }
  const report = await runAiAssistanceLiveEvalCli(process.env)
  console.info(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
}

/** Authenticates the synthetic operator only after the unauthenticated commit probe passes. */
async function loginSyntheticOperator(
  apiBaseUrl: string,
  emailValue: string,
  password: string,
  fetchLive: AiAssistanceLiveFetch,
  now: () => number,
): Promise<string | undefined> {
  const email = emailValue.trim()
  if (
    !email || email.length > 320 ||
    !password || password.length > 4_096
  ) return undefined
  try {
    const response = await requestJson(
      apiBaseUrl,
      '/api/auth/login',
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
      fetchLive,
      15_000,
    )
    if (response.status !== 200 || !isRecord(response.body)) return undefined
    const accessToken = response.body.accessToken
    const tokenType = response.body.tokenType
    const expiresAt = response.body.expiresAt
    const currentTime = now()
    if (
      typeof accessToken !== 'string' || !accessToken || accessToken.length > 16_384 ||
      /\s/.test(accessToken) ||
      typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer' ||
      typeof expiresAt !== 'number' ||
      !Number.isFinite(expiresAt) ||
      expiresAt < currentTime + MIN_ACCESS_TOKEN_VALIDITY_MS ||
      expiresAt > currentTime + MAX_ACCESS_TOKEN_VALIDITY_MS
    ) return undefined
    return accessToken
  } catch {
    return undefined
  }
}

if (import.meta.main) await main()
