/**
 * Runtime-control states accepted from the trusted configuration source.
 */
export type RuntimeControlMode = 'disabled' | 'enabled'

/**
 * Bounded freshness and validation states exposed to guards and telemetry.
 */
export type RuntimeControlStatus =
  | 'current'
  | 'invalid'
  | 'stale'
  | 'unavailable'

/**
 * Stable execution surfaces used by runtime-control guards and metrics.
 */
export type RuntimeControlSurface =
  | 'analytics-schedule'
  | 'api'
  | 'audit-projection'
  | 'automation-event'
  | 'automation-schedule'
  | 'connector-poll'
  | 'connector-sync'
  | 'enterprise-identity-maintenance'
  | 'enterprise-scim-group-job'
  | 'notification-schedule'
  | 'readiness'
  | 'realtime'
  | 'request-intake-email'
  | 'webhook-delivery'
  | 'work-item-import'

/**
 * Runtime-control surfaces that execute background or realtime work.
 */
export type RuntimeControlWorkerSurface = Exclude<
  RuntimeControlSurface,
  'api' | 'readiness'
>

/**
 * Exact version-one runtime-control document.
 */
export interface RuntimeControlDocument {
  /** Contract version used to validate the complete document. */
  readonly schemaVersion: 1
  /** Positive safe audit sequence; valid provider rollbacks remain authoritative. */
  readonly revision: number
  /** Global execution mode applied by every runtime surface. */
  readonly mode: RuntimeControlMode
}

/**
 * Immutable effective state returned for one request or invocation.
 */
export interface RuntimeControlSnapshot {
  /** Age of the last successfully confirmed document, when one exists. */
  readonly ageMilliseconds?: number
  /** Effective mode; every fail-closed state uses disabled. */
  readonly mode: RuntimeControlMode
  /** Last accepted document revision, when one exists. */
  readonly revision?: number
  /** Bounded freshness or validation status. */
  readonly status: RuntimeControlStatus
}

/**
 * A new configuration payload or a successful unchanged poll.
 */
export type RuntimeControlSourceResult =
  | {
    /** Indicates that AppConfig returned configuration bytes. */
    readonly kind: 'configuration'
    /** UTF-8 JSON bytes supplied by the trusted provider. */
    readonly configuration: Uint8Array
    /** Provider-required delay before the next poll. */
    readonly nextPollIntervalMilliseconds: number
  }
  | {
    /** Indicates that the provider confirmed the previously accepted version. */
    readonly kind: 'unchanged'
    /** Provider-required delay before the next poll. */
    readonly nextPollIntervalMilliseconds: number
  }

/**
 * Trusted boundary that polls one already-scoped runtime configuration.
 */
export interface RuntimeControlSource {
  /**
   * Polls the configured provider once.
   *
   * @returns A new configuration or an unchanged confirmation.
   */
  poll(): Promise<RuntimeControlSourceResult>
}

/**
 * Runtime port consumed by HTTP, readiness, and worker guards.
 */
export interface RuntimeControlProvider {
  /**
   * Returns one immutable snapshot for the calling request or invocation.
   *
   * @returns Current, stale, or fail-closed runtime state.
   */
  getSnapshot(): Promise<RuntimeControlSnapshot>
}

/**
 * Options for the polling runtime-control provider.
 */
export interface RuntimeControlProviderOptions {
  /** Trusted AppConfig or test source. */
  readonly source: RuntimeControlSource
  /** Monotonic clock used for cache and staleness decisions. */
  readonly now?: () => number
  /** Successful provider poll interval in milliseconds. */
  readonly pollIntervalMilliseconds?: number
  /** Maximum age at which a last-known-good value may still be enforced. */
  readonly maxStalenessMilliseconds?: number
  /** Initial provider-failure retry delay in milliseconds. */
  readonly retryInitialMilliseconds?: number
  /** Maximum provider-failure retry delay in milliseconds. */
  readonly retryMaxMilliseconds?: number
  /** Maximum accepted UTF-8 document size. */
  readonly maxDocumentBytes?: number
}

/**
 * Safe error thrown before a blocked worker or realtime handler begins.
 */
export class RuntimeControlBlockedError extends Error {
  /** Stable machine-readable failure code. */
  readonly code = 'RuntimeControlBlocked'
  /** Effective mode that denied execution. */
  readonly mode: RuntimeControlMode
  /** Bounded control state that denied execution. */
  readonly status: RuntimeControlStatus

  /**
   * Creates a secret-free runtime-control error.
   *
   * @param snapshot - Effective snapshot that denied execution.
   */
  constructor(snapshot: RuntimeControlSnapshot) {
    super('Runtime control does not permit this operation.')
    this.name = 'RuntimeControlBlockedError'
    this.mode = snapshot.mode
    this.status = snapshot.status
  }
}

/**
 * Safe parser error whose message never includes provider content.
 */
class RuntimeControlDocumentError extends Error {
  /** Creates a stable invalid-document error. */
  constructor() {
    super('Runtime control configuration is invalid.')
    this.name = 'RuntimeControlDocumentError'
  }
}

/**
 * Last document accepted from the source.
 */
interface AcceptedRuntimeControl {
  /** Strictly validated document. */
  readonly document: RuntimeControlDocument
  /** Last time the source confirmed this document. */
  confirmedAtMilliseconds: number
  /** Next time a source poll is required. */
  nextPollAtMilliseconds: number
}

const DEFAULT_POLL_INTERVAL_MILLISECONDS = 15_000
const DEFAULT_MAX_STALENESS_MILLISECONDS = 60_000
const DEFAULT_RETRY_INITIAL_MILLISECONDS = 250
const DEFAULT_RETRY_MAX_MILLISECONDS = 5_000
const DEFAULT_MAX_DOCUMENT_BYTES = 4 * 1024
const RUNTIME_CONTROL_DOCUMENT_KEYS: readonly string[] = [
  'mode',
  'revision',
  'schemaVersion',
]

/**
 * Parses one exact version-one runtime-control document.
 *
 * Unknown fields, invalid UTF-8, oversized content, unsupported versions,
 * and non-positive revisions are rejected without echoing source content.
 *
 * @param configuration - Candidate UTF-8 JSON bytes.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns A newly constructed immutable document.
 */
export function parseRuntimeControlDocument(
  configuration: Uint8Array,
  maximumBytes = DEFAULT_MAX_DOCUMENT_BYTES,
): RuntimeControlDocument {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    configuration.byteLength === 0 ||
    configuration.byteLength > maximumBytes
  ) {
    throw new RuntimeControlDocumentError()
  }

  let parsed: unknown
  try {
    const source = new TextDecoder('utf-8', { fatal: true })
      .decode(configuration)
    parsed = JSON.parse(source)
  } catch {
    throw new RuntimeControlDocumentError()
  }

  if (!isUnknownRecord(parsed) || Array.isArray(parsed)) {
    throw new RuntimeControlDocumentError()
  }
  const keys = Object.keys(parsed).sort()
  if (
    keys.length !== RUNTIME_CONTROL_DOCUMENT_KEYS.length ||
    keys.some((key, index) => key !== RUNTIME_CONTROL_DOCUMENT_KEYS[index])
  ) {
    throw new RuntimeControlDocumentError()
  }
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.revision !== 'number' ||
    !Number.isSafeInteger(parsed.revision) ||
    parsed.revision <= 0 ||
    (parsed.mode !== 'enabled' && parsed.mode !== 'disabled')
  ) {
    throw new RuntimeControlDocumentError()
  }

  return Object.freeze({
    schemaVersion: 1,
    revision: parsed.revision,
    mode: parsed.mode,
  })
}

/**
 * Creates a polling provider with single-flight refresh, bounded stale fallback,
 * and fail-closed invalid-configuration behavior.
 *
 * Provider exceptions alone may use a last-known-good document for at most the
 * configured staleness window. Invalid documents disable execution immediately
 * and never fall back to the previous mode. Every valid payload deployed by the
 * provider is authoritative; revision is bounded audit metadata, not a durable
 * process-external fence.
 *
 * @param options - Source, timing, retry, and size limits.
 * @returns A request-safe runtime-control provider.
 */
export function createRuntimeControlProvider(
  options: RuntimeControlProviderOptions,
): RuntimeControlProvider {
  const clock = options.now ?? (() => performance.now())
  const pollIntervalMilliseconds = readPositiveDuration(
    options.pollIntervalMilliseconds,
    DEFAULT_POLL_INTERVAL_MILLISECONDS,
    'Runtime control poll interval',
  )
  const maxStalenessMilliseconds = readPositiveDuration(
    options.maxStalenessMilliseconds,
    DEFAULT_MAX_STALENESS_MILLISECONDS,
    'Runtime control maximum staleness',
  )
  const retryInitialMilliseconds = readPositiveDuration(
    options.retryInitialMilliseconds,
    DEFAULT_RETRY_INITIAL_MILLISECONDS,
    'Runtime control retry initial delay',
  )
  const retryMaxMilliseconds = readPositiveDuration(
    options.retryMaxMilliseconds,
    DEFAULT_RETRY_MAX_MILLISECONDS,
    'Runtime control retry maximum delay',
  )
  const maxDocumentBytes = readPositiveDuration(
    options.maxDocumentBytes,
    DEFAULT_MAX_DOCUMENT_BYTES,
    'Runtime control maximum document bytes',
  )
  if (retryMaxMilliseconds < retryInitialMilliseconds) {
    throw new TypeError(
      'Runtime control retry maximum delay must be greater than or equal to the initial delay.',
    )
  }

  let accepted: AcceptedRuntimeControl | undefined
  let inFlight: Promise<RuntimeControlSnapshot> | undefined
  let blockedStatus: RuntimeControlStatus | undefined
  let failureCount = 0
  let retryAtMilliseconds = 0
  let lastClockMilliseconds = Number.NEGATIVE_INFINITY

  /**
   * Reads a finite non-decreasing timestamp.
   *
   * A regressing or invalid injected clock fails closed instead of allowing a
   * last-known-good snapshot to remain active indefinitely.
   *
   * @returns Current timestamp, or undefined when the clock is unsafe.
   */
  function readNow(): number | undefined {
    let candidate: number
    try {
      candidate = clock()
    } catch {
      return undefined
    }
    if (
      !Number.isFinite(candidate) ||
      candidate < 0 ||
      candidate < lastClockMilliseconds
    ) {
      return undefined
    }
    lastClockMilliseconds = candidate
    return candidate
  }

  /**
   * Resolves the later of the local minimum and provider-required poll delays.
   *
   * @param providerIntervalMilliseconds - Delay supplied by the source.
   * @returns Validated poll delay.
   */
  function resolvePollDelay(
    providerIntervalMilliseconds: number,
  ): number {
    if (
      !Number.isSafeInteger(providerIntervalMilliseconds) ||
      providerIntervalMilliseconds <= 0
    ) {
      throw new TypeError(
        'Runtime control source poll interval is invalid.',
      )
    }
    return Math.max(
      pollIntervalMilliseconds,
      providerIntervalMilliseconds,
    )
  }

  /**
   * Returns the effective stale or unavailable state after a source failure.
   *
   * @param checkedAtMilliseconds - Current monotonic timestamp.
   * @returns Last-known-good state within its bound, otherwise disabled.
   */
  function resolveProviderFailure(
    checkedAtMilliseconds: number,
  ): RuntimeControlSnapshot {
    if (accepted) {
      const ageMilliseconds = calculateAge(
        checkedAtMilliseconds,
        accepted.confirmedAtMilliseconds,
      )
      if (ageMilliseconds <= maxStalenessMilliseconds) {
        return createSnapshot(
          accepted.document.mode,
          'stale',
          accepted.document.revision,
          ageMilliseconds,
        )
      }
      return createSnapshot(
        'disabled',
        'unavailable',
        accepted.document.revision,
        ageMilliseconds,
      )
    }
    return createSnapshot('disabled', 'unavailable')
  }

  /**
   * Records a bounded retry window and returns a fail-closed snapshot.
   *
   * @param checkedAtMilliseconds - Current monotonic timestamp.
   * @returns Effective provider-failure snapshot.
   */
  function handleProviderFailure(
    checkedAtMilliseconds: number,
  ): RuntimeControlSnapshot {
    const exponent = Math.min(failureCount, 20)
    const retryDelay = Math.min(
      retryMaxMilliseconds,
      retryInitialMilliseconds * (2 ** exponent),
    )
    failureCount += 1
    retryAtMilliseconds = checkedAtMilliseconds + retryDelay
    if (blockedStatus === 'invalid') {
      return createSnapshot(
        'disabled',
        blockedStatus,
        accepted?.document.revision,
        accepted
          ? calculateAge(
            checkedAtMilliseconds,
            accepted.confirmedAtMilliseconds,
          )
          : undefined,
      )
    }
    blockedStatus = 'unavailable'
    return resolveProviderFailure(checkedAtMilliseconds)
  }

  /**
   * Accepts one strictly parsed provider-authoritative document.
   *
   * @param document - Strict version-one document.
   * @param checkedAtMilliseconds - Successful poll timestamp.
   * @param nextPollIntervalMilliseconds - Validated delay until the next poll.
   * @returns Current snapshot for the deployed document.
   */
  function acceptDocument(
    document: RuntimeControlDocument,
    checkedAtMilliseconds: number,
    nextPollIntervalMilliseconds: number,
  ): RuntimeControlSnapshot {
    accepted = {
      document,
      confirmedAtMilliseconds: checkedAtMilliseconds,
      nextPollAtMilliseconds:
        checkedAtMilliseconds + nextPollIntervalMilliseconds,
    }
    blockedStatus = undefined
    failureCount = 0
    retryAtMilliseconds = 0
    return createSnapshot(
      document.mode,
      'current',
      document.revision,
      0,
    )
  }

  /**
   * Polls the source and resolves one effective snapshot.
   *
   * @returns Effective snapshot after source and revision validation.
   */
  async function refresh(): Promise<RuntimeControlSnapshot> {
    let result: RuntimeControlSourceResult
    try {
      result = await options.source.poll()
    } catch {
      const failedAtMilliseconds = readNow()
      return failedAtMilliseconds === undefined
        ? createSnapshot(
            'disabled',
            'unavailable',
            accepted?.document.revision,
          )
        : handleProviderFailure(failedAtMilliseconds)
    }
    const checkedAtMilliseconds = readNow()
    if (checkedAtMilliseconds === undefined) {
      return createSnapshot(
        'disabled',
        'unavailable',
        accepted?.document.revision,
      )
    }

    let nextPollIntervalMilliseconds: number
    try {
      nextPollIntervalMilliseconds = resolvePollDelay(
        result.nextPollIntervalMilliseconds,
      )
    } catch {
      return handleProviderFailure(checkedAtMilliseconds)
    }

    if (result.kind === 'unchanged') {
      if (!accepted) {
        blockedStatus = 'unavailable'
        retryAtMilliseconds =
          checkedAtMilliseconds + nextPollIntervalMilliseconds
        return createSnapshot('disabled', 'unavailable')
      }
      if (blockedStatus === 'invalid') {
        retryAtMilliseconds = checkedAtMilliseconds +
          nextPollIntervalMilliseconds
        return createSnapshot(
          'disabled',
          blockedStatus,
          accepted.document.revision,
          calculateAge(
            checkedAtMilliseconds,
            accepted.confirmedAtMilliseconds,
          ),
        )
      }
      accepted.confirmedAtMilliseconds = checkedAtMilliseconds
      accepted.nextPollAtMilliseconds =
        checkedAtMilliseconds + nextPollIntervalMilliseconds
      blockedStatus = undefined
      failureCount = 0
      retryAtMilliseconds = 0
      return createSnapshot(
        accepted.document.mode,
        'current',
        accepted.document.revision,
        0,
      )
    }

    let document: RuntimeControlDocument
    try {
      document = parseRuntimeControlDocument(
        result.configuration,
        maxDocumentBytes,
      )
    } catch (error) {
      if (!(error instanceof RuntimeControlDocumentError)) throw error
      blockedStatus = 'invalid'
      retryAtMilliseconds =
        checkedAtMilliseconds + nextPollIntervalMilliseconds
      return createSnapshot(
        'disabled',
        'invalid',
        accepted?.document.revision,
        accepted
          ? calculateAge(
            checkedAtMilliseconds,
            accepted.confirmedAtMilliseconds,
          )
          : undefined,
      )
    }
    return acceptDocument(
      document,
      checkedAtMilliseconds,
      nextPollIntervalMilliseconds,
    )
  }

  return {
    getSnapshot() {
      const checkedAtMilliseconds = readNow()
      if (checkedAtMilliseconds === undefined) {
        return Promise.resolve(createSnapshot(
          'disabled',
          'unavailable',
          accepted?.document.revision,
        ))
      }
      if (
        accepted &&
        !blockedStatus &&
        checkedAtMilliseconds < accepted.nextPollAtMilliseconds
      ) {
        const ageMilliseconds = calculateAge(
          checkedAtMilliseconds,
          accepted.confirmedAtMilliseconds,
        )
        if (ageMilliseconds > maxStalenessMilliseconds) {
          return Promise.resolve(createSnapshot(
            'disabled',
            'unavailable',
            accepted.document.revision,
            ageMilliseconds,
          ))
        }
        return Promise.resolve(createSnapshot(
          accepted.document.mode,
          'current',
          accepted.document.revision,
          ageMilliseconds,
        ))
      }
      if (inFlight) return inFlight
      if (
        blockedStatus &&
        checkedAtMilliseconds < retryAtMilliseconds
      ) {
        if (blockedStatus === 'unavailable') {
          return Promise.resolve(
            resolveProviderFailure(checkedAtMilliseconds),
          )
        }
        return Promise.resolve(createSnapshot(
          'disabled',
          blockedStatus,
          accepted?.document.revision,
          accepted
            ? calculateAge(
              checkedAtMilliseconds,
              accepted.confirmedAtMilliseconds,
            )
            : undefined,
        ))
      }

      const pending = refresh()
        .finally(() => {
          if (inFlight === pending) inFlight = undefined
        })
      inFlight = pending
      return pending
    },
  }
}

/**
 * Creates a deterministic current provider for local development and tests.
 *
 * @param mode - Static mode returned for every operation.
 * @param revision - Positive safe revision used by telemetry and tests.
 * @returns An immutable static runtime-control provider.
 */
export function createStaticRuntimeControlProvider(
  mode: RuntimeControlMode = 'enabled',
  revision = 1,
): RuntimeControlProvider {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new TypeError(
      'Static runtime control revision must be a positive safe integer.',
    )
  }
  const snapshot = createSnapshot(mode, 'current', revision, 0)
  return Object.freeze({
    async getSnapshot() {
      return snapshot
    },
  })
}

/**
 * Returns whether a snapshot permits API or worker execution.
 *
 * A current enabled snapshot is allowed. A stale enabled snapshot is allowed
 * only because the provider has already bounded it to the last-known-good
 * window. Every other state is fail closed.
 *
 * @param snapshot - Effective request or invocation snapshot.
 * @returns Whether execution may begin.
 */
export function runtimeControlAllowsExecution(
  snapshot: RuntimeControlSnapshot,
): boolean {
  return snapshot.mode === 'enabled' &&
    (snapshot.status === 'current' || snapshot.status === 'stale')
}

/**
 * Returns whether a snapshot is healthy enough to admit new traffic.
 *
 * @param snapshot - Effective readiness snapshot.
 * @returns Whether the state is current and enabled.
 */
export function runtimeControlIsReady(
  snapshot: RuntimeControlSnapshot,
): boolean {
  return snapshot.mode === 'enabled' && snapshot.status === 'current'
}

/**
 * Constructs a frozen effective snapshot.
 *
 * @param mode - Effective mode.
 * @param status - Bounded state.
 * @param revision - Optional accepted revision.
 * @param ageMilliseconds - Optional non-negative age.
 * @returns Frozen runtime-control snapshot.
 */
function createSnapshot(
  mode: RuntimeControlMode,
  status: RuntimeControlStatus,
  revision?: number,
  ageMilliseconds?: number,
): RuntimeControlSnapshot {
  return Object.freeze({
    mode,
    status,
    ...(revision === undefined ? {} : { revision }),
    ...(ageMilliseconds === undefined
      ? {}
      : { ageMilliseconds: Math.max(0, ageMilliseconds) }),
  })
}

/**
 * Calculates a non-negative age from a monotonic clock.
 *
 * @param current - Current timestamp.
 * @param confirmed - Last confirmation timestamp.
 * @returns Non-negative elapsed milliseconds.
 */
function calculateAge(current: number, confirmed: number): number {
  return Math.max(0, current - confirmed)
}

/**
 * Resolves a positive safe integer duration.
 *
 * @param value - Optional override.
 * @param fallback - Default duration.
 * @param label - Safe validation label.
 * @returns Validated duration.
 */
function readPositiveDuration(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const duration = value ?? fallback
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`)
  }
  return duration
}

/**
 * Checks whether a value is a non-null string-keyed object.
 *
 * @param value - Unknown parsed JSON value.
 * @returns Whether object properties can be inspected safely.
 */
function isUnknownRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
