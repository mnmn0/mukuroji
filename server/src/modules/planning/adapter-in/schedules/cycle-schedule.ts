import type { PlanningWorkItemLink } from '@mukuroji/contracts'
import type {
  CycleScheduleDueCycle,
  CycleScheduleSource,
} from '../../application/ports/cycle-schedule-source'
import { PlanningError, type PlanningClient } from '../../planning'

/** EventBridge scheduled event fields used by the Cycle schedule. */
export type CycleScheduleEvent = {
  /** ISO 8601 time at which EventBridge fired the schedule. */
  time?: string
}

/** Options of the Cycle automation schedule. */
export type CycleScheduleOptions = {
  /** Due-index and Work Item reads. */
  source: CycleScheduleSource
  /** Planning adapter that runs one automation step at a time. */
  planning: Pick<PlanningClient, 'runCycleAutomationStep'>
  /** Clock used when the event has no time. */
  now?: () => Date
  /** Query pages read per shard in one run. */
  maxPagesPerShard?: number
  /** Steps run for one Cycle in one run. */
  maxStepsPerCycle?: number
}

/** Counts reported by one Cycle schedule run. */
export type CycleScheduleResult = {
  /** Due Cycles read from the index. */
  examined: number
  /** Next Cycles created. */
  created: number
  /** Rollover batches committed. */
  rolledOver: number
  /** Cycles whose step failed; they stay due and are retried on the next run. */
  failed: number
  /** Cycles that still had a due step when the step limit of this run ran out. */
  unfinished: number
  /** Shards whose due rows did not fit in the page limit of this run. */
  truncatedShards: number
}

/**
 * Raised after a run that processed every reachable Cycle but left some unfinished, so the
 * scheduled-jobs dispatcher retries the job and reports the failure.
 */
export class CycleScheduleIncompleteError extends Error {
  /** Counts of the run. */
  readonly result: CycleScheduleResult

  /** @param result - Counts of the incomplete run. */
  constructor(result: CycleScheduleResult) {
    super(
      `Cycle schedule left ${result.failed} failed Cycles, ${result.unfinished} unfinished Cycles, ` +
        `and ${result.truncatedShards} truncated shards.`,
    )
    this.name = 'CycleScheduleIncompleteError'
    this.result = result
  }
}

/**
 * Creates the hourly job that creates next Cycles and carries over unfinished Work Items.
 *
 * Cycle rows carry sparse due-index attributes while an automation step is pending. Each run reads
 * the due rows of every shard and advances each Cycle until nothing is due. A failed Cycle does
 * not stop the others; after the run, failures, Cycles left unfinished at the step limit, and
 * page-limit truncation reject the job.
 *
 * @param options - Storage port, Planning adapter, and limits.
 * @returns Schedule handler.
 */
export function createCycleScheduleHandler(options: CycleScheduleOptions) {
  const maxPages = options.maxPagesPerShard ?? 100
  const maxSteps = options.maxStepsPerCycle ?? 20

  return async (event: CycleScheduleEvent = {}): Promise<CycleScheduleResult> => {
    const asOf = readScheduleTime(event.time) ?? (options.now ?? (() => new Date()))()
    const result: CycleScheduleResult = {
      examined: 0,
      created: 0,
      rolledOver: 0,
      failed: 0,
      unfinished: 0,
      truncatedShards: 0,
    }
    for (let shard = 0; shard < options.source.shardCount; shard += 1) {
      let cursor: unknown
      let pages = 0
      do {
        const page = await options.source.listDueCycles(shard, asOf, cursor)
        cursor = page.cursor
        pages += 1
        for (const cycle of page.cycles) {
          result.examined += 1
          try {
            if (!await advanceCycle(options, cycle, maxSteps, result)) result.unfinished += 1
          } catch (error) {
            result.failed += 1
            console.error('Cycle automation step failed.', {
              shard,
              error: error instanceof PlanningError
                ? error.code
                : error instanceof Error ? error.name : 'unknown',
            })
          }
        }
      } while (cursor !== undefined && pages < maxPages)
      if (cursor !== undefined) result.truncatedShards += 1
    }
    if (result.failed > 0 || result.unfinished > 0 || result.truncatedShards > 0) {
      throw new CycleScheduleIncompleteError(result)
    }
    return result
  }
}

/**
 * Runs automation steps for one Cycle until nothing is due.
 *
 * @returns Whether the Cycle reached an idle step within the step limit.
 */
async function advanceCycle(
  options: CycleScheduleOptions,
  cycle: CycleScheduleDueCycle,
  maxSteps: number,
  result: CycleScheduleResult,
) {
  const loadWorkItems = (links: readonly PlanningWorkItemLink[]) =>
    options.source.readLinkedWorkItems(cycle.workspaceId, links)
  let conflicts = 0
  for (let step = 0; step < maxSteps; step += 1) {
    let outcome
    try {
      outcome = await options.planning.runCycleAutomationStep(
        cycle.workspaceId,
        cycle.cycleId,
        loadWorkItems,
      )
    } catch (error) {
      // A concurrent Planning change moved the revision; read the graph again and retry.
      if (error instanceof PlanningError && error.code === 'PlanningRevisionConflict' && conflicts < 3) {
        conflicts += 1
        continue
      }
      throw error
    }
    if (outcome.action === 'idle') return true
    if (outcome.action === 'created-next') result.created += 1
    else result.rolledOver += 1
  }
  return false
}

/** Parses the schedule time of an EventBridge event. */
function readScheduleTime(value: unknown) {
  if (typeof value !== 'string') return undefined
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? time : undefined
}
