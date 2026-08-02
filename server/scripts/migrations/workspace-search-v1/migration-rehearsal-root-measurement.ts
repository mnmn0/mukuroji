import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  type WorkspaceSearchMigrationConfiguration,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Fixed runtime discriminator for one causal root configuration measurement. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_MEASUREMENT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-root-measurement'

/** Initial process-local root measurement capability contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_MEASUREMENT_VERSION = 1

/** Exact number of physical DescribeTable calls owned by root measurement. */
const rootMeasurementDescribeTableCallCount = 6

/** Stable raw-value-free failure for every invalid root measurement. */
const invalidRootMeasurementMessage =
  'INVALID_REHEARSAL_ROOT_MEASUREMENT'

/** Exact top-level fields of one measured migration configuration. */
const measuredConfigurationKeys = Object.freeze([
  'account',
  'callerArn',
  'callerRoleId',
  'commit',
  'journal',
  'journalPrefix',
  'migrationId',
  'migrationVersion',
  'profile',
  'region',
  'tables',
])

/** Exact fields accepted on the trusted narrow measurement port. */
const rootMeasurementPortKeys = Object.freeze([
  'measureConfiguration',
  'readDescribeTableRateEvidence',
])

/** Exact fields accepted by the root measurement adapter. */
const rootMeasurementInputKeys = Object.freeze([
  'expectedConfigurationBindingDigest',
  'port',
])

/** Exact fields of one durable DescribeTable aggregate snapshot. */
const rateEvidenceKeys = Object.freeze([
  'attemptCount',
  'budgetStopCount',
  'cadenceWaitCount',
  'cadenceWaitMilliseconds',
  'forfeitedAttemptCount',
  'maximumInFlight',
  'policyVersion',
  'throttleCount',
  'version',
])

/** Trusted composition surface with no mutation or raw transport authority. */
export interface WorkspaceSearchMigrationRehearsalRootMeasurementPort {
  /**
   * Measures the exact six-table migration configuration once.
   *
   * @returns Exact configuration produced by the managed measurement session.
   */
  measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration>

  /**
   * Reads the current secret-free durable DescribeTable aggregate.
   *
   * @returns Current cumulative rate evidence for the shared root ledger.
   */
  readDescribeTableRateEvidence():
    WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Input for the causal first-operation root measurement adapter. */
export type MeasureWorkspaceSearchMigrationRehearsalRootConfigurationInput = {
  /** Exact two-method trusted composition surface. */
  readonly port: WorkspaceSearchMigrationRehearsalRootMeasurementPort
  /** Reviewed configuration digest that the measured result must reproduce. */
  readonly expectedConfigurationBindingDigest: string
}

/** Secret-free claims retained by one genuine root measurement capability. */
export type WorkspaceSearchMigrationRehearsalRootMeasurementClaims = {
  /** Fixed process-local capability discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_MEASUREMENT_KIND
  /** Initial root measurement capability version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_MEASUREMENT_VERSION
  /** First global attempt owned by the initial six-table measurement. */
  readonly firstAttemptSequence: 1
  /** Last global attempt owned by the initial six-table measurement. */
  readonly lastAttemptSequence: 6
  /** Digest of the exact measured migration configuration. */
  readonly configurationBindingDigest: string
  /** Stable reviewed policy shared by the before and after snapshots. */
  readonly policyVersion: string
}

/** One-shot structural surface backed by module-private causal state. */
export type WorkspaceSearchMigrationRehearsalRootMeasurementCapability =
  WorkspaceSearchMigrationRehearsalRootMeasurementClaims

/** Exact measured configuration paired with its one-shot causal authority. */
export type WorkspaceSearchMigrationRehearsalRootMeasurement = {
  /** Exact object reference returned by the trusted measurement port. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Fresh capability retaining that exact reference and its full digest. */
  readonly capability:
    WorkspaceSearchMigrationRehearsalRootMeasurementCapability
}

/** Stable root measurement failure without configuration or rate details. */
export class WorkspaceSearchMigrationRehearsalRootMeasurementError
  extends Error {
  /** Stable machine-readable root measurement failure code. */
  readonly code = invalidRootMeasurementMessage

  /** Creates the sole public root measurement failure. */
  constructor() {
    super(invalidRootMeasurementMessage)
    this.name = 'WorkspaceSearchMigrationRehearsalRootMeasurementError'
  }
}

/** Detached callable snapshot captured before the first rate read. */
type RootMeasurementInputSnapshot = {
  /** Calls the exact captured managed configuration measurement method. */
  readonly measureConfiguration:
    () => Promise<WorkspaceSearchMigrationConfiguration>
  /** Calls the exact captured durable aggregate reader. */
  readonly readDescribeTableRateEvidence:
    () => WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Reviewed configuration binding required of the exact result. */
  readonly expectedConfigurationBindingDigest: string
}

/** Detached strictly parsed cumulative rate evidence. */
type RootMeasurementRateSnapshot = {
  /** Exact rate evidence contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
  /** Stable reviewed policy digest. */
  readonly policyVersion: string
  /** Cumulative conservatively charged attempt count. */
  readonly attemptCount: number
  /** Cumulative interrupted-attempt forfeiture count. */
  readonly forfeitedAttemptCount: number
  /** Cumulative throttled attempt count. */
  readonly throttleCount: number
  /** Cumulative fail-closed admission stop count. */
  readonly budgetStopCount: number
  /** Cumulative cadence wait count. */
  readonly cadenceWaitCount: number
  /** Cumulative cadence delay in milliseconds. */
  readonly cadenceWaitMilliseconds: number
  /** Maximum cumulative charged in-flight episode count. */
  readonly maximumInFlight: 0 | 1
}

/** Private causal state consumed with the exact measured result. */
type AuthenticatedRootMeasurementState = {
  /** Detached secret-free claims exposed by the capability. */
  readonly claims: WorkspaceSearchMigrationRehearsalRootMeasurementClaims
  /** Exact object reference returned by the managed measurement. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Digest of every exact enumerable configuration field at completion. */
  readonly configurationResultDigest: string
}

/** Genuine completed measurements awaiting one exact-reference consumer. */
const authenticatedRootMeasurements = new WeakMap<
  object,
  AuthenticatedRootMeasurementState
>()

/** Strict guards replacing every malformed value with the stable root error. */
const rootMeasurementGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failRootMeasurement,
)

/**
 * Measures the exact initial configuration and binds its six rate attempts.
 *
 * The durable aggregate is sampled before and after the exact returned object.
 * Measurement is never invoked unless the initial attempt count is zero. The
 * after snapshot must add exactly six clean attempts under the same policy,
 * and the measured configuration must reproduce the reviewed digest.
 *
 * @param input - Narrow trusted port and reviewed configuration digest.
 * @returns Exact measured object plus a fresh one-shot causal capability.
 */
export async function measureWorkspaceSearchMigrationRehearsalRootConfiguration(
  input: unknown,
): Promise<WorkspaceSearchMigrationRehearsalRootMeasurement> {
  try {
    const snapshot = readRootMeasurementInput(input)
    const before = readRateEvidence(
      snapshot.readDescribeTableRateEvidence(),
    )
    requireCleanRootRateStart(before)

    const configuration = await snapshot.measureConfiguration()
    const after = readRateEvidence(
      snapshot.readDescribeTableRateEvidence(),
    )
    requireMeasuredConfiguration(configuration)
    requireExactRootRateDelta(before, after)
    const configurationBindingDigest =
      createWorkspaceSearchConfigurationHash(configuration)
    if (
      configurationBindingDigest !==
        snapshot.expectedConfigurationBindingDigest
    ) return failRootMeasurement()
    const configurationResultDigest = createMigrationDigest(configuration)
    if (
      createWorkspaceSearchConfigurationHash(configuration) !==
        configurationBindingDigest
    ) return failRootMeasurement()

    const claims = Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_MEASUREMENT_KIND,
      version:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_MEASUREMENT_VERSION,
      firstAttemptSequence: 1,
      lastAttemptSequence: rootMeasurementDescribeTableCallCount,
      configurationBindingDigest,
      policyVersion: before.policyVersion,
    }) satisfies WorkspaceSearchMigrationRehearsalRootMeasurementClaims
    const capability = Object.freeze({ ...claims })
    authenticatedRootMeasurements.set(capability, {
      claims,
      configuration,
      configurationResultDigest,
    })
    return Object.freeze({ configuration, capability })
  } catch {
    return failRootMeasurement()
  }
}

/**
 * Consumes one genuine root measurement with its exact result reference.
 *
 * @param value - Exact fresh capability returned with the measurement.
 * @param configuration - Exact configuration object returned by the port.
 * @returns Detached frozen attempt, configuration, and policy claims.
 */
export function consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
  value: unknown,
  configuration: unknown,
): WorkspaceSearchMigrationRehearsalRootMeasurementClaims {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      nodeUtilTypes.isProxy(value)
    ) return failRootMeasurement()
    const state = authenticatedRootMeasurements.get(value)
    if (state === undefined) return failRootMeasurement()
    authenticatedRootMeasurements.delete(value)
    if (configuration !== state.configuration) return failRootMeasurement()
    requireMeasuredConfiguration(state.configuration)
    if (
      createMigrationDigest(state.configuration) !==
        state.configurationResultDigest ||
      createWorkspaceSearchConfigurationHash(state.configuration) !==
        state.claims.configurationBindingDigest
    ) return failRootMeasurement()
    return Object.freeze({ ...state.claims })
  } catch {
    return failRootMeasurement()
  }
}

/** Captures the exact two-method input without invoking accessors. */
function readRootMeasurementInput(
  value: unknown,
): RootMeasurementInputSnapshot {
  const record = rootMeasurementGuards.requireRecord(value)
  rootMeasurementGuards.requireExactKeys(record, rootMeasurementInputKeys)
  const portRecord = rootMeasurementGuards.requireRecord(
    rootMeasurementGuards.readOwn(record, 'port'),
  )
  rootMeasurementGuards.requireExactKeys(portRecord, rootMeasurementPortKeys)
  const measureCandidate = rootMeasurementGuards.readOwn(
    portRecord,
    'measureConfiguration',
  )
  const readRateCandidate = rootMeasurementGuards.readOwn(
    portRecord,
    'readDescribeTableRateEvidence',
  )
  if (
    typeof measureCandidate !== 'function' ||
    nodeUtilTypes.isProxy(measureCandidate) ||
    typeof readRateCandidate !== 'function' ||
    nodeUtilTypes.isProxy(readRateCandidate)
  ) return failRootMeasurement()
  const expectedConfigurationBindingDigest =
    rootMeasurementGuards.readOwn(
      record,
      'expectedConfigurationBindingDigest',
    )
  if (!isHexDigest(expectedConfigurationBindingDigest)) {
    return failRootMeasurement()
  }
  return Object.freeze({
    measureConfiguration: async () => {
      const measured: unknown = await Reflect.apply(
        measureCandidate,
        portRecord,
        [],
      )
      return readMeasuredConfiguration(measured)
    },
    readDescribeTableRateEvidence: () => {
      const evidence: unknown = Reflect.apply(
        readRateCandidate,
        portRecord,
        [],
      )
      return readRateEvidence(evidence)
    },
    expectedConfigurationBindingDigest,
  })
}

/** Requires a configuration-shaped exact object without detaching its identity. */
function readMeasuredConfiguration(
  value: unknown,
): WorkspaceSearchMigrationConfiguration {
  const record = rootMeasurementGuards.requireRecord(value)
  rootMeasurementGuards.requireExactKeys(record, measuredConfigurationKeys)
  if (!isMeasuredConfigurationRecord(record)) return failRootMeasurement()
  return record
}

/** Performs the same exact-reference configuration check after measurement. */
function requireMeasuredConfiguration(
  value: WorkspaceSearchMigrationConfiguration,
): void {
  readMeasuredConfiguration(value)
}

/** Narrows the exact top-level measured configuration fields used by hashing. */
function isMeasuredConfigurationRecord(
  record: object,
): record is WorkspaceSearchMigrationConfiguration {
  return rootMeasurementGuards.readOwn(record, 'migrationId') ===
      WORKSPACE_SEARCH_MIGRATION_ID &&
    rootMeasurementGuards.readOwn(record, 'migrationVersion') ===
      WORKSPACE_SEARCH_MIGRATION_VERSION &&
    typeof rootMeasurementGuards.readOwn(record, 'account') === 'string' &&
    typeof rootMeasurementGuards.readOwn(record, 'region') === 'string' &&
    typeof rootMeasurementGuards.readOwn(record, 'profile') === 'string' &&
    typeof rootMeasurementGuards.readOwn(record, 'commit') === 'string' &&
    typeof rootMeasurementGuards.readOwn(record, 'callerArn') === 'string' &&
    typeof rootMeasurementGuards.readOwn(record, 'callerRoleId') ===
      'string' &&
    rootMeasurementGuards.isRecord(
      rootMeasurementGuards.readOwn(record, 'tables'),
    ) &&
    rootMeasurementGuards.isRecord(
      rootMeasurementGuards.readOwn(record, 'journal'),
    ) &&
    rootMeasurementGuards.readOwn(record, 'journalPrefix') ===
      'workspace-search/v1'
}

/** Parses and detaches one cumulative rate aggregate snapshot. */
function readRateEvidence(value: unknown): RootMeasurementRateSnapshot {
  const record = rootMeasurementGuards.requireRecord(value)
  rootMeasurementGuards.requireExactKeys(record, rateEvidenceKeys)
  const version = rootMeasurementGuards.readOwn(record, 'version')
  if (
    version !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
  ) return failRootMeasurement()
  const policyVersion = rootMeasurementGuards.readOwn(
    record,
    'policyVersion',
  )
  if (!isHexDigest(policyVersion)) return failRootMeasurement()
  const maximumInFlight = rootMeasurementGuards.readOwn(
    record,
    'maximumInFlight',
  )
  if (maximumInFlight !== 0 && maximumInFlight !== 1) {
    return failRootMeasurement()
  }
  return Object.freeze({
    version,
    policyVersion,
    attemptCount: readNonNegativeCount(record, 'attemptCount'),
    forfeitedAttemptCount: readNonNegativeCount(
      record,
      'forfeitedAttemptCount',
    ),
    throttleCount: readNonNegativeCount(record, 'throttleCount'),
    budgetStopCount: readNonNegativeCount(record, 'budgetStopCount'),
    cadenceWaitCount: readNonNegativeCount(record, 'cadenceWaitCount'),
    cadenceWaitMilliseconds: readNonNegativeCount(
      record,
      'cadenceWaitMilliseconds',
    ),
    maximumInFlight,
  })
}

/** Reads one exact non-negative cumulative rate counter. */
function readNonNegativeCount(record: object, key: string): number {
  const value = rootMeasurementGuards.readOwn(record, key)
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failRootMeasurement()
  return value
}

/** Requires a pristine durable ledger before the first root measurement. */
function requireCleanRootRateStart(
  before: RootMeasurementRateSnapshot,
): void {
  if (
    before.attemptCount !== 0 ||
    before.forfeitedAttemptCount !== 0 ||
    before.throttleCount !== 0 ||
    before.budgetStopCount !== 0 ||
    before.cadenceWaitCount !== 0 ||
    before.cadenceWaitMilliseconds !== 0 ||
    before.maximumInFlight !== 0
  ) return failRootMeasurement()
}

/** Requires exactly six clean first-operation attempts under one policy. */
function requireExactRootRateDelta(
  before: RootMeasurementRateSnapshot,
  after: RootMeasurementRateSnapshot,
): void {
  if (
    before.version !== after.version ||
    before.policyVersion !== after.policyVersion ||
    after.attemptCount !== rootMeasurementDescribeTableCallCount ||
    after.attemptCount !==
      before.attemptCount + rootMeasurementDescribeTableCallCount ||
    after.forfeitedAttemptCount !== before.forfeitedAttemptCount ||
    after.throttleCount !== before.throttleCount ||
    after.budgetStopCount !== before.budgetStopCount ||
    after.cadenceWaitCount < before.cadenceWaitCount ||
    after.cadenceWaitMilliseconds < before.cadenceWaitMilliseconds ||
    after.maximumInFlight !== 1
  ) return failRootMeasurement()
}

/** Throws the stable raw-value-free root measurement error. */
function failRootMeasurement(): never {
  throw new WorkspaceSearchMigrationRehearsalRootMeasurementError()
}
