import type {
  AiAssistanceCitation,
  AiAssistanceDraft,
  AiAssistanceGeneration,
  AiAssistancePolicy,
  AiAssistancePreference,
  AiAssistanceTask,
  AiAssistanceUncertainty,
  AiAssistanceUsage,
  CustomFieldDefinition,
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
  /** Immutable authenticated principal identifier reserved for audit attribution. */
  actorId: string
  /** Canonical audit classification of the authenticated principal. */
  auditActorKind: 'user' | 'service' | 'break-glass'
  /** Safe request trace identifier. */
  traceId: string
  /** Whether the current operator may update Workspace AI policy. */
  canManagePolicy: boolean
}

/** One permission-filtered Team, Project, and assignee routing combination. */
export type AiAssistanceTriageRoutingTuple = {
  /** Team that owns the proposed triage destination. */
  teamId: string
  /** Optional Team-qualified Project in the proposed destination. */
  projectId?: string
  /** Active non-guest members eligible for the destination. */
  assigneeUserIds: readonly string[]
}

/** Current Team and Project routing resolved from the selected triage source. */
export type AiAssistanceTriageSourceRouting = {
  /** Team that currently owns the selected triage source. */
  teamId: string
  /** Project currently selected by the source routing, when present. */
  projectId?: string
}

/** One persisted predecessor/successor edge in the current Planning graph. */
export type AiAssistancePlanningDependency = {
  /** Work Item that must precede the successor. */
  predecessor: WorkItemDependencyEndpoint
  /** Work Item whose schedule is constrained by the predecessor. */
  successor: WorkItemDependencyEndpoint
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
  /** Work Item Type identifiers visible to the current operator. */
  workItemTypeIds: readonly string[]
  /** Custom field identifiers visible to the current operator. */
  customFieldIds: readonly string[]
  /** Team-scoped writable custom-field definitions used for model-output validation. */
  customFieldDefinitions?: readonly AiAssistanceCustomFieldDefinition[]
  /** Relation identifiers visible to the current operator. */
  relationIds: readonly string[]
  /** Workflow status identifiers visible to the current operator. */
  statuses: readonly string[]
  /** Work Item endpoints visible to the current operator. */
  workItemEndpoints: readonly WorkItemDependencyEndpoint[]
  /** Persisted Planning edges used to reject duplicate edges and cycles across the whole graph. */
  existingPlanningDependencies?: readonly AiAssistancePlanningDependency[]
  /** Compatible triage routing combinations used to validate tuple semantics. */
  triageRoutingTuples?: readonly AiAssistanceTriageRoutingTuple[]
}

/** Team-scoped custom-field metadata accepted at the AI output boundary. */
export type AiAssistanceCustomFieldDefinition = {
  /** Team that owns the custom field definition. */
  teamId: string
  /** Custom field definition identifier. */
  fieldId: string
  /** Canonical Work Item custom-field value type. */
  type: CustomFieldDefinition['type']
  /** Whether the field must retain a value on Work Item adoption. */
  required: boolean
  /** Project scope; omitted or empty means every Project in the Team. */
  projectIds?: readonly string[]
  /** Select option identifiers accepted by this definition. */
  optionIds?: readonly string[]
  /** Canonical numeric and length constraints enforced by the Work Item boundary. */
  validation?: CustomFieldDefinition['validation']
  /** Currency code used by currency fields, when configured. */
  currencyCode?: string
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
  /** Current source routing used to resolve Team- and Project-scoped fields. */
  triageSourceRouting?: AiAssistanceTriageSourceRouting
  /** Source-of-truth conditions that must hold in the generation/decision write. */
  authorizationConditions?: readonly AiAssistanceAuthorizationCondition[]
}

/** Maximum unique source fences that fit beside four fixed generation transaction items. */
export const AI_ASSISTANCE_MAX_GENERATION_AUTHORIZATION_CONDITIONS = 96

/** One source-of-truth persistence row checked at an AI commit boundary. */
export type AiAssistanceAuthorizationCondition = {
  /** Semantic source used for safe transaction-failure classification. */
  kind:
    | 'workspace-member'
    | 'planning'
    | 'document-authorization'
    | 'enterprise-control'
    | 'project-membership'
    | 'directory-reference'
    | 'work-item-configuration'
    | 'source'
  /** Physical persistence table resolved by the composition boundary. */
  tableName: string
  /** Canonical primary-key values for the source-of-truth row. */
  key: Readonly<Record<string, string>>
  /** Exact scalar attributes that must remain unchanged through the commit. */
  expectedAttributes: Readonly<Record<string, string | number | boolean>>
  /** Attributes that must remain absent, such as a logical archive marker. */
  expectedAbsentAttributes?: readonly string[]
  /** Allows an absent row when the expected generation is zero. */
  allowMissingWhenExpectedZero?: boolean
}

/** Current state of a previously captured authorization snapshot. */
export type AiAssistanceAuthorizationState =
  | {
      /** The snapshot is still current for this operator. */
      current: true
      /** Fresh source-of-truth rows to include in a subsequent atomic commit. */
      authorizationConditions?: readonly AiAssistanceAuthorizationCondition[]
    }
  | {
      /** The snapshot is no longer current. */
      current: false
      /** Safe reason used to withhold generated content. */
      reason: 'permission-changed' | 'source-changed'
  }

/** Commit-time authorization values checked inside the policy CAS transaction. */
export type AiAssistancePolicyAuthorizationFence = {
  /** Active Workspace member version observed during fresh authentication. */
  workspaceMemberVersion: number
  /** Workspace role observed during fresh authentication. */
  workspaceRole: string
  /** Authenticated principal kind used to select the authoritative commit fence. */
  principalKind?: 'member' | 'service-account' | 'break-glass'
  /** Enterprise CONTROL revision when custom permissions participate in authorization. */
  enterpriseControlRevision?: number
}

/** Rechecks current Workspace management authorization at the policy write boundary. */
export type AiAssistancePolicyAuthorization = {
  /**
   * Reads current membership and management permission without relying on the initial actor snapshot.
   *
   * @returns Whether the actor may still update the Workspace AI policy.
   */
  isCurrent(): Promise<boolean>
  /**
   * Returns the fresh membership and Enterprise revision fence for an atomic policy write.
   *
   * @returns Commit-time authorization values, or undefined when management access is lost.
   */
  getCommitFence?(): Promise<AiAssistancePolicyAuthorizationFence | undefined>
}

/** Immutable policy transition supplied to the Workspace audit boundary. */
export type AiAssistancePolicyAuditInput = {
  /** Workspace whose AI governance policy changed. */
  workspaceId: string
  /** Mutable Workspace member key used to bind the policy write condition. */
  memberId: string
  /** Immutable authenticated principal who performed the policy mutation. */
  actorId: string
  /** Canonical audit classification of the principal who performed the mutation. */
  actorKind: 'user' | 'service' | 'break-glass'
  /** Policy observed before the revision-fenced write. */
  previousPolicy: AiAssistancePolicy
  /** Policy accepted by the revision-fenced write. */
  nextPolicy: AiAssistancePolicy
}

/** Append-only audit boundary for successful AI policy mutations. */
export type AiAssistancePolicyAudit = {
  /**
   * Persists one immutable policy transition.
   *
   * @param input - Actor, Workspace, and before/after policy snapshots.
   * @returns A promise that resolves after the audit event is durable.
   */
  record(input: AiAssistancePolicyAuditInput): Promise<void>
  /**
   * Persists the policy and audit event through one adapter-owned transaction when available.
   *
   * @param input - Actor, Workspace, and before/after policy snapshots.
   * @param expectedRevision - Policy revision supplied by the operator.
   * @param authorizationFence - Fresh membership and Enterprise values for commit conditions.
   * @param write - Fallback revision-fenced policy write for non-transactional adapters.
   * @returns The policy accepted by the persistence boundary.
   */
  persist?(
    input: AiAssistancePolicyAuditInput,
    expectedRevision: number,
    authorizationFence: AiAssistancePolicyAuthorizationFence,
    write: () => Promise<AiAssistancePolicy>,
  ): Promise<AiAssistancePolicy>
}

/** Input supplied to the server-owned source authorization resolver. */
export type ResolveAiAssistanceContextInput = {
  /** Current authenticated operator. */
  actor: AiAssistanceActor
  /** Strictly validated generation request. */
  request: GenerateAiAssistanceRequest
  /** Optional canonical draft whose selected identifiers require commit-time fencing. */
  draft?: AiAssistanceDraft
}

/** Input supplied when rechecking a captured authorization snapshot. */
export type CheckAiAssistanceAuthorizationInput = {
  /** Current authenticated operator. */
  actor: AiAssistanceActor
  /** Original validated generation request. */
  request: GenerateAiAssistanceRequest
  /** Opaque authorization token returned by the resolver. */
  authorizationToken: string
  /** Optional canonical draft whose selected identifiers require commit-time fencing. */
  draft?: AiAssistanceDraft
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
  /** Reads current actor authorization rows for a preference commit. */
  getActorAuthorizationConditions?(): Promise<readonly AiAssistanceAuthorizationCondition[]>
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
  /**
   * Persists the exact provider-dispatch marker after the provider runner has
   * been invoked and before its result may be processed.
   */
  onProviderDispatch(): Promise<void>
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

/** Bounded outcomes emitted for one AI generation request. */
export type AiAssistanceGenerationRequestOutcome =
  | 'succeeded'
  | 'replayed'
  | 'failed'

/** Bounded outcomes emitted for one durable provider-boundary attempt. */
export type AiAssistanceProviderAttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'throttled'
  | 'timeout'
  | 'refused'
  | 'invalid-output'
  | 'indeterminate'

/** Safe metadata recorded after one generation request completes. */
export type AiAssistanceGenerationRequestObservation = {
  /** Requested product workflow. */
  task: AiAssistanceTask
  /** Bounded terminal request outcome. */
  outcome: AiAssistanceGenerationRequestOutcome
  /** End-to-end service latency in milliseconds. */
  latencyMs: number
  /** Whether the response or stable failure came from a durable idempotency receipt. */
  replayed: boolean
  /** Stable error category for a failed request. */
  failureCategory?: AiAssistanceErrorCategory
  /** Stable error code for a failed request. */
  failureCode?: AiAssistanceErrorCode
}

/** Safe metadata recorded only after one provider-boundary attempt is durably terminal. */
export type AiAssistanceProviderAttemptObservation = {
  /** Requested product workflow. */
  task: AiAssistanceTask
  /** Exact deployment-allowlisted model identifier. */
  modelId: string
  /** Bounded terminal provider-attempt outcome. */
  outcome: AiAssistanceProviderAttemptOutcome
  /** Non-negative provider latency, absent when crash recovery cannot determine it. */
  latencyMs?: number
  /** Provider-reported usage and deployment-side cost estimate, when available. */
  usage?: AiAssistanceUsage
  /** Stable reason provider usage or one of its billing fields was unavailable. */
  usageUnavailableReason?:
    | 'provider-did-not-report'
    | 'token-or-cost-missing'
    | 'attempt-outcome-indeterminate'
  /** Stable error category for a failed attempt. */
  failureCategory?: AiAssistanceErrorCategory
  /** Stable error code for a failed attempt. */
  failureCode?: AiAssistanceErrorCode
}

/** Safe metadata recorded after one new human decision is durable. */
export type AiAssistanceDecisionObservation = {
  /** Product workflow whose draft was reviewed. */
  task: AiAssistanceTask
  /** Durable human review outcome. */
  outcome: 'approved' | 'rejected'
}

/** Failure-isolated operational observation boundary for AI assistance. */
export interface AiAssistanceObservability {
  /** Records one completed generation request without identifiers or content. */
  recordGenerationRequest(
    observation: AiAssistanceGenerationRequestObservation,
  ): void
  /** Records one provider attempt after its terminal receipt update is durable. */
  recordProviderAttempt(
    observation: AiAssistanceProviderAttemptObservation,
  ): void
  /** Records one newly persisted human review decision. */
  recordDecision(observation: AiAssistanceDecisionObservation): void
}

/** Operational observation boundary used by the terminal-row stream projection. */
export interface AiAssistanceProjectionObservability
  extends AiAssistanceObservability {
  /**
   * Records rows returned for partial-batch retry without identifiers or content.
   *
   * @param failureCount Number of failed records in the completed invocation batch.
   */
  recordProjectionFailures(failureCount: number): void
}

/** Generation response together with transport-safe idempotency metadata. */
export type AiAssistanceGenerationExecution = {
  /** Generated or durably replayed draft. */
  generation: AiAssistanceGeneration
  /** Whether this response came from an existing durable receipt. */
  replayed: boolean
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

/** Durable decision write result used to distinguish a new commit from reconciliation. */
export type AiAssistanceDecisionStoreResult = {
  /** Current durable generation after the requested decision. */
  record: StoredAiAssistanceGeneration
  /** Whether an identical decision already existed or won a concurrent race. */
  replayed: boolean
}

/** Durable feedback write result exposed to the idempotency-aware transport. */
export type AiAssistanceFeedbackWriteResult = {
  /** Whether an identical feedback record already existed. */
  replayed: boolean
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

/** Input used to classify an existing generation receipt without charging a new budget. */
export type ReadAiAssistanceGenerationReservationInput = {
  /** Workspace partition that owns the receipt. */
  workspaceId: string
  /** Member identity bound to the receipt. */
  memberId: string
  /** Original client idempotency key used to locate the receipt. */
  idempotencyKey: string
  /** Canonical operation/input fingerprint used to reject key reuse with different input. */
  inputFingerprint: string
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
      /** ISO retention deadline copied from the durable idempotency receipt. */
      expiresAt?: string
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
      /** ISO retention deadline copied from the durable idempotency receipt. */
      expiresAt?: string
    }
  | {
      /** The same semantic generation is currently in progress. */
      status: 'pending'
      /** Reserved generation identifier, used for crash recovery checks. */
      generationId: string
      /** ISO instant after which a started attempt may be failed without recalling the provider. */
      leaseExpiresAt: string
      /** ISO retention deadline copied from the durable idempotency receipt. */
      expiresAt?: string
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

/** Policy and member-preference revisions fenced at generation persistence. */
export type AiAssistanceGenerationCommitFence = {
  /** Workspace AI policy revision observed after provider completion. */
  policyRevision: number
  /** Member AI preference revision observed after provider completion. */
  preferenceRevision: number
  /** Opaque source authorization snapshot rechecked immediately before persistence. */
  authorizationToken: string
  /** Source-of-truth rows checked atomically with the generation write. */
  authorizationConditions?: readonly AiAssistanceAuthorizationCondition[]
}

/** Policy, member-preference, and effective retention values fenced at decision persistence. */
export type AiAssistanceDecisionCommitFence = {
  /** Workspace AI policy revision observed immediately before the decision write. */
  policyRevision: number
  /** Member AI preference revision observed immediately before the decision write. */
  preferenceRevision: number
  /** Effective generation deadline computed from the current policy. */
  effectiveExpiresAt: string
  /** ISO 8601 instant at which the decision write crossed the application boundary. */
  commitAt: string
  /** Opaque source authorization snapshot rechecked immediately before the decision write. */
  authorizationToken: string
  /** Source-of-truth rows checked atomically with the decision write. */
  authorizationConditions?: readonly AiAssistanceAuthorizationCondition[]
}

/** Policy revision and effective retention deadline fenced at feedback persistence. */
export type AiAssistanceFeedbackCommitFence = {
  /** Workspace AI policy revision observed immediately before the feedback write. */
  policyRevision: number
  /** Effective generation deadline computed from the current policy. */
  effectiveExpiresAt: string
  /** ISO 8601 instant used to reject feedback that expires before the write boundary. */
  commitAt: string
  /** Source-of-truth rows that must still authorize the feedback actor at commit time. */
  authorizationConditions?: readonly AiAssistanceAuthorizationCondition[]
}

/** Provider attempt metadata persisted after pre-provider fences and before any paid model call. */
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

/** Provider dispatch marker persisted after the provider runner is invoked. */
export type MarkAiAssistanceGenerationProviderStartedInput =
  CompleteAiAssistanceGenerationReservationInput & {
    /** Exact admission marker timestamp already stored on the owning attempt. */
    attemptStartedAt: string
    /** ISO 8601 instant sampled immediately after provider runner invocation. */
    providerStartedAt: string
  }

/** Terminal provider attempt outcome persisted on the owning idempotency receipt. */
export type FinalizeAiAssistanceGenerationAttemptInput =
  CompleteAiAssistanceGenerationReservationInput & {
    /** Whether the full generation pipeline succeeded or failed. */
    outcome: 'succeeded' | 'failed'
    /** ISO 8601 instant when the attempt reached a terminal outcome. */
    endedAt: string
    /** Measured provider latency, absent only when dispatch outcome is indeterminate. */
    latencyMs?: number
    /** Provider-reported usage and deployment-side cost estimate when available. */
    usage?: AiAssistanceUsage
    /** Safe reason provider usage was unavailable for a failed attempt. */
    usageUnavailableReason?:
      | 'provider-did-not-report'
      | 'attempt-outcome-indeterminate'
    /** Provider or Mastra trace identifier when available. */
    providerTraceId?: string
    /** Provider-specific outcome, omitted when no paid provider call was known to start. */
    providerOutcome?: AiAssistanceProviderAttemptOutcome
    /** Safe stable error category for a failed attempt. */
    failureCategory?: AiAssistanceErrorCategory
    /** Safe stable error code for a failed attempt. */
    failureCode?: AiAssistanceErrorCode
  }

/** Lease-expiry recovery input for one crashed started generation attempt. */
export type ExpireAiAssistanceGenerationAttemptInput =
  CompleteAiAssistanceGenerationReservationInput & {
    /** ISO instant at or after the durable attempt lease deadline. */
    failedAt: string
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
  /** Strongly reads an existing receipt before policy gates for a new provider call or pending-attempt repair. */
  readGenerationReservation(
    input: ReadAiAssistanceGenerationReservationInput,
  ): Promise<AiAssistanceGenerationReservation | undefined>
  /** Reserves an operation/member/input-bound idempotency key before inference. */
  reserveGeneration(
    input: ReserveAiAssistanceGenerationInput,
  ): Promise<AiAssistanceGenerationReservation>
  /** Persists safe attempt metadata after pre-provider fences and before provider execution. */
  startGenerationAttempt(
    input: StartAiAssistanceGenerationAttemptInput,
  ): Promise<void>
  /**
   * Marks provider dispatch through an exact receipt CAS before result handling.
   *
   * @param input - Owning receipt identity and post-invocation timestamp.
   * @returns Completion after the durable provider dispatch marker is reconciled.
   */
  markGenerationProviderStarted(
    input: MarkAiAssistanceGenerationProviderStartedInput,
  ): Promise<void>
  /** Finalizes one provider attempt and its receipt after success or failure. */
  finalizeGenerationAttempt(
    input: FinalizeAiAssistanceGenerationAttemptInput,
  ): Promise<void>
  /**
   * Repairs a started receipt when terminal finalization failed after provider execution.
   *
   * @param input - Safe terminal failure metadata and receipt identity.
   * @returns A promise that resolves once a terminal recovery marker is durable.
   */
  recoverGenerationAttempt?(
    input: FinalizeAiAssistanceGenerationAttemptInput,
  ): Promise<void>
  /**
   * Fails one expired started attempt through a receipt CAS without invoking the provider.
   *
   * @param input - Receipt identity and lease-expiry recovery instant.
   * @returns Current terminal or pending receipt classification after reconciliation.
   */
  expireGenerationAttempt(
    input: ExpireAiAssistanceGenerationAttemptInput,
  ): Promise<AiAssistanceGenerationReservation>
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
    authorizationConditions?: readonly AiAssistanceAuthorizationCondition[],
  ): Promise<AiAssistancePreference>
  /** Creates one immutable generation record. */
  createGeneration(
    record: StoredAiAssistanceGeneration,
    commitFence?: AiAssistanceGenerationCommitFence,
  ): Promise<StoredAiAssistanceGeneration>
  /**
   * Atomically creates one generation and terminalizes its owning provider receipt.
   *
   * @param record - Canonical generation row to persist.
   * @param completion - Successful provider-attempt accounting and receipt identity.
   * @param commitFence - Governance and source authorization conditions checked in the transaction.
   * @returns The newly committed or exactly reconciled generation.
   */
  commitGeneration(
    record: StoredAiAssistanceGeneration,
    completion: FinalizeAiAssistanceGenerationAttemptInput,
    commitFence: AiAssistanceGenerationCommitFence,
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
    commitFence?: AiAssistanceDecisionCommitFence,
  ): Promise<AiAssistanceDecisionStoreResult>
  /** Appends immutable bounded feedback. */
  putFeedback(
    record: StoredAiAssistanceFeedback,
    commitFence?: AiAssistanceFeedbackCommitFence,
  ): Promise<AiAssistanceFeedbackWriteResult>
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
  /** Optional append-only audit boundary for successful policy transitions. */
  policyAudit?: AiAssistancePolicyAudit
  /** Optional failure-isolated operational observation boundary. */
  observability?: AiAssistanceObservability
  /** Maximum permission-safe source context length. */
  maxPromptContextCharacters?: number
  /** Maximum provider output tokens. */
  maxOutputTokens?: number
  /** Maximum provider call duration. */
  providerTimeoutMs?: number
  /** End-to-end generation deadline, including source resolution and persistence headroom. */
  generationDeadlineMs?: number
  /** Duration of one in-flight reservation, including post-deadline recovery headroom. */
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
  /**
   * Updates the Workspace policy after manager and deployment checks.
   *
   * @param actor - Authenticated Workspace actor requesting the policy change.
   * @param request - Strictly validated policy update with the expected revision.
   * @param authorization - Fresh management authorization fence for the commit.
   * @returns The persisted effective Workspace policy.
   */
  updatePolicy(
    actor: AiAssistanceActor,
    request: UpdateAiAssistancePolicyRequest,
    authorization: AiAssistancePolicyAuthorization,
  ): Promise<AiAssistancePolicy>
  /** Reads the effective current-member preference. */
  getPreference(actor: AiAssistanceActor): Promise<AiAssistancePreference>
  /** Updates the current-member preference. */
  updatePreference(
    actor: AiAssistanceActor,
    request: UpdateAiAssistancePreferenceRequest,
    authorization?: AiAssistanceAuthorizationCallbacks,
  ): Promise<AiAssistancePreference>
  /**
   * Generates, validates, reauthorizes, and persists one draft.
   *
   * @param actor - Authenticated Workspace member requesting the draft.
   * @param request - Strictly validated generation request.
   * @param authorization - Source resolver and current-authorization callbacks.
   * @param idempotencyKey - Client key bound to the generation fingerprint.
   * @param requestStartedAtMs - Optional HTTP request-boundary epoch timestamp.
   * @returns The generated draft, projected through the final authorization check.
   */
  generate(
    actor: AiAssistanceActor,
    request: GenerateAiAssistanceRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
    idempotencyKey: string,
    requestStartedAtMs?: number,
  ): Promise<AiAssistanceGeneration>
  /**
   * Generates one draft while exposing durable replay metadata to transports.
   *
   * @param actor - Authenticated Workspace member requesting the draft.
   * @param request - Strictly validated generation request.
   * @param authorization - Source resolver and current-authorization callbacks.
   * @param idempotencyKey - Client key bound to the generation fingerprint.
   * @param requestStartedAtMs - Optional HTTP request-boundary epoch timestamp.
   * @returns Generated draft and whether it was served from a durable receipt.
   */
  generateWithMetadata(
    actor: AiAssistanceActor,
    request: GenerateAiAssistanceRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
    idempotencyKey: string,
    requestStartedAtMs?: number,
  ): Promise<AiAssistanceGenerationExecution>
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
  /**
   * Records immutable quality feedback after rechecking the actor authorization boundary.
   *
   * @param actor - Authenticated Workspace member submitting feedback.
   * @param generationId - Generation that receives the feedback.
   * @param request - Strictly validated feedback payload.
   * @param authorization - Current source and actor authorization callbacks.
   * @param idempotencyKey - Client key bound to the feedback identity.
   * @returns Durable feedback write metadata for the response header.
   */
  createFeedback(
    actor: AiAssistanceActor,
    generationId: string,
    request: CreateAiAssistanceFeedbackRequest,
    authorization: AiAssistanceAuthorizationCallbacks,
    idempotencyKey: string,
  ): Promise<AiAssistanceFeedbackWriteResult>
}
