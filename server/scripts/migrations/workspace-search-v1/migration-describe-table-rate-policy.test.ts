import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
} from './migration-describe-table-rate-budget'
import {
  parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument,
  WorkspaceSearchMigrationDescribeTableRatePolicyError,
  type WorkspaceSearchMigrationDescribeTableRatePolicyDocument,
} from './migration-describe-table-rate-policy'

describe('Workspace Search migration DescribeTable rate policy', () => {
  test('parses exact canonical reviewed bytes and computes their digest', () => {
    const document = createPolicyDocument()
    const bytes = encodePolicy(document)

    const policy =
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(bytes)

    expect(policy).toEqual({
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
    expect(Object.isFrozen(policy)).toBe(true)
  })

  test('rejects alternate formatting, duplicate keys, and unknown fields', () => {
    const document = createPolicyDocument()
    const pretty = new TextEncoder().encode(JSON.stringify(document, null, 2))
    const duplicate = new TextEncoder().encode(
      serializeCanonicalJson(document).replace(
        '{',
        '{"schemaVersion":1,',
      ),
    )
    const unknown = encodePolicy({ ...document, rawTenantCanary: 'secret' })

    for (const bytes of [pretty, duplicate, unknown]) {
      expect(() =>
        parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(bytes),
      ).toThrow(WorkspaceSearchMigrationDescribeTableRatePolicyError)
    }
  })

  test('requires the exact page baseline and protected cleanup headroom', () => {
    const baseline = WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS
    const insufficientPage = encodePolicy({
      ...createPolicyDocument(),
      checkpointPageAttemptCapacity: baseline - 1,
    })
    const excessivePage = encodePolicy({
      ...createPolicyDocument(),
      checkpointPageAttemptCapacity: baseline + 1,
    })
    const insufficientCleanup = encodePolicy({
      ...createPolicyDocument(),
      maximumAttemptsPerLifecycle: baseline + 5,
    })

    expect(() =>
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
        insufficientPage,
      ),
    ).toThrow(WorkspaceSearchMigrationDescribeTableRatePolicyError)
    expect(() =>
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
        excessivePage,
      ),
    ).toThrow(WorkspaceSearchMigrationDescribeTableRatePolicyError)
    expect(() =>
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
        insufficientCleanup,
      ),
    ).toThrow(WorkspaceSearchMigrationDescribeTableRatePolicyError)
  })

  test('binds any reviewed scalar change to a different policy version', () => {
    const first = parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
      encodePolicy(createPolicyDocument()),
    )
    const second = parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(
      encodePolicy({
        ...createPolicyDocument(),
        minimumAttemptIntervalMilliseconds: 21,
      }),
    )

    expect(first.policyVersion).not.toBe(second.policyVersion)
  })

  test('never retains malformed raw values in its stable failure', () => {
    const bytes = new TextEncoder().encode(
      '{"profile":"raw-profile-canary","tenant":"raw-tenant-canary"}',
    )
    let failure: unknown
    try {
      parseWorkspaceSearchMigrationDescribeTableRatePolicyDocument(bytes)
    } catch (error: unknown) {
      failure = error
    }

    expect(String(failure)).toBe(
      'WorkspaceSearchMigrationDescribeTableRatePolicyError: INVALID_DESCRIBE_TABLE_RATE_POLICY',
    )
    expect(String(failure)).not.toContain('raw-profile-canary')
    expect(String(failure)).not.toContain('raw-tenant-canary')
  })
})

/**
 * Creates the valid reviewed policy fixture.
 *
 * @returns Complete version-one policy document.
 */
function createPolicyDocument():
  WorkspaceSearchMigrationDescribeTableRatePolicyDocument {
  return {
    schemaVersion: 1,
    maximumAttemptsPerWindow: 400,
    maximumAttemptsPerLifecycle: 400,
    checkpointPageAttemptCapacity:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
    windowMilliseconds: 1_000,
    minimumAttemptIntervalMilliseconds: 20,
    minimumPageIntervalMilliseconds: 1_000,
    maximumAdmissionWaitMilliseconds: 30_000,
    throttleBackoffInitialMilliseconds: 100,
    throttleBackoffMaximumMilliseconds: 2_000,
  }
}

/**
 * Encodes an object as canonical policy bytes.
 *
 * @param value - Candidate canonical JSON object.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodePolicy(value: object): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}
