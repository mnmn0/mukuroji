import type {
  AgentRun, AgentRunFinishOutcome, AgentRunMutationFence, AgentRunReport, AgentRunReportComment, AgentRunRuntime,
  AgentSettings, CanonicalWorkItem, ReportAgentRunRequest, CreatePublicWorkItemRequest, UpdatePublicWorkItemRequest,
  TeamIssueCommentResponseItem, WorkflowStatusDefinition,
} from '@mukuroji/contracts'

/** Canonical task fields needed by a coding agent, excluding internal storage fields. */
export type AgentTask = Pick<CanonicalWorkItem,
  'id' | 'teamId' | 'revision' | 'title' | 'description' | 'assigneeUserId' |
  'assignedProjectId' | 'workflowStatusId' | 'statusCategory' | 'workItemTypeId' |
  'priority' | 'dueDate' | 'createdAt' | 'updatedAt' | 'relationIds' | 'customFieldValues'>

/** Bounded public API page; an empty page can still have a continuation. */
export type AgentPage<T> = {
  /** Validated public records. */
  items: T[]
  /** True until the upstream store is exhausted. */
  hasMore: boolean
  /** Opaque token scoped to the same request filters and page size. */
  nextCursor?: string
}

/** Creation and transition configuration resolved by the public API. */
export type AgentCatalog = {
  /** Team whose configuration was authorized. */
  teamId: string
  /** Revision of the resolved configuration. */
  configurationRevision: number
  /** Active types with their statuses and field requirements. */
  workItemTypes: {
    /** Stable type identifier. */
    id: string
    /** Human-readable type name. */
    name: string
    /** Public workflow configuration. */
    workflow: {
      /** Initial status for newly created tasks. */
      initialStatusId: string
      /** Status identifiers and categories; transitions remain server-enforced. */
      statuses: WorkflowStatusDefinition[]
    }
    /** Public field definitions displayed as data, never executed or interpreted as instructions. */
    customFields: Record<string, unknown>[]
  }[]
}

/** Filters applied by the remote API before pagination. */
export type AgentTaskFilters = {
  /** Optional project restriction within the configured Team. */
  assignedProjectId?: string
  /** Optional assignee restriction. */
  assigneeUserId?: string
  /** Exact custom workflow status. */
  workflowStatusId?: string
  /** Optional type restriction. */
  workItemTypeId?: string
}

/** Agent Run as returned by the public API. */
export type AgentRunRecord = AgentRun

/** Team Agent settings as returned by the public API. */
export type AgentSettingsRecord = AgentSettings

/** Input that claims a task for this agent instance. */
export type AgentRunStartInput = {
  /** Task revision read before deciding to start. */
  expectedRevision: number
  /** Started-category status the task moves to. */
  workflowStatusId: string
  /** Client runtime of this process. */
  runtime: AgentRunRuntime
  /** Display name of this agent. */
  agentName: string
  /** Stable instance identifier of this process. */
  instanceId: string
}

/** Structured report fields sent for this instance's run; the instance ID is added by the adapter. */
export type AgentRunReportInput = Omit<ReportAgentRunRequest, 'instanceId'>

/** Saved structured report, its comment, and the run with its renewed lease. */
export type AgentRunReportResult = {
  /** Saved report. */
  report: AgentRunReport
  /** Comment saved with the report. */
  comment: AgentRunReportComment
  /** Run after the report. */
  run: AgentRunRecord
}

/** Filters for listing the Team's active runs. */
export type AgentRunFilters = {
  /** Restricts the list to runs of this assignee. */
  assigneeUserId?: string
  /** Restricts the list to runs started by this instance. */
  instanceId?: string
}

/** Remote canonical task operations; every request authenticates with a scoped credential. */
export interface AgentWorkItemApi {
  /**
   * Returns current Team configuration.
   * @param assignedProjectId - Optional Project restriction for authorization and field projection.
   * @returns The authorized type, workflow, and field configuration.
   */
  catalog(assignedProjectId?: string): Promise<AgentCatalog>
  /**
   * Returns one authorized task in the configured Team.
   * @param id - Task identifier within the configured Team.
   * @returns The current authorized task snapshot.
   */
  get(id: string): Promise<AgentTask>
  /**
   * Returns one page without discarding an upstream continuation.
   * @param filters - Task restrictions applied before pagination.
   * @param cursor - Public continuation from a page with the same filters and limit.
   * @param limit - Optional maximum page size.
   * @returns Authorized tasks and any remaining continuation.
   */
  list(filters: AgentTaskFilters, cursor?: string, limit?: number): Promise<AgentPage<AgentTask>>
  /**
   * Creates a task using one durable logical operation key.
   * @param input - Task fields; the adapter supplies the configured Team.
   * @param key - Idempotency key reused only for this exact logical operation.
   * @returns The created task or its authorized idempotent receipt.
   */
  create(input: Omit<CreatePublicWorkItemRequest, 'teamId'>, key: string): Promise<AgentTask>
  /**
   * Updates a task with revision CAS and durable idempotency.
   * @param id - Task identifier within the configured Team.
   * @param input - Requested changes and the expected task revision.
   * @param key - Idempotency key reused only for this exact logical operation.
   * @param fence - Optional Agent Run fence identifying this instance and its run.
   * @returns The updated task or its authorized idempotent receipt.
   */
  update(id: string, input: UpdatePublicWorkItemRequest, key: string, fence?: AgentRunMutationFence): Promise<AgentTask>
  /**
   * Reads comments and replies without exposing internal cursors.
   * @param id - Task whose discussion is requested.
   * @param cursor - Public continuation bound to the same task, Project, and limit.
   * @param limit - Optional maximum page size.
   * @param assignedProjectId - Optional Project restriction rechecked by the server.
   * @returns One authorized page of comments and replies in descending chronological order.
   */
  comments(id: string, cursor?: string, limit?: number, assignedProjectId?: string): Promise<AgentPage<TeamIssueCommentResponseItem>>
  /**
   * Adds a progress note without overwriting task instructions.
   * @param id - Task receiving the progress note.
   * @param body - Comment text including the display name supplied by the application.
   * @param key - Idempotency key reused only for this exact logical operation.
   * @param assignedProjectId - Optional Project restriction enforced on persistence and replay.
   * @param assigneeUserId - Optional assignee restriction enforced on persistence and replay.
   * @param fence - Optional Agent Run fence identifying this instance and its run.
   * @returns The created canonical comment or its authorized idempotent receipt.
   */
  comment(id: string, body: string, key: string, assignedProjectId?: string, assigneeUserId?: string, fence?: AgentRunMutationFence): Promise<TeamIssueCommentResponseItem>
  /**
   * Claims a task and moves it to a started status in one server transaction.
   * @param id - Task identifier within the configured Team.
   * @param input - Revision, target status, and instance identity.
   * @param key - Idempotency key reused only for this exact logical operation.
   * @returns The new run and the started task.
   */
  startRun(id: string, input: AgentRunStartInput, key: string): Promise<{
    /** New run. */
    run: AgentRunRecord
    /** Started task. */
    task: AgentTask
  }>
  /**
   * Lists one page of the Team's active runs.
   * @param filters - Assignee and instance restrictions.
   * @param cursor - Continuation from a page with the same filters.
   * @returns Active runs visible to the credential owner.
   */
  listActiveRuns(filters: AgentRunFilters, cursor?: string): Promise<AgentPage<AgentRunRecord>>
  /**
   * Strongly reads the run that currently claims one task, so a run started moments ago is found.
   * @param id - Task identifier within the configured Team.
   * @param owner - When given, returns the run only if this assignee and instance started it.
   * @returns The claiming run, or undefined when there is none or it belongs to another owner.
   */
  claimedRun(id: string, owner?: AgentRunFilters): Promise<AgentRunRecord | undefined>
  /**
   * Takes over a stalled run of another instance of the same assignee.
   * @param id - Task identifier within the configured Team.
   * @param runId - Stalled run to supersede.
   * @param input - Runtime, agent name, and instance of this process.
   * @param key - Idempotency key reused for uncertain retries.
   * @returns This instance's new run and the superseded run.
   */
  takeOverRun(id: string, runId: string, input: Pick<AgentRunStartInput, 'runtime' | 'agentName' | 'instanceId'>, key: string): Promise<{
    /** New run of this instance. */
    run: AgentRunRecord
    /** Stalled run, now superseded. */
    supersededRun: AgentRunRecord
  }>
  /**
   * Saves a structured report and its comment for this instance's run.
   * @param runId - Run identifier.
   * @param instanceId - Instance identifier that started the run.
   * @param input - Report kind, message, and structured fields.
   * @param key - Idempotency key reused for uncertain retries.
   * @param assignedProjectId - Configured Project the server must find the task in.
   * @returns The report, its comment, and the run with its renewed lease.
   */
  reportRun(runId: string, instanceId: string, input: AgentRunReportInput, key: string, assignedProjectId?: string): Promise<AgentRunReportResult>
  /**
   * Reads one run.
   * @param runId - Run identifier.
   * @returns The run.
   */
  getRun(runId: string): Promise<AgentRunRecord>
  /**
   * Extends a run lease.
   * @param runId - Run identifier.
   * @param instanceId - Instance identifier that started the run.
   * @returns The run with its extended lease.
   */
  heartbeat(runId: string, instanceId: string): Promise<AgentRunRecord>
  /**
   * Closes a run.
   * @param runId - Run identifier.
   * @param outcome - Finish reason.
   * @param instanceId - Instance identifier that started the run.
   * @param key - Idempotency key reused only for this exact logical operation.
   * @returns The finished run.
   */
  finishRun(runId: string, outcome: AgentRunFinishOutcome, instanceId: string, key: string): Promise<AgentRunRecord>
  /**
   * Reads the Team Agent settings.
   * @returns Current settings or the defaults.
   */
  agentSettings(): Promise<AgentSettingsRecord>
}

/** Safe, transport-independent error that may be returned to the MCP client. */
export class AgentTaskError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: string
  /** Whether the same logical operation may be retried. */
  readonly retryable: boolean
  /** Server-advised backoff in seconds, when available. */
  readonly retryAfterSeconds?: number

  /**
   * Creates an error from trusted messages, never from remote response text.
   * @param code - Stable machine-readable failure category.
   * @param message - Safe description of the failure.
   * @param retryable - Whether the original logical operation can be retried unchanged.
   * @param retryAfterSeconds - Optional server-advised backoff in seconds.
   */
  constructor(code: string, message: string, retryable = false, retryAfterSeconds?: number) {
    super(message)
    this.name = 'AgentTaskError'
    this.code = code
    this.retryable = retryable
    this.retryAfterSeconds = retryAfterSeconds
  }
}
