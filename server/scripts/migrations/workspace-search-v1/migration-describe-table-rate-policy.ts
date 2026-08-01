import { createHash } from 'node:crypto'
import {
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  type WorkspaceSearchMigrationDescribeTableRatePolicy,
} from './migration-describe-table-rate-budget'

/** Maximum canonical UTF-8 bytes accepted for one reviewed rate policy. */
export const WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES =
  4 * 1_024

/** Exact version-one reviewed rate-policy document before digest binding. */
export type WorkspaceSearchMigrationDescribeTableRatePolicyDocument = {
  /** Policy document schema version. */
  readonly schemaVersion: 1
  /** Maximum started attempts retained in one rolling window. */
  readonly maximumAttemptsPerWindow: number
  /** Maximum physical attempts consumed by this lifecycle ledger. */
  readonly maximumAttemptsPerLifecycle: number
  /** Fixed capacity reserved before each checkpoint page callback. */
  readonly checkpointPageAttemptCapacity: number
  /** Rolling-window duration in milliseconds. */
  readonly windowMilliseconds: number
  /** Minimum spacing between physical attempt starts. */
  readonly minimumAttemptIntervalMilliseconds: number
  /** Minimum spacing between checkpoint-page starts. */
  readonly minimumPageIntervalMilliseconds: number
  /** Maximum total wait before admission must stop. */
  readonly maximumAdmissionWaitMilliseconds: number
  /** Initial throttle cooldown before jitter. */
  readonly throttleBackoffInitialMilliseconds: number
  /** Maximum throttle cooldown before jitter. */
  readonly throttleBackoffMaximumMilliseconds: number
}

/** Stable raw-value-free failure for an invalid reviewed policy document. */
export class WorkspaceSearchMigrationDescribeTableRatePolicyError
  extends Error {
  /** Stable code safe for a CLI JSONL boundary. */
  readonly code = 'INVALID_DESCRIBE_TABLE_RATE_POLICY'

  /** Creates one fixed-message policy failure. */
  constructor() {
    super('INVALID_DESCRIBE_TABLE_RATE_POLICY')
    this.name = 'WorkspaceSearchMigrationDescribeTableRatePolicyError'
  }
}

/**
 * Parses an exact canonical policy document and binds its byte digest.
 *
 * The policy version is the SHA-256 digest of the exact reviewed canonical
 * document, so an operator cannot provide a digest that describes different
 * limits. Unknown fields, duplicate keys, alternate JSON formatting, and
 * insufficient page or cleanup capacity fail closed.
 *
 * @param bytes - Exact untrusted policy file bytes.
 * @returns Detached validated rate policy with a computed policy version.
 */
export function parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
  bytes: Uint8Array,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_POLICY_MAX_BYTES
    ) {
      return failPolicy()
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return failPolicy()
    }
    const document = readPolicyDocument(value)
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(document),
    )
    if (!bytesEqual(bytes, canonicalBytes)) return failPolicy()

    return Object.freeze({
      policyVersion: createHash('sha256').update(bytes).digest('hex'),
      maximumAttemptsPerWindow: document.maximumAttemptsPerWindow,
      maximumAttemptsPerLifecycle: document.maximumAttemptsPerLifecycle,
      checkpointPageAttemptCapacity:
        document.checkpointPageAttemptCapacity,
      windowMilliseconds: document.windowMilliseconds,
      minimumAttemptIntervalMilliseconds:
        document.minimumAttemptIntervalMilliseconds,
      minimumPageIntervalMilliseconds:
        document.minimumPageIntervalMilliseconds,
      maximumAdmissionWaitMilliseconds:
        document.maximumAdmissionWaitMilliseconds,
      throttleBackoffInitialMilliseconds:
        document.throttleBackoffInitialMilliseconds,
      throttleBackoffMaximumMilliseconds:
        document.throttleBackoffMaximumMilliseconds,
    })
  } catch {
    return failPolicy()
  }
}

/**
 * Reads one exact-shape policy document from untrusted JSON.
 *
 * @param value - Parsed untrusted JSON value.
 * @returns Detached validated version-one document.
 */
function readPolicyDocument(
  value: unknown,
): WorkspaceSearchMigrationDescribeTableRatePolicyDocument {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return failPolicy()
  }
  const expectedKeys = [
    'checkpointPageAttemptCapacity',
    'maximumAdmissionWaitMilliseconds',
    'maximumAttemptsPerLifecycle',
    'maximumAttemptsPerWindow',
    'minimumAttemptIntervalMilliseconds',
    'minimumPageIntervalMilliseconds',
    'schemaVersion',
    'throttleBackoffInitialMilliseconds',
    'throttleBackoffMaximumMilliseconds',
    'windowMilliseconds',
  ]
  const actualKeys = Object.keys(value).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return failPolicy()
  }
  if (readOwnDataProperty(value, 'schemaVersion') !== 1) {
    return failPolicy()
  }
  const document: WorkspaceSearchMigrationDescribeTableRatePolicyDocument = {
    schemaVersion: 1,
    maximumAttemptsPerWindow: readPositiveSafeInteger(
      readOwnDataProperty(value, 'maximumAttemptsPerWindow'),
    ),
    maximumAttemptsPerLifecycle: readPositiveSafeInteger(
      readOwnDataProperty(value, 'maximumAttemptsPerLifecycle'),
    ),
    checkpointPageAttemptCapacity: readPositiveSafeInteger(
      readOwnDataProperty(value, 'checkpointPageAttemptCapacity'),
    ),
    windowMilliseconds: readPositiveSafeInteger(
      readOwnDataProperty(value, 'windowMilliseconds'),
    ),
    minimumAttemptIntervalMilliseconds: readPositiveSafeInteger(
      readOwnDataProperty(value, 'minimumAttemptIntervalMilliseconds'),
    ),
    minimumPageIntervalMilliseconds: readPositiveSafeInteger(
      readOwnDataProperty(value, 'minimumPageIntervalMilliseconds'),
    ),
    maximumAdmissionWaitMilliseconds: readPositiveSafeInteger(
      readOwnDataProperty(value, 'maximumAdmissionWaitMilliseconds'),
    ),
    throttleBackoffInitialMilliseconds: readPositiveSafeInteger(
      readOwnDataProperty(value, 'throttleBackoffInitialMilliseconds'),
    ),
    throttleBackoffMaximumMilliseconds: readPositiveSafeInteger(
      readOwnDataProperty(value, 'throttleBackoffMaximumMilliseconds'),
    ),
  }
  if (
    document.maximumAttemptsPerLifecycle <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    document.checkpointPageAttemptCapacity !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    document.checkpointPageAttemptCapacity >
      document.maximumAttemptsPerLifecycle ||
    document.maximumAttemptsPerLifecycle -
        document.checkpointPageAttemptCapacity <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS ||
    document.checkpointPageAttemptCapacity >
      document.maximumAttemptsPerWindow ||
    document.throttleBackoffInitialMilliseconds >
      document.throttleBackoffMaximumMilliseconds
  ) {
    return failPolicy()
  }
  return document
}

/**
 * Reads one own enumerable data property without invoking an accessor.
 *
 * @param object - Exact-shape parsed object.
 * @param key - Expected property name.
 * @returns Untrusted own data value.
 */
function readOwnDataProperty(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !('value' in descriptor)
  ) {
    return failPolicy()
  }
  return descriptor.value
}

/**
 * Requires one positive safe integer.
 *
 * @param value - Untrusted JSON scalar.
 * @returns Positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failPolicy()
  }
  return value
}

/**
 * Compares exact byte sequences without decoding them again.
 *
 * @param left - Reviewed source bytes.
 * @param right - Canonical reserialization.
 * @returns Whether both byte sequences are identical.
 */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Raises one stable policy failure without retaining input bytes.
 *
 * @returns Never returns.
 */
function failPolicy(): never {
  throw new WorkspaceSearchMigrationDescribeTableRatePolicyError()
}
