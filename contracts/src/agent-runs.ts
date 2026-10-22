import type { PublicWorkItem, UpdatePublicWorkItemRequest } from './developer-platform'

/** Schema version of the Agent Run contract. */
export const AGENT_RUN_SCHEMA_VERSION = 1

/** Schema version of the Team Agent settings contract. */
export const AGENT_SETTINGS_SCHEMA_VERSION = 1

/** Client runtimes that can own an Agent Run. */
export const AGENT_RUN_RUNTIMES = ['claude-code', 'codex', 'kiro', 'other'] as const

/** Client runtime that drives one coding agent instance. */
export type AgentRunRuntime = (typeof AGENT_RUN_RUNTIMES)[number]

/** Lifecycle state of an Agent Run. Stalled runs stay `active` and are derived at read time. */
export type AgentRunState = 'active' | 'finished'

/** Outcomes an agent may choose when it closes its own run. */
export const AGENT_RUN_FINISH_OUTCOMES = ['completed', 'paused', 'failed'] as const

/** Outcome an agent records when it closes its own run. */
export type AgentRunFinishOutcome = (typeof AGENT_RUN_FINISH_OUTCOMES)[number]

/** Reason an Agent Run reached the `finished` state. */
export type AgentRunOutcome = AgentRunFinishOutcome | 'released' | 'superseded'

/** Default lease length in minutes for new runs. */
export const AGENT_RUN_DEFAULT_LEASE_MINUTES = 30

/** Shortest lease length in minutes that a Team may configure. */
export const AGENT_RUN_MIN_LEASE_MINUTES = 5

/** Longest lease length in minutes that a Team may configure. */
export const AGENT_RUN_MAX_LEASE_MINUTES = 240

/** Minimum number of seconds between two explicit heartbeats for one run. */
export const AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS = 10

/** Maximum length of the display name an agent reports. */
export const AGENT_RUN_AGENT_NAME_MAX_LENGTH = 64

/** Maximum length of the opaque instance identifier a client sends before hashing. */
export const AGENT_RUN_INSTANCE_ID_MAX_LENGTH = 256

/**
 * Stable reasons reported in `ApiProblem.errors[].code` when an Agent Run fence rejects a request.
 *
 * The problem `code` stays one of the generic Public API codes so that existing clients keep working.
 */
export const AGENT_RUN_PROBLEM_REASONS = [
  'agent_run_conflict',
  'agent_run_not_active',
  'agent_run_forbidden',
  'invalid_transition',
] as const

/** Stable Agent Run fence reason carried in a problem violation code. */
export type AgentRunProblemReason = (typeof AGENT_RUN_PROBLEM_REASONS)[number]

/** One claim of a Work Item by one agent instance, from start until finish or release. */
export type AgentRun = {
  /** Agent Run contract schema version. */
  schemaVersion: typeof AGENT_RUN_SCHEMA_VERSION
  /** Server-assigned run ID, `run_` followed by a UUID. */
  runId: string
  /** Team that owns the claimed Work Item. */
  teamId: string
  /** Claimed Work Item ID within the Team. */
  workItemId: string
  /** Workspace member who was responsible for the Work Item when the run started. */
  assigneeUserId: string
  /** Client runtime that drives the agent. */
  runtime: AgentRunRuntime
  /** Display name the agent reported. */
  agentName: string
  /** Current lifecycle state. */
  state: AgentRunState
  /** Reason the run finished; present only when `state` is `finished`. */
  outcome?: AgentRunOutcome
  /** Work Item revision produced by the start transition. */
  startRevision: number
  /** Lease length fixed when the run started. */
  leaseMinutes: number
  /** UTC ISO 8601 time the run started. */
  startedAt: string
  /** UTC ISO 8601 time of the latest heartbeat or fenced mutation. */
  lastHeartbeatAt: string
  /** UTC ISO 8601 time after which an active run is reported as stalled. */
  leaseExpiresAt: string
  /** True when the run is active and its lease has expired at read time. */
  stalled: boolean
  /** UTC ISO 8601 time the run finished. */
  finishedAt?: string
  /** `agent` when the agent closed the run, otherwise the member who released it. */
  finishedBy?: string
  /** Number of structured reports saved for the run. */
  reportCount: number
}

/** Agent Run as returned to the Web application, with actions the viewer may take. */
export type AgentRunView = AgentRun & {
  /** True when the viewer may release this active run. */
  canRelease: boolean
}

/** Request body that claims a Work Item and moves it to a started status. */
export type StartAgentRunRequest = {
  /** Work Item revision the agent read before deciding to start. */
  expectedRevision: number
  /** Started-category workflow status the Work Item moves to. */
  workflowStatusId: string
  /** Client runtime that drives the agent. */
  runtime: AgentRunRuntime
  /** Display name of the agent. */
  agentName: string
  /** Opaque, stable identifier of the agent instance; the server stores only its hash. */
  instanceId: string
}

/** Response of a successful Agent Run start. */
export type StartAgentRunResponse = {
  /** Newly started run. */
  run: AgentRun
  /** Work Item after the start transition, in the Public API projection. */
  workItem: PublicWorkItem
}

/** Request body that closes an agent's own run. */
export type FinishAgentRunRequest = {
  /** Reason the agent is closing the run. */
  outcome: AgentRunFinishOutcome
}

/** Optional Agent Run fence attached to Work Item mutations made by an agent. */
export type AgentRunMutationFence = {
  /** Active run of the caller for the mutated Work Item. */
  agentRunId?: string
  /** Opaque instance identifier of the caller; the server compares only its hash. */
  agentInstanceId?: string
}

/** Public Work Item patch that an agent sends together with its run fence. */
export type AgentFencedWorkItemUpdateRequest = UpdatePublicWorkItemRequest & AgentRunMutationFence

/** Public comment body that an agent sends together with its run fence. */
export type AgentFencedCommentRequest = AgentRunMutationFence & {
  /** Comment text. */
  body: string
}

/** Team configuration that controls how agents claim work. */
export type AgentSettings = {
  /** Agent settings contract schema version. */
  schemaVersion: typeof AGENT_SETTINGS_SCHEMA_VERSION
  /** Team the settings belong to. */
  teamId: string
  /** Optimistic concurrency revision; `0` means the defaults have never been saved. */
  revision: number
  /** Lease length in minutes for new runs. */
  leaseMinutes: number
  /** Whether another instance of the same assignee may take over a stalled run. */
  allowTakeoverAfterLeaseExpiry: boolean
  /** UTC ISO 8601 time of the last saved change. */
  updatedAt?: string
  /** Member key of the last editor. */
  updatedBy?: string
}

/** Request body that replaces the Team Agent settings. */
export type UpdateAgentSettingsRequest = {
  /** Revision read before editing; `0` when no settings were saved yet. */
  expectedRevision: number
  /** Lease length in minutes for new runs. */
  leaseMinutes: number
  /** Whether another instance of the same assignee may take over a stalled run. */
  allowTakeoverAfterLeaseExpiry: boolean
}

/** Agent Run history of one Work Item for the Web application. */
export type WorkItemAgentRunsResponse = {
  /** Runs, newest first. */
  items: AgentRunView[]
  /** Opaque continuation for the next page. */
  nextCursor?: string
}
