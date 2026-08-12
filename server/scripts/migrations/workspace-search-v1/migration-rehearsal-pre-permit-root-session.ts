import { types as nodeUtilTypes } from 'node:util'
import type {
  CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  createWorkspaceSearchConfigurationHash,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalIntegrityRateSequence,
} from './migration-rehearsal-integrity-rate-adapter'
import type {
  WorkspaceSearchMigrationRehearsalRootMeasurementPort,
} from './migration-rehearsal-root-measurement'

/** Stable raw-value-free failure for the pre-permit root AWS session. */
const invalidPrePermitRootSessionMessage =
  'INVALID_REHEARSAL_PRE_PERMIT_ROOT_SESSION'

/** Exact number of rate-owned calls in each root operation. */
const rootOperationDescribeTableCallCount = 6

/** Exact final number of rate-owned calls in a sealed root. */
const sealedRootDescribeTableCallCount = 12

/** Exact fields of the trusted core session construction. */
const rootSessionInputKeys = Object.freeze([
  'attestationOperation',
  'closeMeasurementPort',
  'expectedConfigurationBindingDigest',
  'expectedPolicyVersion',
  'measurementPort',
  'rate',
  'timeline',
])

/** Exact methods of the narrow measurement projection. */
const rootMeasurementPortKeys = Object.freeze([
  'measureConfiguration',
  'readDescribeTableRateEvidence',
])

/** Exact methods of the one-shot attestation operation. */
const rootAttestationOperationKeys = Object.freeze(['close', 'run'])

/** Lifecycle states retained by the one-way root session. */
type PrePermitRootSessionState =
  | 'ready'
  | 'measuring'
  | 'measured'
  | 'attesting'
  | 'attested'
  | 'sealing'
  | 'sealed'
  | 'failed'
  | 'closed'

/** Trusted clocks and cancellation used by the complete pre-permit root. */
export type CreateWorkspaceSearchMigrationRehearsalRootTimelineInput = {
  /** Complete non-resettable root duration bound in milliseconds. */
  readonly maximumDurationMilliseconds: number
  /** Optional caller cancellation combined with the root deadline. */
  readonly signal?: AbortSignal
  /** Trusted non-negative process-monotonic clock. */
  readonly monotonicClock: () => number
  /** Trusted canonical wall clock sampled around every external boundary. */
  readonly wallClock: () => Date
}

/** Shared non-resettable deadline beginning before the first STS service read. */
export interface WorkspaceSearchMigrationRehearsalRootTimeline {
  /** Canonical wall-clock start sampled before any external read. */
  readonly startedAt: string
  /** Combined timeout, caller, and explicit-interruption signal. */
  readonly signal: AbortSignal

  /**
   * Runs one external boundary inside the remaining root deadline.
   *
   * @param operation - Exact operation receiving the combined signal.
   * @returns Exact successful operation result.
   */
  run<Result>(
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result>

  /** Permanently interrupts every not-yet-completed root operation. */
  interrupt(): void

  /**
   * Samples the canonical completion time after every owned close settles.
   *
   * @returns Canonical root completion timestamp.
   */
  readCompletionTimestamp(): string
}

/** One exact rate-owned immutable-resource attestation result. */
export type WorkspaceSearchMigrationRehearsalRootAttestationOperationResult = {
  /** Exact object reference returned by the adapter-owned reader task. */
  readonly resourceAttestation: CrossDomainIntegrityResourceAttestation
  /** Fresh one-shot proof of the exact ordered six DescribeTable calls. */
  readonly sequence: WorkspaceSearchMigrationRehearsalIntegrityRateSequence
}

/** Narrow one-shot attestation operation retained only by the root session. */
export interface WorkspaceSearchMigrationRehearsalRootAttestationOperation {
  /**
   * Measures the exact six table incarnations and immutable File marker once.
   *
   * @param signal - Complete non-resettable root deadline signal.
   * @returns Exact attestation reference and its rate sequence capability.
   */
  run(
    signal: AbortSignal,
  ): Promise<WorkspaceSearchMigrationRehearsalRootAttestationOperationResult>

  /** Releases the dedicated read-only attestation transport. */
  close(): void
}

/** Trusted dependencies composing the one-way pre-permit root state machine. */
export type CreateWorkspaceSearchMigrationRehearsalPrePermitRootSessionInput = {
  /** Existing managed six-table measurement port retained privately. */
  readonly measurementPort:
    WorkspaceSearchMigrationRehearsalRootMeasurementPort
  /** Releases the measurement and checkpoint transport after rate drainage. */
  readonly closeMeasurementPort: () => Promise<void>
  /** Existing managed rate owner with fixed root construction authority. */
  readonly rate: WorkspaceSearchMigrationManagedDescribeTableRate
  /** Exact one-shot immutable-resource attestation operation. */
  readonly attestationOperation:
    WorkspaceSearchMigrationRehearsalRootAttestationOperation
  /** Reviewed digest required of the exact measured configuration. */
  readonly expectedConfigurationBindingDigest: string
  /** Reviewed durable rate policy digest. */
  readonly expectedPolicyVersion: string
  /** Complete timeline that already began before remote preflight. */
  readonly timeline: WorkspaceSearchMigrationRehearsalRootTimeline
}

/** Final clean root transport evidence and exact attestation capability. */
export type WorkspaceSearchMigrationRehearsalPrePermitRootSeal = {
  /** Trusted root start preceding STS, journal tags, and rate I/O. */
  readonly startedAt: string
  /** Trusted root completion after final rate and transport drainage. */
  readonly completedAt: string
  /** Exact final clean durable aggregate for all twelve root attempts. */
  readonly durableEvidence: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Exact attestation object reference returned by the adapter task. */
  readonly resourceAttestation: CrossDomainIntegrityResourceAttestation
  /** Fresh one-shot exact-six attestation sequence proof. */
  readonly sequence: WorkspaceSearchMigrationRehearsalIntegrityRateSequence
}

/** Only public capabilities exposed by the dedicated pre-permit root. */
export interface WorkspaceSearchMigrationRehearsalPrePermitRootSession {
  /**
   * Takes the exact two-method root measurement port once.
   *
   * @returns Frozen receiver-safe first-operation measurement port.
   */
  takeMeasurementPort():
    WorkspaceSearchMigrationRehearsalRootMeasurementPort

  /**
   * Runs the one exact-six immutable-resource attestation after measurement.
   *
   * @returns The exact private attestation object; its sequence remains sealed.
   */
  attestResources(): Promise<CrossDomainIntegrityResourceAttestation>

  /**
   * Stops all rate admission, drains transports, and returns clean root facts.
   *
   * @returns Final aggregate, chronology, attestation, and sequence capability.
   */
  seal(): Promise<WorkspaceSearchMigrationRehearsalPrePermitRootSeal>

  /** Starts fail-closed interruption and asynchronous owned-resource drainage. */
  interrupt(): void

  /**
   * Permanently closes the root without minting seal evidence.
   *
   * @returns Completion after every owned rate and transport close settles.
   */
  close(): Promise<void>
}

/** Stable root-session error without AWS, resource, or credential material. */
export class WorkspaceSearchMigrationRehearsalPrePermitRootSessionError
  extends Error {
  /** Stable machine-readable pre-permit session failure code. */
  readonly code = invalidPrePermitRootSessionMessage

  /** Creates the sole external pre-permit root-session failure. */
  constructor() {
    super(invalidPrePermitRootSessionMessage)
    this.name =
      'WorkspaceSearchMigrationRehearsalPrePermitRootSessionError'
  }
}

/** Mutable implementation of one non-resettable trusted root timeline. */
class RehearsalRootTimeline
  implements WorkspaceSearchMigrationRehearsalRootTimeline {
  /** Canonical wall-clock start sampled before any remote read. */
  readonly startedAt: string

  /** Combined timeout, caller, and explicit interruption signal. */
  readonly signal: AbortSignal

  /** Complete reviewed duration bound. */
  readonly #maximumDurationMilliseconds: number

  /** Trusted process-monotonic clock. */
  readonly #monotonicClock: () => number

  /** Trusted canonical wall clock. */
  readonly #wallClock: () => Date

  /** Explicit interruption owned by this timeline. */
  readonly #interruptController = new AbortController()

  /** First trusted monotonic sample. */
  readonly #startedMonotonic: number

  /** First trusted wall-clock milliseconds. */
  readonly #startedWallMilliseconds: number

  /** Most recent nondecreasing monotonic sample. */
  #lastMonotonic: number

  /** Most recent nondecreasing wall-clock sample. */
  #lastWallMilliseconds: number

  /** Creates a complete root timeline before any client construction. */
  constructor(
    snapshot: CreateWorkspaceSearchMigrationRehearsalRootTimelineInput,
  ) {
    this.#maximumDurationMilliseconds =
      snapshot.maximumDurationMilliseconds
    this.#monotonicClock = snapshot.monotonicClock
    this.#wallClock = snapshot.wallClock
    this.#startedMonotonic = readMonotonicClock(this.#monotonicClock)
    this.#lastMonotonic = this.#startedMonotonic
    const started = readWallClock(this.#wallClock)
    this.#startedWallMilliseconds = started.milliseconds
    this.#lastWallMilliseconds = started.milliseconds
    this.startedAt = started.canonical
    const timeoutSignal = AbortSignal.timeout(
      snapshot.maximumDurationMilliseconds,
    )
    this.signal = snapshot.signal === undefined
      ? AbortSignal.any([timeoutSignal, this.#interruptController.signal])
      : AbortSignal.any([
        snapshot.signal,
        timeoutSignal,
        this.#interruptController.signal,
      ])
    this.#assertActive()
  }

  /** Runs one exact external operation within this root timeline. */
  async run<Result>(
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (
      typeof operation !== 'function' ||
      nodeUtilTypes.isProxy(operation)
    ) return failPrePermitRootSession()
    this.#assertActive()
    const result = await awaitWithinRootSignal(
      operation(this.signal),
      this.signal,
    )
    this.#assertActive()
    return result
  }

  /** Permanently interrupts this complete root timeline. */
  interrupt(): void {
    this.#interruptController.abort()
  }

  /** Samples canonical completion after all owned close operations. */
  readCompletionTimestamp(): string {
    return this.#assertActive().canonical
  }

  /** Validates nondecreasing clocks and the complete non-resettable bound. */
  #assertActive(): TrustedWallClockSample {
    if (this.signal?.aborted === true) {
      return failPrePermitRootSession()
    }
    const monotonic = readMonotonicClock(this.#monotonicClock)
    const wall = readWallClock(this.#wallClock)
    if (
      monotonic < this.#lastMonotonic ||
      monotonic - this.#startedMonotonic >
        this.#maximumDurationMilliseconds ||
      wall.milliseconds < this.#lastWallMilliseconds ||
      wall.milliseconds - this.#startedWallMilliseconds >
        this.#maximumDurationMilliseconds
    ) return failPrePermitRootSession()
    this.#lastMonotonic = monotonic
    this.#lastWallMilliseconds = wall.milliseconds
    return wall
  }
}

/** Trusted detached wall-clock sample. */
type TrustedWallClockSample = {
  /** Canonical UTC timestamp. */
  readonly canonical: string
  /** Finite Unix epoch milliseconds. */
  readonly milliseconds: number
}

/** One-way root state machine retaining no generic transport capability. */
class PrePermitRootSession
  implements WorkspaceSearchMigrationRehearsalPrePermitRootSession {
  /** Privately retained six-table measurement port. */
  readonly #measurementPort:
    WorkspaceSearchMigrationRehearsalRootMeasurementPort

  /** Releases the measurement/checkpoint transport. */
  readonly #closeMeasurementPort: () => Promise<void>

  /** Privately retained managed DescribeTable rate owner. */
  readonly #rate: WorkspaceSearchMigrationManagedDescribeTableRate

  /** Privately retained one-shot resource-attestation operation. */
  readonly #attestationOperation:
    WorkspaceSearchMigrationRehearsalRootAttestationOperation

  /** Reviewed configuration digest required before attestation can begin. */
  readonly #expectedConfigurationBindingDigest: string

  /** Reviewed policy digest required at every aggregate boundary. */
  readonly #expectedPolicyVersion: string

  /** Complete timeline already active before STS preflight. */
  readonly #timeline: WorkspaceSearchMigrationRehearsalRootTimeline

  /** Current one-way lifecycle state. */
  #state: PrePermitRootSessionState = 'ready'

  /** Whether the exact measurement projection was already taken. */
  #measurementPortTaken = false

  /** Exact completed attestation retained until sealing. */
  #attestation:
    WorkspaceSearchMigrationRehearsalRootAttestationOperationResult |
    undefined

  /** Exact-once owned close completion. */
  #closeCompletion: Promise<void> | undefined

  /** Exact-once successful seal completion. */
  #sealCompletion:
    Promise<WorkspaceSearchMigrationRehearsalPrePermitRootSeal> |
    undefined

  /** Creates one trusted core session from already authenticated dependencies. */
  constructor(
    input: CreateWorkspaceSearchMigrationRehearsalPrePermitRootSessionInput,
  ) {
    this.#measurementPort = input.measurementPort
    this.#closeMeasurementPort = input.closeMeasurementPort
    this.#rate = input.rate
    this.#attestationOperation = input.attestationOperation
    this.#expectedConfigurationBindingDigest =
      input.expectedConfigurationBindingDigest
    this.#expectedPolicyVersion = input.expectedPolicyVersion
    this.#timeline = input.timeline
    requireInitialRateEvidence(
      this.#rate.readEvidence(),
      this.#expectedPolicyVersion,
    )
    this.#timeline.signal.addEventListener(
      'abort',
      () => this.interrupt(),
      { once: true },
    )
  }

  /** Takes one frozen receiver-safe root measurement projection. */
  takeMeasurementPort():
    WorkspaceSearchMigrationRehearsalRootMeasurementPort {
    if (this.#state !== 'ready' || this.#measurementPortTaken) {
      this.interrupt()
      return failPrePermitRootSession()
    }
    this.#measurementPortTaken = true
    return Object.freeze({
      measureConfiguration: async () => {
        if (this.#state !== 'ready') {
          await this.#failAndClose()
          return failPrePermitRootSession()
        }
        this.#state = 'measuring'
        try {
          requireInitialRateEvidence(
            this.#rate.readEvidence(),
            this.#expectedPolicyVersion,
          )
          const configuration = await this.#timeline.run(
            async () => {
              const measured =
                await this.#measurementPort.measureConfiguration()
              if (
                createWorkspaceSearchConfigurationHash(measured) !==
                  this.#expectedConfigurationBindingDigest
              ) return failPrePermitRootSession()
              return measured
            },
          )
          requireMeasurementRateEvidence(
            this.#rate.readEvidence(),
            this.#expectedPolicyVersion,
          )
          this.#state = 'measured'
          return configuration
        } catch {
          await this.#failAndClose()
          return failPrePermitRootSession()
        }
      },
      readDescribeTableRateEvidence: () => {
        if (
          this.#state === 'failed' ||
          this.#state === 'closed' ||
          this.#state === 'sealed'
        ) return failPrePermitRootSession()
        return Object.freeze({ ...this.#rate.readEvidence() })
      },
    })
  }

  /** Runs the exact second root operation once. */
  async attestResources(): Promise<CrossDomainIntegrityResourceAttestation> {
    if (this.#state !== 'measured') {
      await this.#failAndClose()
      return failPrePermitRootSession()
    }
    this.#state = 'attesting'
    try {
      requireMeasurementRateEvidence(
        this.#rate.readEvidence(),
        this.#expectedPolicyVersion,
      )
      const attestation = await this.#timeline.run(
        async (signal) => await this.#attestationOperation.run(signal),
      )
      requireAttestationSequence(attestation.sequence)
      requireAttestationRateEvidence(
        this.#rate.readEvidence(),
        this.#expectedPolicyVersion,
      )
      this.#attestation = attestation
      this.#state = 'attested'
      return attestation.resourceAttestation
    } catch {
      await this.#failAndClose()
      return failPrePermitRootSession()
    }
  }

  /** Seals and drains the exact completed root once. */
  seal(): Promise<WorkspaceSearchMigrationRehearsalPrePermitRootSeal> {
    const existing = this.#sealCompletion
    if (existing !== undefined) return existing
    if (this.#state !== 'attested' || this.#attestation === undefined) {
      return this.#failAndClose().then(
        () => failPrePermitRootSession(),
      )
    }
    this.#state = 'sealing'
    const attestation = this.#attestation
    const completion = this.#sealRoot(attestation)
    this.#sealCompletion = completion
    return completion
  }

  /** Starts interruption and asynchronous exact-once drainage. */
  interrupt(): void {
    if (
      this.#state === 'closed' ||
      this.#state === 'failed' ||
      this.#state === 'sealed'
    ) return
    this.#timeline.interrupt()
    this.#rate.interrupt()
    void this.close().catch(() => undefined)
  }

  /** Permanently closes every owned dependency without returning evidence. */
  close(): Promise<void> {
    const existing = this.#closeCompletion
    if (existing !== undefined) return existing
    if (this.#state !== 'sealed' && this.#state !== 'failed') {
      this.#state = 'closed'
    }
    this.#timeline.interrupt()
    this.#rate.interrupt()
    const completion = closeRootDependencies(
      this.#rate,
      this.#closeMeasurementPort,
      this.#attestationOperation,
    )
    this.#closeCompletion = completion
    return completion
  }

  /** Seals the rate owner before closing either borrowed AWS transport. */
  async #sealRoot(
    attestation:
      WorkspaceSearchMigrationRehearsalRootAttestationOperationResult,
  ): Promise<WorkspaceSearchMigrationRehearsalPrePermitRootSeal> {
    try {
      const durableEvidence = await this.#timeline.run(
        async () => await this.#rate.closeAndReadEvidence(),
      )
      requireAttestationRateEvidence(
        durableEvidence,
        this.#expectedPolicyVersion,
      )
      await this.#closeMeasurementPort()
      this.#attestationOperation.close()
      const completedAt = this.#timeline.readCompletionTimestamp()
      const seal = Object.freeze({
        startedAt: this.#timeline.startedAt,
        completedAt,
        durableEvidence: Object.freeze({ ...durableEvidence }),
        resourceAttestation: attestation.resourceAttestation,
        sequence: attestation.sequence,
      })
      this.#state = 'sealed'
      this.#closeCompletion = Promise.resolve()
      return seal
    } catch {
      await this.#failAndClose()
      return failPrePermitRootSession()
    }
  }

  /** Marks failure and drains every dependency without masking the failure. */
  async #failAndClose(): Promise<void> {
    this.#state = 'failed'
    this.#timeline.interrupt()
    this.#rate.interrupt()
    try {
      await this.close()
    } catch {
      // The stable root failure intentionally hides close implementation data.
    }
  }
}

/** Creates the shared root timeline before any AWS client is constructed. */
export function createWorkspaceSearchMigrationRehearsalRootTimeline(
  input: CreateWorkspaceSearchMigrationRehearsalRootTimelineInput,
): WorkspaceSearchMigrationRehearsalRootTimeline {
  requireTimelineInput(input)
  return new RehearsalRootTimeline(input)
}

/** Creates one capability-narrow pre-permit root state machine. */
export function createWorkspaceSearchMigrationRehearsalPrePermitRootSession(
  input: CreateWorkspaceSearchMigrationRehearsalPrePermitRootSessionInput,
): WorkspaceSearchMigrationRehearsalPrePermitRootSession {
  requireRootSessionInput(input)
  return new PrePermitRootSession(input)
}

/** Validates trusted timeline construction before its first clock sample. */
function requireTimelineInput(
  input: CreateWorkspaceSearchMigrationRehearsalRootTimelineInput,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input)
  ) return failPrePermitRootSession()
  const prototype = Object.getPrototypeOf(input)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    (prototype !== null && nodeUtilTypes.isProxy(prototype))
  ) return failPrePermitRootSession()
  const keys = Reflect.ownKeys(input)
  const allowedKeys = new Set([
    'maximumDurationMilliseconds',
    'monotonicClock',
    'signal',
    'wallClock',
  ])
  if (
    !Object.hasOwn(input, 'maximumDurationMilliseconds') ||
    !Object.hasOwn(input, 'monotonicClock') ||
    !Object.hasOwn(input, 'wallClock')
  ) return failPrePermitRootSession()
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      return failPrePermitRootSession()
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) return failPrePermitRootSession()
  }
  if (
    typeof input.maximumDurationMilliseconds !== 'number' ||
    !Number.isSafeInteger(input.maximumDurationMilliseconds) ||
    input.maximumDurationMilliseconds <= 0 ||
    (input.signal !== undefined &&
      (!(input.signal instanceof AbortSignal) ||
        nodeUtilTypes.isProxy(input.signal))) ||
    typeof input.monotonicClock !== 'function' ||
    nodeUtilTypes.isProxy(input.monotonicClock) ||
    typeof input.wallClock !== 'function' ||
    nodeUtilTypes.isProxy(input.wallClock)
  ) return failPrePermitRootSession()
}

/** Validates trusted core dependencies before retaining their capabilities. */
function requireRootSessionInput(
  input: CreateWorkspaceSearchMigrationRehearsalPrePermitRootSessionInput,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    nodeUtilTypes.isProxy(input)
  ) return failPrePermitRootSession()
  requireOwnDataRecord(input, rootSessionInputKeys)
  if (
    typeof input.measurementPort !== 'object' ||
    input.measurementPort === null ||
    nodeUtilTypes.isProxy(input.measurementPort)
  ) return failPrePermitRootSession()
  requireOwnDataRecord(input.measurementPort, rootMeasurementPortKeys)
  if (
    typeof input.measurementPort.measureConfiguration !== 'function' ||
    nodeUtilTypes.isProxy(input.measurementPort.measureConfiguration) ||
    typeof input.measurementPort.readDescribeTableRateEvidence !==
      'function' ||
    nodeUtilTypes.isProxy(
      input.measurementPort.readDescribeTableRateEvidence,
    ) ||
    typeof input.closeMeasurementPort !== 'function' ||
    nodeUtilTypes.isProxy(input.closeMeasurementPort) ||
    typeof input.rate !== 'object' ||
    input.rate === null ||
    nodeUtilTypes.isProxy(input.rate) ||
    typeof input.attestationOperation !== 'object' ||
    input.attestationOperation === null ||
    nodeUtilTypes.isProxy(input.attestationOperation)
  ) return failPrePermitRootSession()
  requireOwnDataRecord(
    input.attestationOperation,
    rootAttestationOperationKeys,
  )
  if (
    typeof input.attestationOperation.run !== 'function' ||
    nodeUtilTypes.isProxy(input.attestationOperation.run) ||
    typeof input.attestationOperation.close !== 'function' ||
    nodeUtilTypes.isProxy(input.attestationOperation.close) ||
    !/^[0-9a-f]{64}$/u.test(
      input.expectedConfigurationBindingDigest,
    ) ||
    !/^[0-9a-f]{64}$/u.test(input.expectedPolicyVersion) ||
    typeof input.timeline !== 'object' ||
    input.timeline === null ||
    nodeUtilTypes.isProxy(input.timeline)
  ) return failPrePermitRootSession()
}

/**
 * Requires one ordinary construction object to contain exact own data fields.
 *
 * @param value - Trusted-boundary object candidate.
 * @param expectedKeys - Exact sorted-independent own string keys.
 */
function requireOwnDataRecord(
  value: object,
  expectedKeys: readonly string[],
): void {
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return failPrePermitRootSession()
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    (prototype !== null && nodeUtilTypes.isProxy(prototype)) ||
    keys.length !== expectedKeys.length
  ) return failPrePermitRootSession()
  const expected = new Set(expectedKeys)
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.has(key)) {
      return failPrePermitRootSession()
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value')
    ) return failPrePermitRootSession()
  }
}

/** Requires the pristine root ledger before the six-table measurement. */
function requireInitialRateEvidence(
  evidence: WorkspaceSearchMigrationDescribeTableRateEvidence,
  policyVersion: string,
): void {
  requireCleanRateEvidence(evidence, policyVersion, 0, 0)
}

/** Requires exactly six first-operation measurement calls. */
function requireMeasurementRateEvidence(
  evidence: WorkspaceSearchMigrationDescribeTableRateEvidence,
  policyVersion: string,
): void {
  requireCleanRateEvidence(
    evidence,
    policyVersion,
    rootOperationDescribeTableCallCount,
    1,
  )
}

/** Requires exactly six additional attestation calls. */
function requireAttestationRateEvidence(
  evidence: WorkspaceSearchMigrationDescribeTableRateEvidence,
  policyVersion: string,
): void {
  requireCleanRateEvidence(
    evidence,
    policyVersion,
    sealedRootDescribeTableCallCount,
    1,
  )
}

/** Requires one exact clean aggregate without throttles or forfeitures. */
function requireCleanRateEvidence(
  evidence: WorkspaceSearchMigrationDescribeTableRateEvidence,
  policyVersion: string,
  attemptCount: number,
  maximumInFlight: 0 | 1,
): void {
  if (
    evidence.version !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION ||
    evidence.policyVersion !== policyVersion ||
    evidence.attemptCount !== attemptCount ||
    evidence.forfeitedAttemptCount !== 0 ||
    evidence.throttleCount !== 0 ||
    evidence.budgetStopCount !== 0 ||
    !Number.isSafeInteger(evidence.cadenceWaitCount) ||
    evidence.cadenceWaitCount < 0 ||
    !Number.isSafeInteger(evidence.cadenceWaitMilliseconds) ||
    evidence.cadenceWaitMilliseconds < 0 ||
    evidence.maximumInFlight !== maximumInFlight
  ) return failPrePermitRootSession()
}

/** Requires the attestation adapter to own global attempts seven through twelve. */
function requireAttestationSequence(
  sequence: WorkspaceSearchMigrationRehearsalIntegrityRateSequence,
): void {
  if (
    sequence.kind !==
      'mukuroji-workspace-search-migration-rehearsal-integrity-rate-sequence' ||
    sequence.version !== 1 ||
    sequence.phase !== 'integrity-check' ||
    sequence.tablePassCount !== 1 ||
    sequence.describeTableCallCount !==
      rootOperationDescribeTableCallCount ||
    sequence.firstAttemptSequence !== 7 ||
    sequence.lastAttemptSequence !== sealedRootDescribeTableCallCount ||
    !/^[0-9a-f]{64}$/u.test(sequence.tableOrderBindingDigest)
  ) return failPrePermitRootSession()
}

/** Reads one finite non-negative process-monotonic sample. */
function readMonotonicClock(clock: () => number): number {
  let value: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
  } catch {
    return failPrePermitRootSession()
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) return failPrePermitRootSession()
  return value
}

/** Reads one finite trusted wall-clock sample as a detached canonical value. */
function readWallClock(clock: () => Date): TrustedWallClockSample {
  let value: unknown
  let milliseconds: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
    if (nodeUtilTypes.isProxy(value)) return failPrePermitRootSession()
    milliseconds = Reflect.apply(Date.prototype.getTime, value, [])
  } catch {
    return failPrePermitRootSession()
  }
  if (
    typeof milliseconds !== 'number' ||
    !Number.isFinite(milliseconds)
  ) return failPrePermitRootSession()
  return Object.freeze({
    canonical: new Date(milliseconds).toISOString(),
    milliseconds,
  })
}

/** Races one external operation against the complete combined root signal. */
async function awaitWithinRootSignal<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  if (signal.aborted) return failPrePermitRootSession()
  return await new Promise<Result>((resolve, reject) => {
    let settled = false
    /** Rejects this boundary without forwarding a caller-provided reason. */
    const abort = (): void => {
      if (settled) return
      settled = true
      reject(new WorkspaceSearchMigrationRehearsalPrePermitRootSessionError())
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (result) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(result)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** Drains rate ownership before closing both borrowed AWS transports. */
async function closeRootDependencies(
  rate: WorkspaceSearchMigrationManagedDescribeTableRate,
  closeMeasurementPort: () => Promise<void>,
  attestationOperation:
    WorkspaceSearchMigrationRehearsalRootAttestationOperation,
): Promise<void> {
  let firstFailure: unknown
  try {
    await rate.close()
  } catch (error: unknown) {
    firstFailure = error
  }
  try {
    await closeMeasurementPort()
  } catch (error: unknown) {
    firstFailure ??= error
  }
  try {
    attestationOperation.close()
  } catch (error: unknown) {
    firstFailure ??= error
  }
  if (firstFailure !== undefined) return failPrePermitRootSession()
}

/** Raises the sole stable raw-value-free root-session failure. */
function failPrePermitRootSession(): never {
  throw new WorkspaceSearchMigrationRehearsalPrePermitRootSessionError()
}
