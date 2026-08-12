import {
  createWorkspaceSearchConfigurationHash,
  type WorkspaceSearchMigrationConfiguration,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import type {
  WorkspaceSearchMigrationCollectedMaintenanceEvidence,
  WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest,
  WorkspaceSearchMigrationMaintenanceEvidenceProvider,
} from './migration-post-close-planning-supervisor'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseMaintenanceEvidence,
} from './maintenance-evidence'

/** Default bounded wait for a new post-close maintenance evidence file. */
export const WORKSPACE_SEARCH_MIGRATION_POST_CLOSE_EVIDENCE_WAIT_MILLISECONDS =
  20 * 60 * 1_000

/** Default cancelable cadence used while an external collector replaces a file. */
export const WORKSPACE_SEARCH_MIGRATION_POST_CLOSE_EVIDENCE_POLL_MILLISECONDS =
  5_000

/** Read-only independently measured session used by the evidence provider. */
export interface WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession {
  /**
   * Measures the exact current resource incarnation.
   *
   * @returns Fresh measured migration configuration.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration>

  /** Releases and drains all resources owned by this independent measurement. */
  close(): Promise<void> | void
}

/** Cancelable cadence boundary used while awaiting post-close evidence. */
export interface WorkspaceSearchMigrationMaintenanceEvidenceWaiter {
  /**
   * Waits for one bounded cadence interval.
   *
   * @param milliseconds - Positive bounded delay.
   * @param signal - Cancellation shared with lease supervision.
   */
  wait(milliseconds: number, signal: AbortSignal): Promise<void>
}

/** Dependencies and fixed inputs for one file-backed evidence provider. */
export type CreateWorkspaceSearchMigrationFileEvidenceProviderInput = {
  /** Exact operator-selected resources remeasured before returning evidence. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Exact file path reread on every collection attempt. */
  readonly evidenceFilePath: string
  /** Bounded file reader supplied by the CLI boundary. */
  readonly readEvidenceFile: (path: string) => Promise<Uint8Array>
  /** Creates a fresh read-only measurement for independent TableId binding. */
  readonly createMeasurementSession: (
    resources: WorkspaceSearchMigrationRequestedResources,
  ) =>
    | Promise<WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession>
    | WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession
  /** Optional trusted wall clock used for freshness and bounded waiting. */
  readonly clock?: () => Date
  /** Optional cancelable waiter used by deterministic tests. */
  readonly waiter?: WorkspaceSearchMigrationMaintenanceEvidenceWaiter
  /** Optional bounded total wait for a post-close replacement file. */
  readonly maximumWaitMilliseconds?: number
  /** Optional positive polling cadence for a post-close replacement file. */
  readonly pollMilliseconds?: number
}

/** Detached collaborators and values retained by one evidence provider. */
type WorkspaceSearchMigrationFileEvidenceProviderSnapshot = {
  /** Exact operator-selected resources remeasured before returning evidence. */
  readonly resources: WorkspaceSearchMigrationRequestedResources
  /** Exact evidence file path retained only inside the provider closure. */
  readonly evidenceFilePath: string
  /** File reader captured before the provider starts asynchronous work. */
  readonly readEvidenceFile: (path: string) => Promise<Uint8Array>
  /** Measurement factory captured before the provider starts asynchronous work. */
  readonly createMeasurementSession: (
    resources: WorkspaceSearchMigrationRequestedResources,
  ) =>
    | Promise<WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession>
    | WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession
  /** Trusted clock captured before the provider starts asynchronous work. */
  readonly clock: () => Date
  /** Waiter with its method identity captured before asynchronous work. */
  readonly waiter: WorkspaceSearchMigrationMaintenanceEvidenceWaiter
  /** Positive total bound for post-close polling. */
  readonly maximumWaitMilliseconds: number
  /** Positive cadence no greater than the total polling bound. */
  readonly pollMilliseconds: number
}

/** Detached close collection request used across asynchronous boundaries. */
type WorkspaceSearchMigrationCloseEvidenceRequestSnapshot = {
  /** Collection phase captured exactly once. */
  readonly phase: 'close'
  /** Reviewed configuration digest captured before the first await. */
  readonly configurationHash: string
  /** Exact six TableIds captured before the first await. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Cancellation signal captured before the first await. */
  readonly signal: AbortSignal
}

/** Detached post-close collection request used across asynchronous boundaries. */
type WorkspaceSearchMigrationPostCloseEvidenceRequestSnapshot = {
  /** Collection phase captured exactly once. */
  readonly phase: 'post-close'
  /** Reviewed configuration digest captured before the first await. */
  readonly configurationHash: string
  /** Exact six TableIds captured before the first await. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Cancellation signal captured before the first await. */
  readonly signal: AbortSignal
  /** Validated writer-fence close time as epoch milliseconds. */
  readonly closedAtMilliseconds: number
}

/** Detached collection request safe to retain across asynchronous boundaries. */
type WorkspaceSearchMigrationEvidenceRequestSnapshot =
  | WorkspaceSearchMigrationCloseEvidenceRequestSnapshot
  | WorkspaceSearchMigrationPostCloseEvidenceRequestSnapshot

/** Stable raw-value-free file evidence provider failure. */
export class WorkspaceSearchMigrationMaintenanceEvidenceProviderError
  extends Error {
  /** Stable error code that contains no path, identity, or evidence value. */
  readonly code = 'MAINTENANCE_EVIDENCE_PROVIDER_FAILED'

  /** Creates one fixed-message provider failure. */
  constructor() {
    super('MAINTENANCE_EVIDENCE_PROVIDER_FAILED')
    this.name = 'WorkspaceSearchMigrationMaintenanceEvidenceProviderError'
  }
}

/**
 * Creates a provider that rereads evidence and independently remeasures AWS.
 *
 * A close request reads once. A post-close request waits only on a fixed,
 * cancelable cadence and returns only after the evidence drain began no earlier
 * than the durable writer-fence close time. Resource bindings are derived from
 * a fresh read-only measurement instead of being echoed from the request.
 *
 * @param input - Fixed resources, file reader, measurement factory, and cadence.
 * @returns Trusted provider suitable for planning and execution supervisors.
 */
export function createWorkspaceSearchMigrationFileEvidenceProvider(
  input: CreateWorkspaceSearchMigrationFileEvidenceProviderInput,
): WorkspaceSearchMigrationMaintenanceEvidenceProvider {
  const snapshot = snapshotFileEvidenceProviderInput(input)

  return Object.freeze({
    collect: async (
      request: WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest,
    ): Promise<WorkspaceSearchMigrationCollectedMaintenanceEvidence> => {
      const requestSnapshot = snapshotCollectionRequest(request)
      const startedAt = readClockMilliseconds(snapshot.clock)
      const deadline = startedAt + snapshot.maximumWaitMilliseconds
      if (!Number.isSafeInteger(deadline)) return failProvider()
      let remainingWaitMilliseconds = snapshot.maximumWaitMilliseconds

      while (true) {
        if (remainingWaitMilliseconds === 0) return failProvider()
        requireActive(requestSnapshot.signal)
        let evidenceBytes: Uint8Array
        let drainStartsAfterClose = requestSnapshot.phase === 'close'
        try {
          evidenceBytes = Uint8Array.from(
            await snapshot.readEvidenceFile(snapshot.evidenceFilePath),
          )
          requireActive(requestSnapshot.signal)
          const observedAtMilliseconds = readBoundedCollectionTime(
            snapshot.clock,
            startedAt,
            deadline,
          )
          drainStartsAfterClose = evidenceMatchesCollectionPhase(
            evidenceBytes,
            requestSnapshot,
            observedAtMilliseconds,
          )
        } catch {
          requireActive(requestSnapshot.signal)
          if (requestSnapshot.phase === 'close') return failProvider()
          evidenceBytes = new Uint8Array()
          drainStartsAfterClose = false
        }

        if (drainStartsAfterClose) {
          const measured = await independentlyMeasureResources(
            snapshot.resources,
            snapshot.createMeasurementSession,
            requestSnapshot.signal,
          )
          let remainsFresh = false
          try {
            const revalidatedAtMilliseconds = readBoundedCollectionTime(
              snapshot.clock,
              startedAt,
              deadline,
            )
            remainsFresh = evidenceMatchesCollectionPhase(
              evidenceBytes,
              requestSnapshot,
              revalidatedAtMilliseconds,
            )
          } catch {
            requireActive(requestSnapshot.signal)
            if (requestSnapshot.phase === 'close') return failProvider()
          }
          if (!remainsFresh) {
            if (requestSnapshot.phase === 'close') return failProvider()
          } else if (
            measured.configurationHash !== requestSnapshot.configurationHash ||
            !sameTableIds(measured.tableIds, requestSnapshot.tableIds)
          ) {
            return failProvider()
          } else {
            return {
              configurationHash: measured.configurationHash,
              tableIds: measured.tableIds,
              evidenceBytes,
            }
          }
        }

        const current = readClockMilliseconds(snapshot.clock)
        if (current < startedAt) return failProvider()
        if (current >= deadline) return failProvider()
        const waitMilliseconds = Math.min(
          snapshot.pollMilliseconds,
          deadline - current,
          remainingWaitMilliseconds,
        )
        try {
          await snapshot.waiter.wait(
            waitMilliseconds,
            requestSnapshot.signal,
          )
        } catch {
          return failProvider()
        }
        requireActive(requestSnapshot.signal)
        remainingWaitMilliseconds -= waitMilliseconds
      }
    },
  })
}

/**
 * Captures and validates every provider dependency before asynchronous work.
 *
 * @param input - Potentially accessor-backed caller input.
 * @returns Detached values and method identities retained by the provider.
 */
function snapshotFileEvidenceProviderInput(
  input: CreateWorkspaceSearchMigrationFileEvidenceProviderInput,
): WorkspaceSearchMigrationFileEvidenceProviderSnapshot {
  let rawResources: WorkspaceSearchMigrationRequestedResources
  let rawEvidenceFilePath: string
  let readEvidenceFile: (path: string) => Promise<Uint8Array>
  let createMeasurementSession: (
    resources: WorkspaceSearchMigrationRequestedResources,
  ) =>
    | Promise<WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession>
    | WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession
  let rawClock: (() => Date) | undefined
  let rawWaiter: WorkspaceSearchMigrationMaintenanceEvidenceWaiter | undefined
  let rawMaximumWaitMilliseconds: number | undefined
  let rawPollMilliseconds: number | undefined
  try {
    rawResources = input.resources
    rawEvidenceFilePath = input.evidenceFilePath
    readEvidenceFile = input.readEvidenceFile
    createMeasurementSession = input.createMeasurementSession
    rawClock = input.clock
    rawWaiter = input.waiter
    rawMaximumWaitMilliseconds = input.maximumWaitMilliseconds
    rawPollMilliseconds = input.pollMilliseconds
  } catch {
    return failProvider()
  }

  if (
    typeof readEvidenceFile !== 'function' ||
    typeof createMeasurementSession !== 'function'
  ) {
    return failProvider()
  }
  const clock = rawClock ?? systemEvidenceClock
  if (typeof clock !== 'function') return failProvider()
  const waiter = snapshotEvidenceWaiter(rawWaiter ?? systemEvidenceWaiter)
  const maximumWaitMilliseconds = readPositiveBoundedMilliseconds(
    rawMaximumWaitMilliseconds ??
      WORKSPACE_SEARCH_MIGRATION_POST_CLOSE_EVIDENCE_WAIT_MILLISECONDS,
  )
  const pollMilliseconds = readPositiveBoundedMilliseconds(
    rawPollMilliseconds ??
      WORKSPACE_SEARCH_MIGRATION_POST_CLOSE_EVIDENCE_POLL_MILLISECONDS,
  )
  if (pollMilliseconds > maximumWaitMilliseconds) return failProvider()

  return {
    resources: snapshotRequestedResources(rawResources),
    evidenceFilePath: requireEvidenceFilePath(rawEvidenceFilePath),
    readEvidenceFile,
    createMeasurementSession,
    clock,
    waiter,
    maximumWaitMilliseconds,
    pollMilliseconds,
  }
}

/**
 * Captures one waiter method so a mutable accessor cannot redirect later waits.
 *
 * @param waiter - Caller-supplied or default cancelable waiter.
 * @returns Waiter retaining the original receiver and method identity.
 */
function snapshotEvidenceWaiter(
  waiter: WorkspaceSearchMigrationMaintenanceEvidenceWaiter,
): WorkspaceSearchMigrationMaintenanceEvidenceWaiter {
  if (waiter === null || typeof waiter !== 'object') return failProvider()
  let wait: WorkspaceSearchMigrationMaintenanceEvidenceWaiter['wait']
  try {
    wait = waiter.wait
  } catch {
    return failProvider()
  }
  if (typeof wait !== 'function') return failProvider()
  return Object.freeze({
    /** Invokes the captured method with its original stateful receiver. */
    wait(
      milliseconds: number,
      signal: AbortSignal,
    ): Promise<void> {
      return wait.call(waiter, milliseconds, signal)
    },
  })
}

/**
 * Captures a complete evidence request before the first asynchronous boundary.
 *
 * @param request - Potentially accessor-backed supervisor request.
 * @returns Detached phase, binding, and cancellation inputs.
 */
function snapshotCollectionRequest(
  request: WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest,
): WorkspaceSearchMigrationEvidenceRequestSnapshot {
  let phase: WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest['phase']
  let configurationHash: string
  let rawTableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  let signal: AbortSignal
  let closedAt: string | undefined
  try {
    phase = request.phase
    configurationHash = request.configurationHash
    rawTableIds = request.tableIds
    signal = request.signal
    if (phase === 'post-close') {
      if (!('closedAt' in request)) return failProvider()
      closedAt = request.closedAt
    }
  } catch {
    return failProvider()
  }
  if (
    typeof configurationHash !== 'string' ||
    configurationHash.length === 0 ||
    configurationHash.length > 4_096
  ) {
    return failProvider()
  }
  requireActive(signal)
  const tableIds = snapshotTableIds(rawTableIds)
  if (phase === 'close') {
    return { phase, configurationHash, tableIds, signal }
  }
  if (phase !== 'post-close' || typeof closedAt !== 'string') {
    return failProvider()
  }
  const closedAtMilliseconds = Date.parse(closedAt)
  if (!Number.isFinite(closedAtMilliseconds)) return failProvider()
  return {
    phase,
    configurationHash,
    tableIds,
    signal,
    closedAtMilliseconds,
  }
}

/**
 * Copies every TableId so later caller mutation cannot alter the binding.
 *
 * @param tableIds - Potentially mutable role-to-TableId binding.
 * @returns Detached complete six-table binding.
 */
function snapshotTableIds(
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  try {
    return {
      'project-directory': tableIds['project-directory'],
      'work-items': tableIds['work-items'],
      collaboration: tableIds.collaboration,
      documents: tableIds.documents,
      'workspace-search': tableIds['workspace-search'],
      'migration-state': tableIds['migration-state'],
    }
  } catch {
    return failProvider()
  }
}

/** Fresh independently measured binding returned immediately before evidence. */
type IndependentlyMeasuredEvidenceBinding = {
  /** Reviewed digest of the fresh measured configuration. */
  readonly configurationHash: string
  /** All six physical TableIds derived from the fresh measurement. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
}

/**
 * Measures and closes one read-only session exactly once.
 *
 * @param resources - Detached explicit resource selection.
 * @param createSession - Read-only measurement factory.
 * @param signal - Cancellation checked before and after external work.
 * @returns Fresh configuration hash and independently observed TableIds.
 */
async function independentlyMeasureResources(
  resources: WorkspaceSearchMigrationRequestedResources,
  createSession: (
    resources: WorkspaceSearchMigrationRequestedResources,
  ) =>
    | Promise<WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession>
    | WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession,
  signal: AbortSignal,
): Promise<IndependentlyMeasuredEvidenceBinding> {
  requireActive(signal)
  let session: WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession
  try {
    session = await createSession(snapshotRequestedResources(resources))
  } catch {
    return failProvider()
  }

  let measured: WorkspaceSearchMigrationConfiguration | undefined
  let measurementFailed = false
  try {
    requireActive(signal)
    measured = await session.measureConfiguration()
    requireActive(signal)
  } catch {
    measurementFailed = true
  }

  let closeFailed = false
  try {
    await session.close()
  } catch {
    closeFailed = true
  }
  requireActive(signal)
  if (measurementFailed || measured === undefined || closeFailed) {
    return failProvider()
  }

  try {
    return {
      configurationHash:
        createWorkspaceSearchConfigurationHash(measured),
      tableIds: createMeasuredTableIds(measured),
    }
  } catch {
    return failProvider()
  }
}

/**
 * Derives all six TableIds from a fresh measured configuration.
 *
 * @param configuration - Fresh measured migration configuration.
 * @returns Detached exact role-to-TableId binding.
 */
function createMeasuredTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory': configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search': configuration.tables['workspace-search'].tableId,
    'migration-state': configuration.tables['migration-state'].tableId,
  }
}

/**
 * Compares complete role-to-TableId bindings without serializing identifiers.
 *
 * @param left - Independently measured binding.
 * @param right - Supervisor-requested binding.
 * @returns Whether every exact role has the same TableId.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationSealedPlanningTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return left['project-directory'] === right['project-directory'] &&
    left['work-items'] === right['work-items'] &&
    left.collaboration === right.collaboration &&
    left.documents === right.documents &&
    left['workspace-search'] === right['workspace-search'] &&
    left['migration-state'] === right['migration-state']
}

/**
 * Snapshots explicit resources so later caller mutation cannot redirect reads.
 *
 * @param resources - Operator-selected resources.
 * @returns Detached resource selection.
 */
function snapshotRequestedResources(
  resources: WorkspaceSearchMigrationRequestedResources,
): WorkspaceSearchMigrationRequestedResources {
  try {
    return {
      account: resources.account,
      region: resources.region,
      profile: resources.profile,
      commit: resources.commit,
      tables: {
        'project-directory': resources.tables['project-directory'],
        'work-items': resources.tables['work-items'],
        collaboration: resources.tables.collaboration,
        documents: resources.tables.documents,
        'workspace-search': resources.tables['workspace-search'],
        'migration-state': resources.tables['migration-state'],
      },
      journalBucket: resources.journalBucket,
      journalKeyArn: resources.journalKeyArn,
    }
  } catch {
    return failProvider()
  }
}

/**
 * Validates a non-empty path without returning it through failures.
 *
 * @param path - Operator-supplied file path.
 * @returns Exact path retained only inside the provider closure.
 */
function requireEvidenceFilePath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4_096 ||
    path.includes('\0')
  ) {
    return failProvider()
  }
  return path
}

/**
 * Validates one positive bounded cadence value.
 *
 * @param value - Candidate milliseconds.
 * @returns Positive safe integer no greater than one hour.
 */
function readPositiveBoundedMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60 * 60 * 1_000) {
    return failProvider()
  }
  return value
}

/**
 * Reads and validates the trusted clock.
 *
 * @param clock - Injected clock.
 * @returns Detached valid Date.
 */
function readClock(clock: () => Date): Date {
  let now: Date
  try {
    now = clock()
  } catch {
    return failProvider()
  }
  let milliseconds: number
  try {
    milliseconds = Date.prototype.getTime.call(now)
  } catch {
    return failProvider()
  }
  if (!Number.isFinite(milliseconds)) return failProvider()
  return new Date(milliseconds)
}

/**
 * Reads the trusted clock as an epoch timestamp.
 *
 * @param clock - Injected clock.
 * @returns Finite safe epoch milliseconds.
 */
function readClockMilliseconds(clock: () => Date): number {
  const milliseconds = readClock(clock).getTime()
  if (!Number.isSafeInteger(milliseconds)) return failProvider()
  return milliseconds
}

/**
 * Reads a collection timestamp that has neither regressed nor reached timeout.
 *
 * @param clock - Captured trusted clock.
 * @param startedAt - Initial collection epoch milliseconds.
 * @param deadline - Exclusive collection deadline.
 * @returns Current safe epoch milliseconds within the collection window.
 */
function readBoundedCollectionTime(
  clock: () => Date,
  startedAt: number,
  deadline: number,
): number {
  const current = readClockMilliseconds(clock)
  if (current < startedAt || current >= deadline) return failProvider()
  return current
}

/**
 * Revalidates the same evidence bytes at one current bounded observation time.
 *
 * @param evidenceBytes - Detached exact evidence bytes.
 * @param request - Detached close or post-close collection request.
 * @param observedAtMilliseconds - Current bounded epoch milliseconds.
 * @returns Whether the evidence drain starts no earlier than the required phase.
 */
function evidenceMatchesCollectionPhase(
  evidenceBytes: Uint8Array,
  request: WorkspaceSearchMigrationEvidenceRequestSnapshot,
  observedAtMilliseconds: number,
): boolean {
  const parsed = parseMaintenanceEvidence(evidenceBytes, {
    now: new Date(observedAtMilliseconds),
  })
  return request.phase === 'close' ||
    Date.parse(parsed.evidence.drainStartedAt) >=
      request.closedAtMilliseconds
}

/**
 * Rejects work after operator interruption or lease-supervisor cancellation.
 *
 * @param signal - Shared cancellation signal.
 */
function requireActive(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted) return failProvider()
}

/**
 * Reads the process wall clock.
 *
 * @returns Current detached Date.
 */
function systemEvidenceClock(): Date {
  return new Date()
}

/** Default cancelable timer used only between file observations. */
const systemEvidenceWaiter: WorkspaceSearchMigrationMaintenanceEvidenceWaiter =
  Object.freeze({
    wait: async (milliseconds: number, signal: AbortSignal): Promise<void> => {
      requireActive(signal)
      await new Promise<void>((resolve, reject) => {
        /** Rejects the bounded wait without exposing an AbortSignal reason. */
        const abort = (): void => {
          clearTimeout(timeout)
          reject(new WorkspaceSearchMigrationMaintenanceEvidenceProviderError())
        }
        const timeout = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, milliseconds)
        signal.addEventListener('abort', abort, { once: true })
      })
      requireActive(signal)
    },
  })

/**
 * Raises one fixed provider failure without retaining untrusted values.
 *
 * @returns Never returns.
 */
function failProvider(): never {
  throw new WorkspaceSearchMigrationMaintenanceEvidenceProviderError()
}
