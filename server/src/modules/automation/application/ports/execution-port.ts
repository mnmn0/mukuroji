import type {
  AutomationAction,
  AutomationExecution,
  AutomationRule,
  AutomationValue,
} from '@mukuroji/contracts'
import type { AutomationEvent } from '../../domain/rule-evaluation'

/** Deterministic context passed to an Automation action side-effect port. */
export type AutomationActionExecutionContext = {
  /** Parent execution. */
  execution: AutomationExecution
  /** Trigger event. */
  event: AutomationEvent
  /** Zero-based action index. */
  actionIndex: number
  /** Idempotency key for the downstream side effect. */
  idempotencyKey: string
}

/** Side-effect port used by the Automation execution service. */
export interface AutomationActionExecutor {
  /** Executes one action and returns after downstream success is durable. */
  execute(
    action: AutomationAction,
    context: AutomationActionExecutionContext,
  ): Promise<void>
}

/** Query for an Automation execution timeline. */
export type AutomationExecutionQuery = {
  /** Workspace to query. */
  workspaceId: string
  /** Optional rule identifier filter. */
  ruleId?: string
  /** Optional execution status filter. */
  status?: AutomationExecution['status']
  /** Page size. */
  limit?: number
  /** Opaque cursor from the previous page. */
  cursor?: string
}

/** One page of Automation executions. */
export type AutomationExecutionPage = {
  /** Execution rows. */
  executions: AutomationExecution[]
  /** Opaque cursor for the next page. */
  nextCursor?: string
}

/** Result of atomically reserving an execution and fixed-window rate token. */
export type AutomationExecutionReservation =
  | 'created'
  | 'duplicate'
  | 'rate-limited'
  | 'stale-definition'

/** Immutable definition token checked when an execution is created or claimed. */
export type AutomationExecutionDefinitionGuard = {
  /** Definition kind. */
  kind: 'rule' | 'recurring'
  /** Definition identifier. */
  id: string
  /** Immutable definition version. */
  version: number
  /** Optimistic current-row revision. */
  revision: number
}

/** Fencing token held by one execution runner lease. */
export type AutomationExecutionClaimToken = {
  /** Attempt number after the lease was acquired. */
  attempt: number
  /** Exact lease expiry stored by the adapter. */
  leaseExpiresAt: string
}

/** Durable execution, lease, rate-limit, and receipt capability. */
export interface AutomationExecutionPort {
  /** Lists retry or runner-lease entries due in one schedule shard. */
  listDueExecutions(
    scheduleShard: string,
    dueAt: string,
    limit?: number,
  ): Promise<AutomationExecution[]>
  /** Atomically reserves an application-created execution and rate-limit token. */
  reserveExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    rule: AutomationRule,
  ): Promise<AutomationExecutionReservation>
  /** Creates a deterministic execution guarded by its current definition. */
  createExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ): Promise<boolean>
  /** Reads an execution. */
  getExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<AutomationExecution | undefined>
  /** Reads the trigger event stored with an execution. */
  getExecutionEvent(
    workspaceId: string,
    executionId: string,
  ): Promise<AutomationEvent | undefined>
  /** Claims an execution runner lease with state and attempt fencing. */
  claimExecution(
    execution: AutomationExecution,
    now: Date,
    leaseExpiresAt: string,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ): Promise<boolean>
  /** Saves execution state while holding an exact lease fencing token. */
  saveExecution(
    execution: AutomationExecution,
    claimToken: AutomationExecutionClaimToken,
    now: Date,
  ): Promise<boolean>
  /** Lists an execution timeline. */
  listExecutions(query: AutomationExecutionQuery): Promise<AutomationExecutionPage>
  /** Tests whether a successful action receipt already exists. */
  hasActionReceipt(
    workspaceId: string,
    executionId: string,
    actionId: string,
  ): Promise<boolean>
  /** Conditionally writes a successful action receipt. */
  putActionReceipt(
    workspaceId: string,
    executionId: string,
    actionId: string,
  ): Promise<boolean>
}

/** Read capabilities required by the execution service in addition to execution storage. */
export interface AutomationExecutionDefinitionReader {
  /** Reads an immutable rule version. */
  getRuleVersion(
    workspaceId: string,
    ruleId: string,
    version: number,
  ): Promise<AutomationRule | undefined>
  /** Reads the current recurring definition required for retry fencing. */
  getRecurringWork(
    workspaceId: string,
    recurringWorkId: string,
  ): Promise<{
    /** Definition identifier. */
    id: string
    /** Whether execution remains enabled. */
    enabled: boolean
    /** Immutable definition version. */
    version: number
    /** Optimistic current-row revision. */
    revision: number
  } | undefined>
}

/** Focused dependency required by the Automation execution service. */
export type AutomationExecutionServicePort = AutomationExecutionPort &
  AutomationExecutionDefinitionReader

/** Values resolved by an application adapter for condition evaluation. */
export type AutomationExecutionVariables = Record<string, AutomationValue>
