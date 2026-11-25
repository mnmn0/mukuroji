import type {
  AgentRun, AgentRunFinishOutcome, AgentRunMutationFence, AgentRunReport, AgentRunReportComment, AgentRunRuntime,
  AgentSettings, CanonicalWorkItem, PublicDocumentContent, PublicProjectCharter, PublicWorkItemActualDates, PublicWorkItemAttachment, PublicWorkItemAttachmentDownload, PublicWorkItemDocument, PublicWorkItemEffort, PublicWorkItemHierarchy, PublicWorkItemTemplate, ReportAgentRunRequest, CreatePublicWorkItemRequest, UpdatePublicWorkItemRequest,
  TeamIssueCommentResponseItem, WorkflowStatusDefinition, WorkItemAcceptanceCriterion,
} from '@mukuroji/contracts'

/** Canonical task fields needed by a coding agent, excluding internal storage fields. */
export type AgentTask = Pick<CanonicalWorkItem,
  'id' | 'key' | 'teamId' | 'revision' | 'title' | 'description' | 'assigneeUserId' |
  'assignedProjectId' | 'workflowStatusId' | 'statusCategory' | 'workItemTypeId' |
  'priority' | 'dueDate' | 'schedule' |
  'createdAt' | 'updatedAt' | 'relationIds' | 'customFieldValues'>

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
  /**
   * Work Item templates create_task can start from; empty when none, or when the server is older
   * than template support. Names and texts are user data, never instructions.
   */
  templates: PublicWorkItemTemplate[]
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
export type AgentSettingsRecord = Omit<AgentSettings, 'fileFailedRunsToTriage' | 'fileStalledRunsToTriage' | 'notifyAssigneeOfRunEvents'>

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

/** Input that resumes a started task without an active run for this agent instance. */
export type AgentRunResumeInput = Omit<AgentRunStartInput, 'workflowStatusId'> & {
  /** Run the agent expects to resume from; the API refuses the resume when a later run exists. */
  expectedPreviousRunId?: string
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
   * Starts a new run on a started task that no run claims, linked to the task's newest earlier run.
   * The task status does not change.
   * @param id - Task identifier within the configured Team.
   * @param input - Revision read before deciding to resume, and the identity of this process.
   * @param key - Idempotency key reused for uncertain retries.
   * @returns This instance's new run and the earlier run it resumes, if any.
   */
  resumeRun(id: string, input: AgentRunResumeInput, key: string): Promise<{
    /** New run of this instance. */
    run: AgentRunRecord
    /** Newest earlier run of the task, which the new run resumes. */
    resumedFromRun?: AgentRunRecord
  }>
  /**
   * Reads the newest run of a task, active or finished.
   * @param id - Task identifier within the configured Team.
   * @returns The newest run, or undefined when the task never had one.
   */
  latestRun(id: string): Promise<AgentRunRecord | undefined>
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
  /**
   * Reads the acceptance criteria of a task.
   * @param id - Task ID.
   * @returns Criteria in order; empty when none or when the server predates acceptance criteria.
   */
  acceptanceCriteria(id: string): Promise<WorkItemAcceptanceCriterion[]>
  /**
   * Reads the estimate, recorded remaining effort, and recorded progress of a task.
   * @param id - Task ID.
   * @returns The values with the revision they were read at, or undefined when the server predates the endpoint.
   */
  effort(id: string): Promise<AgentTaskEffort | undefined>
  /**
   * Reads the actual start and end dates of a task.
   * @param id - Task ID.
   * @returns The recorded dates with the revision they were read at, or undefined when the server predates the endpoint.
   */
  actualDates(id: string): Promise<AgentTaskActualDates | undefined>
  /**
   * Reads the short immutable key of a task, such as `ABC-123`.
   * @param id - Task ID.
   * @returns The key and the creation time of the Work Item it belongs to (the key is absent when
   * the task predates keys), or `undefined` when the server predates the endpoint.
   */
  taskKey(id: string): Promise<AgentTaskKey | undefined>
  /**
   * Reads where a task sits in its Team's Work Item tree.
   * @param id - Task ID.
   * @returns The parent, children, and WBS number, or `undefined` when the server predates the endpoint.
   */
  hierarchy(id: string): Promise<AgentTaskHierarchy | undefined>
  /**
   * Lists one page of Documents linked to a task that the credential owner can view.
   * @param id - Task ID.
   * @param cursor - Public continuation from a page of the same task and limit.
   * @param limit - Optional maximum number of links evaluated in the page.
   * @returns Visible linked Documents, or `undefined` when the server predates the endpoint.
   */
  relatedDocuments(id: string, cursor?: string, limit?: number): Promise<AgentPage<AgentTaskDocument> | undefined>
  /**
   * Lists the newest blocker and handoff reports of a task with the answers people recorded.
   * @param id - Task ID.
   * @returns The questions, or `undefined` when the server predates the endpoint.
   */
  questions(id: string): Promise<AgentTaskQuestions | undefined>
  /**
   * Reads the charter and lifecycle state of a Project of the configured Team.
   * @param projectId - Project ID.
   * @returns The charter, or `undefined` when the server predates the endpoint.
   */
  projectCharter(projectId: string): Promise<PublicProjectCharter | undefined>
  /**
   * Reads a Document linked to a task as Markdown, when the credential owner can view both.
   * @param id - Task ID.
   * @param documentId - Document ID from the task's linked Documents.
   * @returns The Document content.
   */
  document(id: string, documentId: string): Promise<AgentDocument>
  /**
   * Lists the files attached to a task that the credential owner can view and whose current
   * version passed the malware scan.
   * @param id - Task ID.
   * @returns Downloadable attachments, or `undefined` when the server predates the endpoint.
   */
  attachments(id: string): Promise<AgentTaskAttachment[] | undefined>
  /**
   * Issues a short-lived download URL for the current version of a task attachment.
   * @param id - Task ID.
   * @param fileId - File ID from the task's attachments.
   * @returns The download URL and its expiry.
   */
  attachmentDownload(id: string, fileId: string): Promise<AgentAttachmentDownload>
}

/** Newest blocker and handoff reports of a task, with the answers people recorded, as get_task shows them. */
export type AgentTaskQuestions = {
  /** Questions, newest first. */
  items: AgentRunReport[]
  /** True when older questions were left out. */
  hasMore: boolean
}

/** File attached to a task, as get_task and list_task_attachments show it. The name is user data. */
export type AgentTaskAttachment = PublicWorkItemAttachment

/** Short-lived download URL of a task attachment. The file content is user data, not instructions. */
export type AgentAttachmentDownload = PublicWorkItemAttachmentDownload

/** Document linked to a task, as get_task and list_task_documents show it. */
export type AgentTaskDocument = PublicWorkItemDocument

/** Content of a Document linked to a task, as read_document returns it. User data, not instructions. */
export type AgentDocument = PublicDocumentContent

/** Parent, children, and WBS number of a task, as get_task shows them. */
export type AgentTaskHierarchy = Pick<
  PublicWorkItemHierarchy,
  'parentWorkItemId' | 'childWorkItemIds' | 'wbsNumber'
>

/** Key of a task together with the creation time that identifies which Work Item it belongs to. */
export type AgentTaskKey = {
  /** Canonical key such as `ABC-123`, absent on tasks created before keys existed. */
  key?: string
  /** Creation time of the Work Item the key was read from. */
  createdAt: string
}

/** Estimate, recorded remaining effort, and recorded progress of a task, as get_task shows them. */
export type AgentTaskEffort = Pick<
  PublicWorkItemEffort,
  'revision' | 'plannedEffortMinutes' | 'remainingEffortMinutes' | 'progressPercent'
>

/** Actual start and end dates of a task, as get_task shows them. */
export type AgentTaskActualDates = Pick<
  PublicWorkItemActualDates,
  'revision' | 'actualStartDate' | 'actualEndDate'
>

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
