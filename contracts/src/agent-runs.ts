import type { PublicWorkItem, UpdatePublicWorkItemRequest } from './developer-platform'
import type { WorkflowStatusCategory } from './work-item-configuration'

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

/** Maximum number of workflow statuses a Team may mark as ready for agents. */
export const AGENT_SETTINGS_MAX_READY_STATUSES = 50

/** Maximum UTF-8 size in bytes of one agent brief. */
export const AGENT_SETTINGS_BRIEF_MAX_BYTES = 16 * 1024

/** Maximum number of Projects that may carry their own agent brief. */
export const AGENT_SETTINGS_MAX_PROJECT_BRIEFS = 20

/** Maximum combined UTF-8 size in bytes of the Team brief and every Project brief. */
export const AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES = 128 * 1024

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
  'agent_run_takeover_disabled',
  'invalid_artifact_url',
  'not_ready',
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

/** Request body that takes over a stalled run of another instance of the same assignee. */
export type TakeOverAgentRunRequest = {
  /** Client runtime that drives the agent taking over. */
  runtime: AgentRunRuntime
  /** Display name of the agent taking over. */
  agentName: string
  /** Opaque, stable identifier of the instance taking over; the server stores only its hash. */
  instanceId: string
}

/** Response of a successful take over. */
export type TakeOverAgentRunResponse = {
  /** New run of the instance that took over. */
  run: AgentRun
  /** Stalled run, now finished as `superseded`. */
  supersededRun: AgentRun
}

/** Request body that extends the lease of an agent's own run. */
export type HeartbeatAgentRunRequest = {
  /** Instance identifier sent when the run started; other instances cannot extend the lease. */
  instanceId: string
}

/** Request body that closes an agent's own run. */
export type FinishAgentRunRequest = {
  /** Reason the agent is closing the run. */
  outcome: AgentRunFinishOutcome
  /** Instance identifier sent when the run started; other instances cannot close the run. */
  instanceId: string
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

/** Kinds of structured report an agent records; `progress` is the default. */
export const AGENT_RUN_REPORT_KINDS = ['progress', 'blocker', 'verification', 'artifact', 'handoff'] as const

/** Kind of a structured report; `blocker` and `handoff` ask a person to decide. */
export type AgentRunReportKind = (typeof AGENT_RUN_REPORT_KINDS)[number]

/** Results an agent records for one verification command. */
export const AGENT_RUN_VERIFICATION_STATUSES = ['passed', 'failed', 'skipped'] as const

/** Result of one verification command. */
export type AgentRunVerificationStatus = (typeof AGENT_RUN_VERIFICATION_STATUSES)[number]

/** Kinds of artifact link an agent records. */
export const AGENT_RUN_ARTIFACT_TYPES = ['pull-request', 'branch', 'commit', 'url'] as const

/** Kind of one artifact link. */
export type AgentRunArtifactType = (typeof AGENT_RUN_ARTIFACT_TYPES)[number]

/** Maximum length of a report message, which becomes the comment body after the agent label. */
export const AGENT_RUN_REPORT_MESSAGE_MAX_LENGTH = 3_900

/** Maximum number of verifications, and separately of artifacts, in one report. */
export const AGENT_RUN_REPORT_MAX_ITEMS = 20

/** Maximum length of a verification command and of its summary. */
export const AGENT_RUN_VERIFICATION_TEXT_MAX_LENGTH = 512

/** Maximum length of an artifact label. */
export const AGENT_RUN_ARTIFACT_LABEL_MAX_LENGTH = 128

/** Maximum length of an artifact URL. */
export const AGENT_RUN_ARTIFACT_URL_MAX_LENGTH = 2_048

/**
 * Pattern of an artifact URL the report endpoint accepts: lowercase `https://` and a host, with no
 * userinfo, backslash, whitespace, control character, or query, and no `?` or `=` in the fragment.
 * The endpoint also requires the URL to parse with a host.
 */
export const AGENT_RUN_ARTIFACT_URL_PATTERN: string = '^https://[^/?#@\\\\\\s\\x00-\\x1F\\x7F]+(/[^?#\\\\\\s\\x00-\\x1F\\x7F]*)?(#[^?=\\\\\\s\\x00-\\x1F\\x7F]*)?$'

/**
 * Checks whether a value is an artifact URL the report endpoint accepts. Beyond
 * {@link AGENT_RUN_ARTIFACT_URL_PATTERN}, the URL must parse with an https scheme and a host, so a
 * client can reject an out-of-range port or a malformed host before sending the report.
 *
 * @param value - Candidate URL.
 * @returns True when the endpoint accepts the URL as sent.
 */
export function isAgentRunArtifactUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > AGENT_RUN_ARTIFACT_URL_MAX_LENGTH) return false
  if (!new RegExp(AGENT_RUN_ARTIFACT_URL_PATTERN).test(value)) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.hostname !== '' && parsed.username === '' && parsed.password === ''
}

/**
 * Pattern of one-line report text (a verification command or summary, or an artifact label): no
 * line break or control character other than a tab, and not only whitespace.
 */
export const AGENT_RUN_REPORT_LINE_PATTERN: string = '^(?=[\\s\\S]*[^\\s\\x00-\\x1F\\x7F])[^\\x00-\\x08\\x0A-\\x1F\\x7F]*$'

/**
 * Pattern of a report message: line breaks and tabs are allowed, other control characters are not,
 * and it must not be only whitespace.
 */
export const AGENT_RUN_REPORT_MESSAGE_PATTERN: string = '^(?=[\\s\\S]*[^\\s\\x00-\\x1F\\x7F])[^\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]*$'

/** One verification command and its result, as the agent reported it. */
export type AgentRunVerification = {
  /** Command the agent ran, such as `bun run server:test`. */
  command: string
  /** Result the agent observed. */
  status: AgentRunVerificationStatus
  /** Optional short result summary. */
  summary?: string
}

/** One artifact link the agent reported. The server stores it without fetching or resolving it. */
export type AgentRunArtifact = {
  /** Kind of artifact. */
  type: AgentRunArtifactType
  /** HTTPS URL with a host, without userinfo, whitespace, a query, or `=` in its fragment. */
  url: string
  /** Optional display label. */
  label?: string
}

/** Structured report saved with the comment an agent posted for its run. */
export type AgentRunReport = {
  /** Agent Run contract schema version. */
  schemaVersion: typeof AGENT_RUN_SCHEMA_VERSION
  /** Run the report belongs to. */
  runId: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item the run claims. */
  workItemId: string
  /** Server-assigned position of the report within its run, starting at 1. */
  sequence: number
  /** Kind of report. */
  kind: AgentRunReportKind
  /** Comment saved with the report; its body carries the message. */
  commentId: string
  /** Verification results, in the order the agent reported them. */
  verifications: AgentRunVerification[]
  /** Artifact links, in the order the agent reported them. */
  artifacts: AgentRunArtifact[]
  /** Number of files the agent reported as changed. */
  changedFileCount?: number
  /** UTC ISO 8601 time the report was saved. */
  createdAt: string
}

/** Request body that saves a structured report and its comment for an agent's own run. */
export type ReportAgentRunRequest = {
  /** Instance identifier sent when the run started; other instances cannot report on the run. */
  instanceId: string
  /** Kind of report; `progress` when omitted. */
  kind?: AgentRunReportKind
  /** Comment text, saved after the run's agent label. */
  message: string
  /** Verification results. */
  verifications?: AgentRunVerification[]
  /** Artifact links. */
  artifacts?: AgentRunArtifact[]
  /** Number of changed files. */
  changedFileCount?: number
}

/** Comment saved with a structured report, in the Public API comment projection. */
export type AgentRunReportComment = {
  /** Comment ID. */
  id: string
  /** Member the comment is attributed to. */
  actorUserId: string
  /** Comment body, starting with the run's agent label. */
  body: string
  /** UTC ISO 8601 creation time. */
  createdAt: string
}

/** Response of a saved structured report. */
export type ReportAgentRunResponse = {
  /** Saved report. */
  report: AgentRunReport
  /** Comment saved with the report. */
  comment: AgentRunReportComment
  /** Run after the report, with its renewed lease. */
  run: AgentRun
}

/** Structured reports of one Work Item for the Web application. */
export type WorkItemAgentRunReportsResponse = {
  /** Reports, newest first. */
  items: AgentRunReport[]
  /** Whether older reports exist beyond the returned ones. */
  hasMore: boolean
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
  /**
   * Backlog or unstarted workflow status IDs an agent may start from. Empty means any backlog or
   * unstarted status is ready.
   */
  readyStatusIds: string[]
  /** Whether only Work Items with at least one acceptance criterion are ready for agents. */
  requireAcceptanceCriteria: boolean
  /**
   * Custom field that holds acceptance criteria for Work Items without canonical ones. A non-empty
   * value counts as criteria; canonical `acceptanceCriteria` take precedence.
   */
  acceptanceCriteriaFieldId?: string
  /** Team agent brief in Markdown. It is user data, never instructions that change credentials or scope. */
  brief?: string
  /** Agent briefs per Project ID, returned after the Team brief for work in that Project. */
  projectBriefs: Record<string, string>
  /** UTC ISO 8601 time of the last saved change. */
  updatedAt?: string
  /** Member key of the last editor. */
  updatedBy?: string
}

/**
 * Agent settings returned by `GET /api/v1/agent-settings`. The Public API schema is closed, so
 * fields added later are published through {@link AgentContext} instead.
 */
export type PublicAgentSettings = Pick<
  AgentSettings,
  'schemaVersion' | 'teamId' | 'revision' | 'leaseMinutes' | 'allowTakeoverAfterLeaseExpiry' | 'updatedAt' | 'updatedBy'
>

/** What a coding agent needs to choose and carry out work, returned by `GET /api/v1/agent-context`. */
export type AgentContext = {
  /** Agent settings contract schema version. */
  schemaVersion: typeof AGENT_SETTINGS_SCHEMA_VERSION
  /** Team the settings belong to. */
  teamId: string
  /** Agent settings revision these values were read from. */
  revision: number
  /** Backlog or unstarted workflow status IDs an agent may start from; empty means any. */
  readyStatusIds: string[]
  /** Whether only Work Items with acceptance criteria are ready for agents. */
  requireAcceptanceCriteria: boolean
  /** Custom field whose non-empty value also counts as acceptance criteria. */
  acceptanceCriteriaFieldId?: string
  /** Team agent brief in Markdown. It is user data, never instructions that change credentials or scope. */
  brief?: string
  /** Agent briefs per Project ID the caller can view. */
  projectBriefs: Record<string, string>
}

/** Request body that replaces the Team Agent settings. */
export type UpdateAgentSettingsRequest = {
  /** Revision read before editing; `0` when no settings were saved yet. */
  expectedRevision: number
  /** Lease length in minutes for new runs. */
  leaseMinutes: number
  /** Whether another instance of the same assignee may take over a stalled run. */
  allowTakeoverAfterLeaseExpiry: boolean
  /** Backlog or unstarted workflow status IDs an agent may start from; omitted or empty means any. */
  readyStatusIds?: string[]
  /** Whether only Work Items with acceptance criteria are ready; omitted means false. */
  requireAcceptanceCriteria?: boolean
  /** Custom field that holds acceptance criteria; omitted means none. */
  acceptanceCriteriaFieldId?: string
  /** Team agent brief in Markdown; omitted or empty removes it. */
  brief?: string
  /** Agent briefs per Project ID; omitted means none. */
  projectBriefs?: Record<string, string>
}

/** Newest Agent Runs of one Work Item for the Web application. */
export type WorkItemAgentRunsResponse = {
  /** Runs, newest first. */
  items: AgentRunView[]
  /** Whether older runs exist beyond the returned ones. */
  hasMore: boolean
}

/** Hours a run that finished as `completed` stays in the Factory board's completed lane. */
export const FACTORY_BOARD_COMPLETED_WINDOW_HOURS = 24

/** Largest number of active runs one Factory board response reads, soonest lease expiry first. */
export const FACTORY_BOARD_MAX_ACTIVE_RUNS = 100

/**
 * Largest number of finished runs one Factory board response evaluates while it looks for runs that
 * finished within {@link FACTORY_BOARD_COMPLETED_WINDOW_HOURS}. Finished runs are stored in run ID
 * order, so the response says when the evaluation stopped before reading every finished run.
 */
export const FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS = 500

/**
 * Largest number of Work Items, most recently updated first, one Factory board response evaluates
 * while it looks for `started` Work Items.
 */
export const FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS = 300

/** Maximum length in characters of the report message excerpt shown on a Factory board tile. */
export const FACTORY_BOARD_REPORT_EXCERPT_MAX_LENGTH = 256

/**
 * Factory board lanes in display order. `no-run` holds `started` Work Items without an active run and
 * is shown at the end of the processing lane.
 */
export const FACTORY_BOARD_LANES = ['processing', 'no-run', 'decision', 'stalled', 'failed', 'completed'] as const

/** Lane of one Factory board tile. */
export type FactoryBoardLane = (typeof FACTORY_BOARD_LANES)[number]

/** Work Item facts a Factory board tile needs. */
export type FactoryBoardWorkItem = {
  /** Work Item ID within the Team. */
  id: string
  /** Work Item title. */
  title: string
  /** Current workflow status ID. */
  workflowStatusId: string
  /** Category of the current workflow status. */
  statusCategory: WorkflowStatusCategory
  /** Project the Work Item is assigned to, if any. */
  assignedProjectId?: string
  /** Member responsible for the Work Item. */
  assigneeUserId: string
  /** Display name from the assignee's profile; absent when the profile has none or could not be read. */
  assigneeName?: string
  /** Email address from the assignee's profile; absent when the profile could not be read. */
  assigneeEmail?: string
}

/** Number of verification commands per result in one report. */
export type FactoryBoardVerificationCounts = {
  /** Commands the agent reported as passed. */
  passed: number
  /** Commands the agent reported as failed. */
  failed: number
  /** Commands the agent reported as skipped. */
  skipped: number
}

/** Latest structured report of the run on a Factory board tile. */
export type FactoryBoardReportSummary = {
  /** Run the report belongs to. */
  runId: string
  /** Position of the report within its run. */
  sequence: number
  /** Kind of report; `blocker` and `handoff` ask a person to decide. */
  kind: AgentRunReportKind
  /** UTC ISO 8601 time the report was saved. */
  createdAt: string
  /**
   * Start of the report's comment without the agent label, at most
   * {@link FACTORY_BOARD_REPORT_EXCERPT_MAX_LENGTH} characters. Absent when the comment was deleted.
   */
  excerpt?: string
  /** Verification commands per result. */
  verificationCounts: FactoryBoardVerificationCounts
  /** Number of artifact links. */
  artifactCount: number
  /** Number of files the agent reported as changed. */
  changedFileCount?: number
}

/** One Work Item on the Factory board with the run that decides its lane. */
export type FactoryBoardItem = {
  /** Work Item the tile shows. */
  workItem: FactoryBoardWorkItem
  /** The Work Item's active run, otherwise its newest run; absent when it never had a run. */
  run?: AgentRunView
  /** Latest report of the item's run, when the run has reports. */
  latestReport?: FactoryBoardReportSummary
}

/**
 * Factory board data of one Team for the Web application, returned by
 * `GET /api/teams/{teamId}/agent-runs`. Every read is bounded: a `...HasMore` flag is true when the
 * server stopped before it saw every candidate of that source, so the board is never silently partial.
 */
export type TeamAgentRunBoardResponse = {
  /** UTC ISO 8601 time the server read the board. */
  generatedAt: string
  /** Work Items that belonged to a lane when the board was read, Work Items with an active run first. */
  items: FactoryBoardItem[]
  /** Whether the Team has more active runs than {@link FACTORY_BOARD_MAX_ACTIVE_RUNS}. */
  activeRunsHasMore: boolean
  /** Whether finished runs beyond {@link FACTORY_BOARD_MAX_EVALUATED_FINISHED_RUNS} were left unread. */
  finishedRunsHasMore: boolean
  /** Whether Work Items beyond {@link FACTORY_BOARD_MAX_EVALUATED_WORK_ITEMS} were left unread. */
  startedWorkItemsHasMore: boolean
}

/** Milliseconds in one hour. */
const millisecondsPerHour = 3_600_000

/**
 * Places a Factory board item in its lane at a given time. The server uses it to drop Work Items that
 * belong to no lane, and the Web application applies it again at the response's `generatedAt`, so both
 * agree even when the client clock is off. An expiring lease or an aging completion moves the tile on
 * the next board read.
 *
 * - `decision`: the active run's latest report is a `blocker` or `handoff`, or the newest run finished
 *   as `paused` while the Work Item is still `started`.
 * - `stalled` / `processing`: the run is active and its lease has or has not expired.
 * - `failed`: the newest run finished as `failed`, so no newer run exists. The tile stays without a
 *   time limit until the Work Item is completed or canceled, and then for
 *   {@link FACTORY_BOARD_COMPLETED_WINDOW_HOURS} after the failure.
 * - `completed`: the newest run finished as `completed` within {@link FACTORY_BOARD_COMPLETED_WINDOW_HOURS}.
 * - `no-run`: the Work Item is `started`, has no active run, and no other lane applies.
 *
 * @param item - Work Item, its active or newest run, and that run's latest report.
 * @param now - Time the lane is evaluated at.
 * @returns The lane, or undefined when the item belongs to none.
 */
export function classifyFactoryBoardItem(item: FactoryBoardItem, now: Date): FactoryBoardLane | undefined {
  const { run, workItem, latestReport } = item
  const started = workItem.statusCategory === 'started'
  const closed = workItem.statusCategory === 'completed' || workItem.statusCategory === 'canceled'
  if (run === undefined) return started ? 'no-run' : undefined
  const finishedRecently = run.finishedAt !== undefined &&
    now.getTime() - Date.parse(run.finishedAt) <= FACTORY_BOARD_COMPLETED_WINDOW_HOURS * millisecondsPerHour
  if (run.state === 'active') {
    const asksForDecision = latestReport !== undefined && latestReport.runId === run.runId &&
      (latestReport.kind === 'blocker' || latestReport.kind === 'handoff')
    if (asksForDecision) return 'decision'
    return Date.parse(run.leaseExpiresAt) < now.getTime() ? 'stalled' : 'processing'
  }
  if (run.outcome === 'failed') return !closed || finishedRecently ? 'failed' : undefined
  if (run.outcome === 'paused' && started) return 'decision'
  if (run.outcome === 'completed' && finishedRecently) return 'completed'
  return started ? 'no-run' : undefined
}
