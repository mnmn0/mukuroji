import {
  CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES,
  CYCLE_SCHEDULE_BASELINE_MAX_SAVED,
  type CycleScheduleBaselineEntry,
  type CycleScheduleBaselineResponse,
  type SavedCycleScheduleBaseline,
} from '@mukuroji/contracts'
import { PlanningError } from '../planning'

/** One stored Cycle baseline with every entry, including ones a reader may not see. */
export type StoredCycleScheduleBaseline = {
  /** Baseline ID. */
  id: string
  /** Optional name. */
  name?: string
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Every frozen entry. */
  entries: CycleScheduleBaselineEntry[]
}

/** The list row of a Cycle's baselines. */
export type CycleScheduleBaselineIndex = {
  /** Revision of the list; it increments on each capture. */
  revision: number
  /** Saved baselines, newest first. */
  savedBaselines: SavedCycleScheduleBaseline[]
}

/** One capture of a Cycle baseline. The persistence port stores every part in one transaction. */
export type WriteCycleScheduleBaselineInput<TCallerCheck, TAuditContext = undefined> = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Cycle whose baseline is captured. */
  cycleId: string
  /** ISO timestamp of the capture, which the audit event records. */
  writtenAt: string
  /** New baseline row; it must not exist yet. */
  baseline: StoredCycleScheduleBaseline
  /** List revision read before the write, or 0 when none existed; the write fails if it changed. */
  expectedRevision: number
  /** Saved baseline list after the write, newest first. */
  savedBaselines: SavedCycleScheduleBaseline[]
  /** Saved baselines dropped from the list, whose rows are deleted. */
  savedIdsToDelete: string[]
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Request audit context; the store records the capture in the same transaction. */
  auditContext: TAuditContext
}

/** Persistence port for the schedule baselines of each Cycle. */
export type CycleScheduleBaselineStore<TCallerCheck, TAuditContext = undefined> = {
  /**
   * Reads the baseline list of a Cycle.
   *
   * @param workspaceId - Workspace directory ID.
   * @param cycleId - Cycle ID.
   * @returns The list row, or `null` before the first capture.
   */
  getIndex(workspaceId: string, cycleId: string): Promise<CycleScheduleBaselineIndex | null>
  /**
   * Reads one saved baseline with every entry.
   *
   * @param workspaceId - Workspace directory ID.
   * @param cycleId - Cycle ID.
   * @param baselineId - Saved baseline ID.
   * @returns The baseline, or `null` when it is not stored.
   */
  getSaved(workspaceId: string, cycleId: string, baselineId: string): Promise<StoredCycleScheduleBaseline | null>
  /**
   * Stores a new baseline and the updated list.
   *
   * @param input - Write input.
   */
  write(input: WriteCycleScheduleBaselineInput<TCallerCheck, TAuditContext>): Promise<void>
}

/** Scope of one Cycle baseline request, after the route authorized it. */
export type CycleScheduleBaselineScope = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Cycle whose baselines are read or written. */
  cycleId: string
}

/** Inputs of one capture, built by the route from the caller's current Planning snapshot. */
export type CaptureCycleScheduleBaselineInput<TCallerCheck, TAuditContext> = {
  /** Capture time as an ISO timestamp. */
  capturedAt: string
  /** Optional trimmed name. */
  name?: string
  /**
   * Reads the current plan of every Work Item in the Cycle that the caller may see. It is called
   * after the list revision is pinned, so an older plan cannot become the newest baseline.
   */
  readEntries: () => Promise<CycleScheduleBaselineEntry[]>
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Request audit context. */
  auditContext: TAuditContext
  /** Creates the ID of the new baseline; tests inject a fixed one. */
  createBaselineId?: () => string
}

/**
 * Saves the current plan of a Cycle's Work Items as a new named baseline. Earlier baselines stay
 * saved up to the limit; the oldest one is dropped beyond it.
 *
 * @param store - Baseline persistence.
 * @param scope - Authorized Workspace and Cycle.
 * @param capture - Entry reader, name, time, fences, and audit context.
 * @returns The response with the new baseline.
 * @throws PlanningError 413 when the Cycle holds more Work Items than one baseline stores.
 */
export async function captureCycleScheduleBaselineUseCase<TCallerCheck, TAuditContext>(
  store: CycleScheduleBaselineStore<TCallerCheck, TAuditContext>,
  scope: CycleScheduleBaselineScope,
  capture: CaptureCycleScheduleBaselineInput<TCallerCheck, TAuditContext>,
): Promise<CycleScheduleBaselineResponse> {
  // Pin the list revision before reading the plan, so a concurrent capture of a newer plan wins.
  const previous = await store.getIndex(scope.workspaceId, scope.cycleId)
  const entries = await capture.readEntries()
  if (entries.length > CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES) {
    throw new PlanningError(
      413,
      'CycleScheduleBaselineTooLarge',
      `A Cycle schedule baseline can hold at most ${CYCLE_SCHEDULE_BASELINE_MAX_ENTRIES} Work Items.`,
    )
  }
  const baseline: StoredCycleScheduleBaseline = {
    id: (capture.createBaselineId ?? createDefaultBaselineId)(),
    ...(capture.name === undefined ? {} : { name: capture.name }),
    capturedAt: capture.capturedAt,
    entries: entries.map((entry) => ({ ...entry })),
  }
  const listed = [summarize(baseline), ...(previous?.savedBaselines ?? [])]
  const kept = listed.slice(0, CYCLE_SCHEDULE_BASELINE_MAX_SAVED)
  const dropped = listed.slice(CYCLE_SCHEDULE_BASELINE_MAX_SAVED).map((item) => item.id)
  const expectedRevision = previous?.revision ?? 0
  await store.write({
    ...scope,
    writtenAt: capture.capturedAt,
    baseline,
    expectedRevision,
    savedBaselines: kept,
    savedIdsToDelete: dropped,
    callerAuthorization: capture.callerAuthorization,
    auditContext: capture.auditContext,
  })
  return {
    cycleId: scope.cycleId,
    revision: expectedRevision + 1,
    baseline: { ...summarize(baseline), entries: baseline.entries },
    savedBaselines: kept,
  }
}

/**
 * Reads the newest, or one saved, baseline of a Cycle, keeping only the entries of Work Items the
 * reader may currently see. `entryCount` still counts every entry.
 *
 * @param store - Baseline persistence.
 * @param scope - Authorized Workspace and Cycle.
 * @param isVisible - Whether the reader may see the Work Item of an entry.
 * @param baselineId - Saved baseline to read instead of the newest one.
 * @returns The response; `baseline` is `null` when none was captured.
 * @throws PlanningError 404 when the requested baseline is not saved.
 */
export async function readCycleScheduleBaselineUseCase<TCallerCheck, TAuditContext>(
  store: CycleScheduleBaselineStore<TCallerCheck, TAuditContext>,
  scope: CycleScheduleBaselineScope,
  isVisible: (entry: CycleScheduleBaselineEntry) => boolean,
  baselineId?: string,
): Promise<CycleScheduleBaselineResponse> {
  const index = await store.getIndex(scope.workspaceId, scope.cycleId)
  const savedBaselines = index?.savedBaselines ?? []
  const requestedId = baselineId ?? savedBaselines[0]?.id
  if (requestedId === undefined) {
    return { cycleId: scope.cycleId, revision: index?.revision ?? 0, baseline: null, savedBaselines }
  }
  if (!savedBaselines.some((item) => item.id === requestedId)) throw baselineNotFound()
  const stored = await store.getSaved(scope.workspaceId, scope.cycleId, requestedId)
  if (!stored) throw baselineNotFound()
  return {
    cycleId: scope.cycleId,
    revision: index?.revision ?? 0,
    baseline: { ...summarize(stored), entries: stored.entries.filter(isVisible) },
    savedBaselines,
  }
}

/**
 * Builds the list entry of a baseline.
 *
 * @param baseline - Stored baseline.
 * @returns Its list entry.
 */
function summarize(baseline: StoredCycleScheduleBaseline): SavedCycleScheduleBaseline {
  return {
    id: baseline.id,
    ...(baseline.name === undefined ? {} : { name: baseline.name }),
    capturedAt: baseline.capturedAt,
    entryCount: baseline.entries.length,
  }
}

/**
 * Creates a random baseline ID.
 *
 * @returns An ID such as `cb-1f0c…`.
 */
function createDefaultBaselineId() {
  return `cb-${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * Creates the error for a baseline that is not saved.
 *
 * @returns The error.
 */
function baselineNotFound() {
  return new PlanningError(404, 'CycleScheduleBaselineNotFound', 'The Cycle schedule baseline was not found.')
}
