import type { PlanningHealth, PlanningRisk, PlanningUpdateTarget } from './planning'
import type { ScheduleDependencyType, WorkItemDependencyEndpoint } from './schedule-dependencies'
import type { WorkspaceSearchFilters } from './search'
import type { WorkItemPriority } from './work-items'

/** Current public schema version for AI assistance resources. */
export const AI_ASSISTANCE_SCHEMA_VERSION = 1

/** Provider selected for the current AI assistance deployment. */
export type AiAssistanceProvider = 'bedrock'

/** Product workflow supported by AI assistance. */
export type AiAssistanceTask = 'triage' | 'summary' | 'search' | 'planning'

/** Confidence label shown beside an AI-generated claim or field. */
export type AiAssistanceConfidence = 'high' | 'medium' | 'low'

/** An authorized triage entry selected as model context. */
export type AiTriageEntrySource = {
  /** Source discriminator. */
  type: 'triage-entry'
  /** Team that owns the triage queue entry. */
  teamId: string
  /** Triage entry identifier in the active Workspace. */
  triageEntryId: string
  /** Revision observed by the operator before requesting assistance. */
  expectedRevision: number
}

/** An authorized Request Intake submission selected as model context. */
export type AiRequestSubmissionSource = {
  /** Source discriminator. */
  type: 'request-submission'
  /** Request form that owns the submission. */
  formId: string
  /** Request submission identifier in the active Workspace. */
  submissionId: string
  /** Revision observed by the operator before requesting assistance. */
  expectedRevision: number
}

/** An authorized Work Item selected as model context. */
export type AiWorkItemSource = {
  /** Source discriminator. */
  type: 'work-item'
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Revision observed by the operator before requesting assistance. */
  expectedRevision: number
}

/** An authorized document selected as model context. */
export type AiDocumentSource = {
  /** Source discriminator. */
  type: 'document'
  /** Document identifier in the active Workspace. */
  documentId: string
  /** Revision observed by the operator before requesting assistance. */
  expectedRevision: number
}

/** An authorized Planning target selected as model context. */
export type AiPlanningTargetSource = {
  /** Source discriminator. */
  type: 'planning-target'
  /** Project or initiative being planned. */
  target: PlanningUpdateTarget
  /** Global Planning revision observed before requesting assistance. */
  expectedRevision: number
}

/** Resource references that the server may resolve into permission-safe model context. */
export type AiAssistanceSource =
  | AiTriageEntrySource
  | AiRequestSubmissionSource
  | AiWorkItemSource
  | AiDocumentSource
  | AiPlanningTargetSource

/** Common model selection options accepted by every generation request. */
export type AiAssistanceGenerationOptions = {
  /** Optional deployment-allowlisted Bedrock model identifier. */
  modelId?: string
  /** Locale requested for generated prose. */
  locale: 'ja' | 'en'
}

/** Request for field and routing suggestions from an intake source. */
export type GenerateAiTriageDraftRequest = AiAssistanceGenerationOptions & {
  /** Requested workflow discriminator. */
  task: 'triage'
  /** Intake source that must be re-authorized by the server. */
  source: AiTriageEntrySource | AiRequestSubmissionSource
  /** Optional operator guidance that is bounded and audited by the server. */
  guidance?: string
}

/** Request for a grounded brief over one or more authorized resources. */
export type GenerateAiSummaryDraftRequest = AiAssistanceGenerationOptions & {
  /** Requested workflow discriminator. */
  task: 'summary'
  /** Resources that must be re-authorized by the server. */
  sources: AiAssistanceSource[]
  /** Optional focus supplied by the operator. */
  focus?: string
}

/** Request to translate plain language into safe Workspace search filters. */
export type GenerateAiSearchDraftRequest = AiAssistanceGenerationOptions & {
  /** Requested workflow discriminator. */
  task: 'search'
  /** Natural-language intent to translate without executing a search. */
  query: string
}

/** Request for a Work Item or status-update planning draft. */
export type GenerateAiPlanningDraftRequest = AiAssistanceGenerationOptions & {
  /** Requested workflow discriminator. */
  task: 'planning'
  /** Work Item or Planning target that must be re-authorized by the server. */
  source: AiWorkItemSource | AiPlanningTargetSource
  /** Optional operator guidance that is bounded and audited by the server. */
  guidance?: string
}

/** Discriminated request accepted by the AI generation endpoint. */
export type GenerateAiAssistanceRequest =
  | GenerateAiTriageDraftRequest
  | GenerateAiSummaryDraftRequest
  | GenerateAiSearchDraftRequest
  | GenerateAiPlanningDraftRequest

/** AI-generated value with evidence and uncertainty kept beside the proposal. */
export type AiSuggestedValue<Value> = {
  /** Proposed value that remains a draft until a human adopts it. */
  value: Value
  /** Concise rationale for the proposal. */
  reason: string
  /** Model-estimated confidence label. */
  confidence: AiAssistanceConfidence
  /** Citation identifiers supporting the proposal. */
  citationIds: string[]
}

/** Suggested value for a Workspace custom field. */
export type AiSuggestedCustomField = AiSuggestedValue<string | number | boolean | string[] | null> & {
  /** Custom field definition identifier. */
  fieldId: string
}

/** Permission-safe intake draft produced for operator review. */
export type AiTriageDraft = {
  /** Draft discriminator. */
  kind: 'triage'
  /** Suggested Work Item title. */
  title?: AiSuggestedValue<string>
  /** Suggested Work Item description. */
  description?: AiSuggestedValue<string>
  /** Suggested priority. */
  priority?: AiSuggestedValue<WorkItemPriority>
  /** Suggested Workspace assignee identifier. */
  assigneeUserId?: AiSuggestedValue<string>
  /** Suggested Team destination. */
  teamId?: AiSuggestedValue<string>
  /** Suggested Project destination. */
  projectId?: AiSuggestedValue<string>
  /** Suggested values for visible custom fields. */
  customFields: AiSuggestedCustomField[]
}

/** One grounded statement in an AI-generated brief. */
export type AiBriefItem = {
  /** Stable item identifier within the generation. */
  id: string
  /** Permission-safe generated statement. */
  text: string
  /** Model-estimated confidence label. */
  confidence: AiAssistanceConfidence
  /** Citation identifiers supporting the statement. */
  citationIds: string[]
}

/** Grounded summary for issue, activity, comment, or document review. */
export type AiSummaryDraft = {
  /** Draft discriminator. */
  kind: 'summary'
  /** Short overview of the authorized context. */
  overview: AiBriefItem
  /** Decisions found in the authorized context. */
  decisions: AiBriefItem[]
  /** Follow-up actions found in the authorized context. */
  actions: AiBriefItem[]
  /** Risks or blockers found in the authorized context. */
  risks: AiBriefItem[]
}

/** Report preview that can be applied only after explicit operator confirmation. */
export type AiSearchReportDraft = {
  /** Metric calculated from permission-filtered search results. */
  metric: 'count'
  /** Optional result field used to group the metric. */
  groupBy?: 'entityType' | 'assignee' | 'creator' | 'status' | 'project' | 'team'
}

/** Safe structured search interpretation produced without running the search. */
export type AiSearchDraft = {
  /** Draft discriminator. */
  kind: 'search'
  /** Human-readable interpretation shown before filters are applied. */
  interpretation: string
  /** Filters that can be copied into the existing search route state. */
  filters: WorkspaceSearchFilters
  /** Optional report requested by the operator. */
  report?: AiSearchReportDraft
  /** Ambiguities the operator should review before applying filters. */
  caveats: string[]
}

/** Proposed child Work Item that is never created by the model itself. */
export type AiPlanningSubtaskDraft = {
  /** Stable row identifier within the generation. */
  id: string
  /** Suggested child title. */
  title: string
  /** Suggested child description. */
  description?: string
  /** Suggested priority. */
  priority: WorkItemPriority
  /** Suggested effort in whole minutes. */
  plannedEffortMinutes?: number
  /** Concise rationale for the proposed child. */
  reason: string
  /** Model-estimated confidence label. */
  confidence: AiAssistanceConfidence
  /** Citation identifiers supporting the proposal. */
  citationIds: string[]
}

/** Proposed dependency row that must be confirmed through the existing dependency editor. */
export type AiPlanningDependencyDraft = {
  /** Stable row identifier within the generation. */
  id: string
  /** Visible predecessor Work Item. */
  predecessor: WorkItemDependencyEndpoint
  /** Visible successor Work Item. */
  successor: WorkItemDependencyEndpoint
  /** Suggested scheduling relationship. */
  type: ScheduleDependencyType
  /** Suggested signed calendar-day lead or lag. */
  lagDays: number
  /** Concise rationale for the dependency. */
  reason: string
  /** Model-estimated confidence label. */
  confidence: AiAssistanceConfidence
  /** Citation identifiers supporting the proposal. */
  citationIds: string[]
}

/** Proposed structured Planning update copied into the existing composer on adoption. */
export type AiPlanningStatusUpdateDraft = {
  /** Proposed delivery health. */
  health: PlanningHealth
  /** Proposed risk level. */
  risk: PlanningRisk
  /** Proposed executive summary. */
  summary: string
  /** Proposed risk explanation. */
  riskSummary: string
  /** Proposed decision summary. */
  decisionSummary: string
  /** Proposed request for help. */
  helpNeeded: string
  /** Proposed next action. */
  nextAction: string
  /** Model-estimated confidence label. */
  confidence: AiAssistanceConfidence
  /** Citation identifiers supporting the proposal. */
  citationIds: string[]
}

/** Planning suggestions returned for human review. */
export type AiPlanningDraft = {
  /** Draft discriminator. */
  kind: 'planning'
  /** Suggested title change for a Work Item. */
  title?: AiSuggestedValue<string>
  /** Suggested description change for a Work Item. */
  description?: AiSuggestedValue<string>
  /** Suggested priority change for a Work Item. */
  priority?: AiSuggestedValue<WorkItemPriority>
  /** Suggested configured workflow status identifier for a Work Item. */
  status?: AiSuggestedValue<string>
  /** Suggested effort in whole minutes. */
  plannedEffortMinutes?: AiSuggestedValue<number>
  /** Proposed child Work Items. */
  subtasks: AiPlanningSubtaskDraft[]
  /** Proposed dependency rows. */
  dependencies: AiPlanningDependencyDraft[]
  /** Proposed Project or Initiative update. */
  statusUpdate?: AiPlanningStatusUpdateDraft
}

/** Structured output produced by one supported AI workflow. */
export type AiAssistanceDraft = AiTriageDraft | AiSummaryDraft | AiSearchDraft | AiPlanningDraft

/** Permission-safe evidence reference constructed by the server. */
export type AiAssistanceCitation = {
  /** Generation-local citation identifier referenced by draft fields. */
  id: string
  /** Safe source category shown to the operator. */
  sourceType: AiAssistanceSource['type']
  /** Bounded source label that passed current authorization. */
  label: string
  /** Application-relative location that passed current authorization. */
  href: string
  /** Optional bounded excerpt that passed current authorization. */
  excerpt?: string
  /** Source revision captured when the prompt was constructed. */
  capturedRevision: number
}

/** Overall uncertainty disclosed for a generated draft. */
export type AiAssistanceUncertainty = {
  /** Overall confidence label across the complete draft. */
  level: AiAssistanceConfidence
  /** Concise explanation of missing, conflicting, or weak evidence. */
  reason: string
}

/** Token, latency, and cost metadata retained for audit and evaluation. */
export type AiAssistanceUsage = {
  /** Prompt tokens reported by the provider. */
  inputTokens?: number
  /** Completion tokens reported by the provider. */
  outputTokens?: number
  /** End-to-end provider latency in milliseconds. */
  latencyMs: number
  /** Provider-reported or deployment-calculated cost in USD. */
  costUsd?: number
  /** Reason a trustworthy cost amount was unavailable. */
  costUnavailableReason?: 'provider-not-reported' | 'pricing-not-configured'
}

/** Technical generation details available in the audit disclosure. */
export type AiAssistanceGenerationDetails = {
  /** Configured provider. */
  provider: AiAssistanceProvider
  /** Bedrock model identifier selected from the deployment allowlist. */
  modelId: string
  /** Versioned prompt template identifier. */
  promptVersion: string
  /** Trace identifier used to correlate observability records. */
  traceId: string
  /** Provider usage metadata. */
  usage: AiAssistanceUsage
}

/** Current availability of previously generated content. */
export type AiAssistanceContent =
  | {
      /** Content is still authorized for the current viewer. */
      availability: 'available'
      /** Structured draft returned by the model and validated by the server. */
      draft: AiAssistanceDraft
      /** Current permission-safe citations referenced by the draft. */
      citations: AiAssistanceCitation[]
      /** Overall uncertainty disclosure. */
      uncertainty: AiAssistanceUncertainty
    }
  | {
      /** Content was removed because source access or retention no longer permits disclosure. */
      availability: 'withheld'
      /** Stable reason that does not reveal protected source details. */
      reasonCode: 'permission-changed' | 'retention-expired' | 'source-changed'
    }

/** Human review decision recorded for a generated draft. */
export type AiAssistanceDecision = {
  /** Review outcome. */
  outcome: 'approved' | 'rejected'
  /** ISO 8601 instant when the decision was recorded. */
  decidedAt: string
}

/** Audited generation returned to an authorized operator. */
export type AiAssistanceGeneration = {
  /** Public schema version. */
  schemaVersion: typeof AI_ASSISTANCE_SCHEMA_VERSION
  /** Stable generation identifier. */
  id: string
  /** Workflow that produced the draft. */
  task: AiAssistanceTask
  /** Current optimistic-concurrency revision. */
  revision: number
  /** Permission-aware generated content. */
  content: AiAssistanceContent
  /** Technical details retained for audit and evaluation. */
  details: AiAssistanceGenerationDetails
  /** Human decision when one has been recorded. */
  decision?: AiAssistanceDecision
  /** ISO 8601 creation instant. */
  createdAt: string
  /** ISO 8601 retention deadline. */
  expiresAt: string
}

/** Input for recording a human decision without mutating a domain resource. */
export type DecideAiAssistanceGenerationRequest = {
  /** Decision to audit for the draft. */
  outcome: 'approved' | 'rejected'
  /** Generation revision observed during review. */
  expectedRevision: number
}

/** Input for quality feedback tied to an audited generation. */
export type CreateAiAssistanceFeedbackRequest = {
  /** Coarse usefulness rating. */
  rating: 'helpful' | 'not-helpful'
  /** Optional bounded explanation used for evaluation. */
  comment?: string
}

/** Workspace policy controlling AI availability and retention. */
export type AiAssistancePolicy = {
  /** Public schema version. */
  schemaVersion: typeof AI_ASSISTANCE_SCHEMA_VERSION
  /** Whether AI assistance is enabled for the Workspace. */
  enabled: boolean
  /** Bedrock model identifiers available to operators. */
  allowedModelIds: string[]
  /** Default Bedrock model identifier. */
  defaultModelId: string
  /** Workflows enabled by Workspace policy. */
  enabledTasks: AiAssistanceTask[]
  /** Audit record retention in whole days. */
  retentionDays: number
  /** Optimistic-concurrency revision. */
  revision: number
  /** ISO 8601 timestamp of the latest policy mutation. */
  updatedAt: string
}

/** Revision-fenced Workspace policy update. */
export type UpdateAiAssistancePolicyRequest = {
  /** Whether AI assistance should be enabled. */
  enabled: boolean
  /** Bedrock model identifiers made available to operators. */
  allowedModelIds: string[]
  /** Default model chosen from the allowlist. */
  defaultModelId: string
  /** Workflows enabled for the Workspace. */
  enabledTasks: AiAssistanceTask[]
  /** Audit record retention in whole days. */
  retentionDays: number
  /** Policy revision observed before editing. */
  expectedRevision: number
}

/** Per-member preference that can opt out of AI processing. */
export type AiAssistancePreference = {
  /** Public schema version. */
  schemaVersion: typeof AI_ASSISTANCE_SCHEMA_VERSION
  /** Whether the member allows AI assistance requests. */
  enabled: boolean
  /** Optimistic-concurrency revision. */
  revision: number
  /** ISO 8601 timestamp of the latest preference mutation. */
  updatedAt: string
}

/** Revision-fenced per-member preference update. */
export type UpdateAiAssistancePreferenceRequest = {
  /** Whether the member allows AI assistance requests. */
  enabled: boolean
  /** Preference revision observed before editing. */
  expectedRevision: number
}
