import type {
  AiAssistanceCitation,
  AiAssistanceDraft,
  AiAssistanceGeneration,
  AiAssistancePolicy,
  AiAssistancePreference,
  AiAssistanceTask,
  AiAssistanceUncertainty,
  AiAssistanceUsage,
  CreateAiAssistanceFeedbackRequest,
  DecideAiAssistanceGenerationRequest,
  GenerateAiAssistanceRequest,
  UpdateAiAssistancePolicyRequest,
  UpdateAiAssistancePreferenceRequest,
  WorkItemDependencyEndpoint,
} from '@mukuroji/contracts'
import type {
  AiAssistanceErrorCategory,
  AiAssistanceErrorCode,
} from '../../errors'

/** Authenticated operator identity passed into the AI assistance application. */
export type AiAssistanceActor = {
  /** Active Workspace resolved from current authentication state. */
  workspaceId: string
  /** Active Workspace member key resolved by the server. */
  memberId: string
  /** Safe request trace identifier. */
  traceId: string
  /** Whether the current operator may update Workspace AI policy. */
  canManagePolicy: boolean
}

/** Current server-resolved identifiers that structured model output may reference. */
export type AiAssistanceAllowedValues = {
  /** Workspace member identifiers visible to the current operator. */
  assigneeUserIds: readonly string[]
  /** Creator identifiers visible to the current operator. */
  creatorUserIds: readonly string[]
  /** Team identifiers visible to the current operator. */
  teamIds: readonly string[]
  /** Project identifiers visible to the current operator. */
  projectIds: readonly string[]
  /** Custom field identifiers visible to the current operator. */
  customFieldIds: readonly string[]
  /** Relation identifiers visible to the current operator. */
  relationIds: readonly string[]
  /** Workflow status identifiers visible to the current operator. */
  statuses: readonly string[]
  /** Work Item endpoints visible to the current operator. */
  workItemEndpoints: readonly WorkItemDependencyEndpoint[]
}

/** Private member identifiers used only to build one provider-local alias table. */
export type AiAssistancePrivateMemberIdentifiers = {
  /** Canonical active member identifier restored only after authorization recheck. */
  memberId: string
  /** Cryptographically random non-linkable alias used only for this resolver pass. */
  providerAlias: string
  /** Human-readable identifiers that must be replaced before provider transmission. */
  identifiers: readonly string[]
}

/** Permission-filtered prompt context resolved exclusively by the application composition boundary. */
export type ResolvedAiAssistanceContext = {
  /** Bounded, redacted model context. */
  promptContext: string
  /** Permission-safe citations whose identifiers the model may reference. */
  citations: readonly AiAssistanceCitation[]
  /** Opaque bounded authorization snapshot persisted with the generation. */
  authorizationToken: string
  /** Current identifiers permitted in model output. */
  allowedValues: AiAssistanceAllowedValues
  /** Private active-member names retained only long enough to create request-local aliases. */
  privateMemberIdentifiers: readonly AiAssistancePrivateMemberIdentifiers[]
}

/** Current state of a previously captured authorization snapshot. */
export type AiAssistanceAuthorizationState =
  | {
      /** The snapshot is still current for this operator. */
      current: true
    }
  | {
      /** The snapshot is no longer current. */
      current: false
      /** Safe reason used to withhold generated content. */
      reason: 'permission-changed' | 'source-changed'
    }

/** Input supplied to the server-owned source authorization resolver. */
export type ResolveAiAssistanceContextInput = {
  /** Current authenticated operator. */
  actor: AiAssistanceActor
  /** Strictly validated generation request. */
  request: GenerateAiAssistanceRequest
}

/** Input supplied when rechecking a captured authorization snapshot. */
export type CheckAiAssistanceAuthorizationInput = {
  /** Current authenticated operator. */
  actor: AiAssistanceActor
  /** Original validated generation request. */
  request: GenerateAiAssistanceRequest
  /** Opaque authorization token returned by the resolver. */
  authorizationToken: string
}

/** Source authorization callbacks bound to the current authenticated request. */
export type AiAssistanceAuthorizationCallbacks = {
  /** Resolves source content after current permission and revision checks. */
  resolveContext(
    input: ResolveAiAssistanceContextInput,
  ): Promise<ResolvedAiAssistanceContext>
  /** Rechecks authorization after inference and before later disclosure. */
  isAuthorizationCurrent(
    input: CheckAiAssistanceAuthorizationInput,
  ): Promise<AiAssistanceAuthorizationState>
}

/** Provider request passed through the replaceable model gateway port. */
export type AiModelGenerationInput = {
  /** Selected deployment-allowlisted Bedrock model identifier. */
  modelId: string
  /** Requested product workflow. */
  task: AiAssistanceTask
  /** Requested prose locale. */
  locale: 'ja' | 'en'
  /** Versioned prompt template identifier. */
  promptVersion: string
  /** Bounded operator request serialized separately from source context. */
  request: GenerateAiAssistanceRequest
  /** Bounded and permission-filtered source context. */
  promptContext: string
  /** Citation identifiers and labels available to the model. */
  citations: readonly AiAssistanceCitation[]
  /** Current identifiers that the model may copy into structured output. */
  allowedValues: AiAssistanceAllowedValues
  /** Safe trace identifier for provider correlation. */
  traceId: string
  /** Maximum provider output token count. */
  maxOutputTokens: number
  /** Maximum complete provider call duration. */
  timeoutMs: number
}

/** Strict model result returned by the replaceable gateway. */
export type AiModelGenerationResult = {
  /** Strictly parsed task-specific draft. */
  draft: AiAssistanceDraft
  /** Strictly parsed overall uncertainty disclosure. */
  uncertainty: AiAssistanceUncertainty
  /** Provider usage and latency metadata. */
  usage: AiAssistanceUsage
  /** Provider or Mastra trace identifier when available. */
  providerTraceId?: string
}

/** Replaceable AI provider boundary used by the generation use case. */
export interface AiModelGateway {
  /**
   * Generates one structured draft without tools, memory, or autonomous mutations.
   *
   * @param input - Authorized and bounded model request.
   * @returns Strict structured draft and usage metadata.
   */
  generate(input: AiModelGenerationInput): Promise<AiModelGenerationResult>
}

/** Internal durable generation record with authorization and audit input. */
export type StoredAiAssistanceGeneration = {
  /** Workspace partition that owns the generation. */
  workspaceId: string
  /** Member who requested and may review the generation. */
  memberId: string
  /** Public generation response. */
  generation: AiAssistanceGeneration
  /** Original strictly validated request for later authorization rechecks. */
  request: GenerateAiAssistanceRequest
  /** Opaque authorization snapshot captured before inference. */
  authorizationToken: string
  /** Redacted prompt input retained under Workspace retention policy. */
  auditedInput: string
}

/** Durable feedback record used by offline evaluation. */
export type StoredAiAssistanceFeedback = {
  /** Workspace partition that owns the feedback. */
  workspaceId: string
  /** Stable feedback identifier. */
  feedbackId: string
  /** Generation receiving the feedback. */
  generationId: string
  /** Member who submitted the feedback. */
  memberId: string
  /** Strict feedback payload. */
  feedback: CreateAiAssistanceFeedbackRequest
  /** Canonical actor, generation, and redacted-payload fingerprint. */
  inputFingerprint: string
  /** ISO 8601 creation instant. */
  createdAt: string
  /** ISO 8601 retention deadline inherited from the generation. */
  expiresAt: string
}

/** Fixed-window budget reserved atomically with one unique generation key. */
export type AiAssistanceGenerationBudgetReservation = {
  /** Inclusive ISO 8601 start of the UTC-aligned one-minute window. */
  windowStartedAt: string
  /** Exclusive ISO 8601 end of the UTC-aligned one-minute window. */
  windowExpiresAt: string
  /** Conservative maximum input-plus-output tokens charged for this unique key. */
  reservedTokens: number
  /** Maximum unique generation keys accepted for the Workspace in this window. */
  workspaceGenerationLimit: number
  /** Maximum unique generation keys accepted for one member in this window. */
  memberGenerationLimit: number
  /** Maximum reserved tokens accepted for the Workspace in this window. */
  workspaceTokenLimit: number
  /** Maximum reserved tokens accepted for one member in this window. */
  memberTokenLimit: number
}

/** Input used to reserve one generation idempotency key before provider execution. */
export type ReserveAiAssistanceGenerationInput = {
  /** Workspace partition that owns the reservation. */
  workspaceId: string
  /** Member identity bound to the reservation. */
  memberId: string
  /** Untrusted client key that the adapter hashes before persistence. */
  idempotencyKey: string
  /** Canonical operation/input fingerprint. */
  inputFingerprint: string
  /** Generation identifier allocated before provider execution. */
  generationId: string
  /** ISO 8601 instant used for an atomic expired-lease comparison. */
  requestedAt: string
  /** ISO 8601 deadline after which the same input may take over a crashed reservation. */
  leaseExpiresAt: string
  /** ISO 8601 retention deadline for the receipt. */
  expiresAt: string
  /** Workspace/member budget charged only when this unique key is first reserved. */
  budget: AiAssistanceGenerationBudgetReservation
}

/** Result of an atomic generation idempotency reservation. */
export type AiAssistanceGenerationReservation =
  | {
      /** This request owns a new reservation and may invoke the provider. */
      status: 'reserved'
      /** Generation identifier bound to the reservation. */
      generationId: string
    }
  | {
      /** A previous attempt for the same semantic input failed terminally. */
      status: 'failed'
      /** Existing generation identifier whose attempt audit contains the failure. */
      generationId: string
      /** Safe stable error category replayed without invoking the provider again. */
      failureCategory: AiAssistanceErrorCategory
      /** Safe stable error code replayed without invoking the provider again. */
      failureCode: AiAssistanceErrorCode
    }
  | {
      /** A completed generation with the same semantic input already exists. */
      status: 'replay'
      /** Existing generation identifier. */
      generationId: string
    }
  | {
      /** The same semantic generation is currently in progress. */
      status: 'pending'
      /** Reserved generation identifier, used for crash recovery checks. */
      generationId: string
    }

/** Stable identity used to update one owned generation reservation. */
export type CompleteAiAssistanceGenerationReservationInput = {
  /** Workspace partition that owns the reservation. */
  workspaceId: string
  /** Member identity bound to the reservation. */
  memberId: string
  /** Original client idempotency key. */
  idempotencyKey: string
  /** Canonical input fingerprint. */
  inputFingerprint: string
  /** Generation identifier bound during reservation. */
  generationId: string
}

/** Redacted evidence retained with a provider attempt until its receipt expires. */
export type AiAssistanceGenerationAttemptAuditEnvelope = {
  /** Strictly validated request after operator-controlled prose redaction. */
  request: GenerateAiAssistanceRequest
  /** Permission-filtered and redacted source context supplied to the model. */
  auditedInput: string
  /** Permission-safe and redacted citations supplied to the model. */
  citations: readonly AiAssistanceCitation[]
}

/** Provider attempt metadata persisted before any paid model call starts. */
export type StartAiAssistanceGenerationAttemptInput =
  CompleteAiAssistanceGenerationReservationInput & {
    /** Requested AI workflow. */
    task: AiAssistanceTask
    /** Exact deployment- and policy-allowlisted model identifier. */
    modelId: string
    /** Versioned server-owned prompt template identifier. */
    promptVersion: string
    /** Safe application trace identifier. */
    traceId: string
    /** ISO 8601 instant immediately before provider invocation. */
    startedAt: string
    /** Bounded redacted request, context, and citation evidence for failed-run audit. */
    audit: AiAssistanceGenerationAttemptAuditEnvelope
  }

/** Terminal provider attempt outcome persisted on the owning idempotency receipt. */
export type FinalizeAiAssistanceGenerationAttemptInput =
  CompleteAiAssistanceGenerationReservationInput & {
    /** Whether the full generation pipeline succeeded or failed. */
    outcome: 'succeeded' | 'failed'
    /** ISO 8601 instant when the attempt reached a terminal outcome. */
    endedAt: string
    /** Non-negative measured provider latency in milliseconds. */
    latencyMs: number
    /** Provider-reported usage and deployment-side cost estimate when available. */
    usage?: AiAssistanceUsage
    /** Safe reason provider usage was unavailable for a failed attempt. */
    usageUnavailableReason?: 'provider-did-not-report'
    /** Provider or Mastra trace identifier when available. */
    providerTraceId?: string
    /** Safe stable error category for a failed attempt. */
    failureCategory?: AiAssistanceErrorCategory
    /** Safe stable error code for a failed attempt. */
    failureCode?: AiAssistanceErrorCode
  }

/** Terminal failure persisted when generation stops before a provider attempt starts. */
export type FailAiAssistanceGenerationReservationInput =
  CompleteAiAssistanceGenerationReservationInput & {
    /** ISO 8601 instant when the reserved request failed. */
    failedAt: string
    /** Safe stable error category replayed for the same idempotency key. */
    failureCategory: AiAssistanceErrorCategory
    /** Safe stable error code replayed for the same idempotency key. */
    failureCode: AiAssistanceErrorCode
  }

/** DynamoDB-independent persistence port for AI policy, runs, and feedback. */
export interface AiAssistanceStore {
  /** Reserves an operation/member/input-bound idempotency key before inference. */
  reserveGeneration(
    input: ReserveAiAssistanceGenerationInput,
  ): Promise<AiAssistanceGenerationReservation>
  /** Persists safe attempt metadata before provider execution. */
  startGenerationAttempt(
    input: StartAiAssistanceGenerationAttemptInput,
  ): Promise<void>
  /** Finalizes one provider attempt and its receipt after success or failure. */
  finalizeGenerationAttempt(
    input: FinalizeAiAssistanceGenerationAttemptInput,
  ): Promise<void>
  /** Finalizes one receipt that failed before the provider attempt started. */
  failGenerationReservation(
    input: FailAiAssistanceGenerationReservationInput,
  ): Promise<void>
  /** Reads the current Workspace policy, when explicitly configured. */
  getPolicy(workspaceId: string): Promise<AiAssistancePolicy | undefined>
  /** Persists a revision-fenced Workspace policy. */
  putPolicy(
    workspaceId: string,
    policy: AiAssistancePolicy,
    expectedRevision: number,
  ): Promise<AiAssistancePolicy>
  /** Reads a member preference, when explicitly configured. */
  getPreference(
    workspaceId: string,
    memberId: string,
  ): Promise<AiAssistancePreference | undefined>
  /** Persists a revision-fenced member preference. */
  putPreference(
    workspaceId: string,
    memberId: string,
    preference: AiAssistancePreference,
    expectedRevision: number,
  ): Promise<AiAssistancePreference>
  /** Creates one immutable generation record. */
  createGeneration(
    record: StoredAiAssistanceGeneration,
  ): Promise<StoredAiAssistanceGeneration>
  /** Strongly reads one generation by Workspace and identifier. */
  getGeneration(
    workspaceId: string,
    generationId: string,
  ): Promise<StoredAiAssistanceGeneration | undefined>
  /** Records one revision-fenced human decision. */
  decideGeneration(
    workspaceId: string,
    generationId: string,
    request: DecideAiAssistanceGenerationRequest,
    decidedAt: string,
  ): Promise<StoredAiAssistanceGeneration>
  /** Appends immutable bounded feedback. */
  putFeedback(record: StoredAiAssistanceFeedback): Promise<void>
}

/** Configuration required to construct the AI assistance application service. */
export type AiAssistanceServiceOptions = {
  /** Replaceable model gateway. */
  gateway: AiModelGateway
  /** Durable AI assistance persistence. */
  store: AiAssistanceStore
  /** Default policy returned before a Workspace policy is explicitly written. */
  defaultPolicy: AiAssistancePolicy
  /** Deployment-level Bedrock model allowlist enforced above Workspace policy. */
  deploymentAllowedModelIds: readonly string[]
  /** Prompt template version retained in every generation. */
  promptVersion: string
  /** Maximum permission-safe source context length. */
  maxPromptContextCharacters?: number
  /** Maximum provider output tokens. */
  maxOutputTokens?: number
  /** Maximum provider call duration. */
  providerTimeoutMs?: number
  /** End-to-end generation deadline, including source resolution and persistence headroom. */
  generationDeadlineMs?: number
  /** Duration of one in-flight generation reservation before crash recovery takeover. */
  reservationLeaseMs?: number
  /** Maximum unique generation keys accepted per Workspace in each UTC minute. */
  workspaceGenerationLimitPerMinute?: number
  /** Maximum unique generation keys accepted per member in each UTC minute. */
  memberGenerationLimitPerMinute?: number
  /** Maximum conservative token reservations per Workspace in each UTC minute. */
  workspaceTokenLimitPerMinute?: number
  /** Maximum conservative token reservations per member in each UTC minute. */
  memberTokenLimitPerMinute?: number
  /** Conservative input-plus-output token charge reserved for every unique key. */
  worstCaseTokensPerGeneration?: number
  /** Clock injected for deterministic tests. */
  now?: () => Date
  /** Identifier factory injected for deterministic tests. */
  createId?: () => string
}

/** Public application surface consumed by the HTTP adapter. */
export interface AiAssistanceService {
  /** Reads the effective Workspace policy. */
  getPolicy(actor: AiAssistanceActor): Promise<AiAssistancePolicy>
  /** Updates the Workspace policy after manager and deployment checks. */
  updatePolicy(
    actor: AiAssistanceActor,
    request: UpdateAiAssistancePolicyRequest,
  ): Promise<AiAssistancePolicy>
  /** Reads the effective current-member preference. */
  getPreference(actor: AiAssistanceActor): Promise<AiAssistancePreference>
  /** Updates the current-member preference. */
  updatePreference(
    actor: AiAssistanceActor,
    request: UpdateAiAssistancePreferenceRequest,
  ): Promise<AiAssistancePreference>
  /** Generates, validates, reauthorizes, and persists one draft. */
  generate(
    actor: AiAssistanceActor,
    request: GenerateAiAssistanceRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
    idempotencyKey: string,
  ): Promise<AiAssistanceGeneration>
  /** Reads a generation and withholds content when current access changed. */
  getGeneration(
    actor: AiAssistanceActor,
    generationId: string,
    authorization: AiAssistanceAuthorizationCallbacks,
  ): Promise<AiAssistanceGeneration>
  /** Records a human review decision without applying domain mutations. */
  decideGeneration(
    actor: AiAssistanceActor,
    generationId: string,
    request: DecideAiAssistanceGenerationRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
  ): Promise<AiAssistanceGeneration>
  /** Records immutable quality feedback. */
  createFeedback(
    actor: AiAssistanceActor,
    generationId: string,
    request: CreateAiAssistanceFeedbackRequest,
    idempotencyKey: string,
  ): Promise<void>
}
