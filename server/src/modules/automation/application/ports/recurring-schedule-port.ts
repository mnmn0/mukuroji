import type {
  CreateRecurringWorkInput,
  RecurringWork,
  UpdateRecurringWorkInput,
} from '@mukuroji/contracts'

/** Persistence capability required by recurring-schedule use cases. */
export interface AutomationRecurringSchedulePort {
  /** Lists current recurring definitions in a Workspace. */
  listRecurringWorks(workspaceId: string): Promise<RecurringWork[]>
  /** Reads a current recurring definition. */
  getRecurringWork(
    workspaceId: string,
    recurringWorkId: string,
  ): Promise<RecurringWork | undefined>
  /** Creates an idempotent recurring definition. */
  createRecurringWork(
    workspaceId: string,
    input: CreateRecurringWorkInput,
    idempotencyKey?: string,
  ): Promise<RecurringWork>
  /** Updates a recurring definition with revision compare-and-swap. */
  updateRecurringWork(
    workspaceId: string,
    recurringWorkId: string,
    input: UpdateRecurringWorkInput,
  ): Promise<RecurringWork>
  /** Advances a completed recurring slot. */
  completeRecurringWork(
    workspaceId: string,
    recurringWorkId: string,
    expectedRevision: number,
    lastRunAt: string,
    nextRunAt: string,
  ): Promise<RecurringWork>
  /** Deletes a recurring definition with revision compare-and-swap. */
  deleteRecurringWork(
    workspaceId: string,
    recurringWorkId: string,
    expectedRevision: number,
  ): Promise<void>
  /** Lists due recurring definitions from one schedule shard. */
  listDueRecurringWorks(
    scheduleShard: string,
    dueAt: string,
    limit?: number,
  ): Promise<RecurringWork[]>
}
