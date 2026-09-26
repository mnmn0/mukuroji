import type {
  CanonicalWorkItem, CreatePublicWorkItemRequest, UpdatePublicWorkItemRequest,
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

/** Remote canonical task operations; every request authenticates with a scoped credential. */
export interface AgentWorkItemApi {
  /** Returns current Team configuration. */
  catalog(assignedProjectId?: string): Promise<AgentCatalog>
  /** Returns one authorized task in the configured Team. */
  get(id: string): Promise<AgentTask>
  /** Returns one page without discarding an upstream continuation. */
  list(filters: AgentTaskFilters, cursor?: string, limit?: number): Promise<AgentPage<AgentTask>>
  /** Creates a task using one durable logical operation key. */
  create(input: Omit<CreatePublicWorkItemRequest, 'teamId'>, key: string): Promise<AgentTask>
  /** Updates a task with revision CAS and durable idempotency. */
  update(id: string, input: UpdatePublicWorkItemRequest, key: string): Promise<AgentTask>
  /** Reads comments and replies without exposing internal cursors. */
  comments(id: string, cursor?: string, limit?: number, assignedProjectId?: string): Promise<AgentPage<TeamIssueCommentResponseItem>>
  /** Adds a progress note without overwriting task instructions. */
  comment(id: string, body: string, key: string, assignedProjectId?: string, assigneeUserId?: string): Promise<TeamIssueCommentResponseItem>
}

/** Safe, transport-independent error that may be returned to the MCP client. */
export class AgentTaskError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: string
  /** Whether the same logical operation may be retried. */
  readonly retryable: boolean
  /** Server-advised backoff in seconds, when available. */
  readonly retryAfterSeconds?: number

  /** Creates an error from trusted messages, never from remote response text. */
  constructor(code: string, message: string, retryable = false, retryAfterSeconds?: number) {
    super(message)
    this.name = 'AgentTaskError'
    this.code = code
    this.retryable = retryable
    this.retryAfterSeconds = retryAfterSeconds
  }
}
