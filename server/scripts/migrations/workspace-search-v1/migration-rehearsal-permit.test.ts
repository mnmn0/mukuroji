import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import { createMigrationDigest } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalPermit,
  verifyWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationRehearsalPermitClaims,
} from './migration-rehearsal-permit'

const account = '123456789012'
const productionAccount = '210987654321'
const region = 'ap-northeast-1'
const commit = 'a'.repeat(40)
const deploymentTrustRootDigest = 'd'.repeat(64)
const deploymentTargetId = 'test-rehearsal'
const requestedResourcesBinding = 'b'.repeat(64)
const configurationBindingDigest = createMigrationDigest('configuration')
const policyVersion = createMigrationDigest('policy')
const integrityResourceIdentityDigest = 'c'.repeat(64)
const integrityResourceIdentities = Object.freeze(
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: (index + 1).toString(16).padStart(64, '0'),
    })
  ),
)
const signingKey = new Uint8Array(32).fill(7)
const evidenceKeyDigest = createHash('sha256')
  .update(signingKey)
  .digest('hex')
const publicationKeyDigest = createHash('sha256')
  .update('publication-key', 'utf8')
  .digest('hex')

/** Creates one structurally valid signed minimal ordinal-zero root projection. */
function createIntegrityAttestationRootProjection():
  WorkspaceSearchMigrationRehearsalPermitClaims[
    'integrityAttestationRoot'
  ] {
  const aggregate: WorkspaceSearchMigrationRehearsalPermitClaims[
    'integrityAttestationRoot'
  ][
    'aggregate'
  ] = {
    version: 1,
    policyVersion,
    attemptCount: 12,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  }
  return {
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId,
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    configurationBindingDigest,
    policyVersion,
    attestation: {
      contentMac: createMigrationDigest('attestation-content'),
      byteLength: 1_024,
    },
    segment: {
      authenticationKeyFingerprint: createMigrationDigest('key-fingerprint'),
      segmentLocatorDigest: createMigrationDigest('segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: createMigrationDigest('terminal-record'),
      segmentDigest: createMigrationDigest('segment'),
    },
    interval: {
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      attemptSequences: [7, 8, 9, 10, 11, 12],
      firstEventSequence: 13,
      lastEventSequence: 24,
      eventSequences: Array.from({ length: 12 }, (_value, index) => index + 13),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: '2026-07-31T23:59:59.700Z',
      completedAt: '2026-07-31T23:59:59.900Z',
    },
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: createMigrationDigest('table-order'),
    rootMac: createMigrationDigest('root'),
    startedAt: '2026-07-31T23:59:59.000Z',
    completedAt: '2026-07-31T23:59:59.999Z',
  }
}

/** Creates one valid restricted rehearsal permit claim set. */
function createClaims(): WorkspaceSearchMigrationRehearsalPermitClaims {
  return {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
    permitVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    account,
    productionAccount,
    region,
    callerArn:
      `arn:aws:sts::${account}:assumed-role/MigrationRehearsal/` +
      'reviewed-session',
    commit,
    deploymentTargetId,
    deploymentTrustRootDigest,
    requestedResourcesBinding,
    configurationBindingDigest,
    policyVersion,
    integrityResourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    integrityResourceIdentities,
    integrityResourceIdentityDigest,
    evidenceKeyDigest,
    publicationKeyDigest,
    integrityAttestationRoot:
      createIntegrityAttestationRootProjection(),
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-04T00:00:00.000Z',
  }
}

/** Verifies one candidate through the standard expected request bindings. */
function verify(permit: unknown, key: Uint8Array = signingKey): unknown {
  return verifyWorkspaceSearchMigrationRehearsalPermit({
    permit,
    verificationKey: key,
    account,
    region,
    commit,
    requestedResourcesBinding,
    currentTime: new Date('2026-08-01T03:00:00.000Z'),
  })
}

describe('Workspace Search migration rehearsal permit', () => {
  test('derives the production-account digest with the CDK trust-root domain', () => {
    expect(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
    ).toBe(
      'mukuroji-workspace-search-migration-production-account/v1\0',
    )
    expect(
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    ).toBe(
      createHash('sha256')
        .update(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PRODUCTION_ACCOUNT_DIGEST_DOMAIN,
          'utf8',
        )
        .update(productionAccount, 'utf8')
        .digest('hex'),
    )
    expect(
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    ).not.toBe(
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(account),
    )
  })

  test('authenticates exact bounded non-production request bindings', () => {
    const permit = createWorkspaceSearchMigrationRehearsalPermit({
      claims: createClaims(),
      signingKey,
    })

    expect(verify(permit)).toEqual(createClaims())
    expect(permit.permitMac).toMatch(/^[0-9a-f]{64}$/u)
    expect(Object.isFrozen(permit)).toBe(true)
  })

  test('rejects tampering, a foreign key, and request-binding drift', () => {
    const permit = createWorkspaceSearchMigrationRehearsalPermit({
      claims: createClaims(),
      signingKey,
    })
    const candidates: readonly (() => unknown)[] = [
      () => verify({ ...permit, region: 'us-east-1' }),
      () => verify({
        ...permit,
        deploymentTrustRootDigest: 'e'.repeat(64),
      }),
      () => verify({
        ...permit,
        integrityResourceIdentities:
          permit.integrityResourceIdentities.map((identity, index) =>
            index === 0
              ? { ...identity, identityDigest: 'f'.repeat(64) }
              : identity
          ),
      }),
      () => verify({
        ...permit,
        integrityAttestationRoot: {
          ...permit.integrityAttestationRoot,
          rootMac: 'f'.repeat(64),
        },
      }),
      () => verify(permit, new Uint8Array(32).fill(8)),
      () => verifyWorkspaceSearchMigrationRehearsalPermit({
        permit,
        verificationKey: signingKey,
        account,
        region,
        commit,
        requestedResourcesBinding: 'c'.repeat(64),
        currentTime: new Date('2026-08-01T03:00:00.000Z'),
      }),
    ]

    for (const candidate of candidates) {
      expect(candidate).toThrow('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
    }
  })

  test('rejects production reuse, invalid validity, and an unassumed caller', () => {
    const candidates: readonly WorkspaceSearchMigrationRehearsalPermitClaims[] = [
      { ...createClaims(), productionAccount: account },
      {
        ...createClaims(),
        expiresAt: '2026-08-04T00:00:00.001Z',
      },
      {
        ...createClaims(),
        callerArn: `arn:aws:iam::${account}:role/MigrationRehearsal`,
      },
      {
        ...createClaims(),
        deploymentTargetId: 'other-rehearsal',
      },
    ]

    for (const claims of candidates) {
      expect(() => createWorkspaceSearchMigrationRehearsalPermit({
        claims,
        signingKey,
      })).toThrow('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
    }
  })

  test('rejects not-yet-valid and expired permits', () => {
    const permit = createWorkspaceSearchMigrationRehearsalPermit({
      claims: createClaims(),
      signingKey,
    })
    for (const currentTime of [
      new Date('2026-07-31T23:59:59.999Z'),
      new Date('2026-08-04T00:00:00.000Z'),
    ]) {
      expect(() => verifyWorkspaceSearchMigrationRehearsalPermit({
        permit,
        verificationKey: signingKey,
        account,
        region,
        commit,
        requestedResourcesBinding,
        currentTime,
      })).toThrow('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
    }
  })

  test('rejects accessors, proxies, extra keys, and malformed key material', () => {
    const permit = createWorkspaceSearchMigrationRehearsalPermit({
      claims: createClaims(),
      signingKey,
    })
    const accessor = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
    })
    const candidates: readonly (() => unknown)[] = [
      () => verify(new Proxy(permit, {})),
      () => verify({ ...permit, extra: 'forbidden' }),
      () => verify(accessor),
      () => verify(permit, new Uint8Array(31)),
      () => createWorkspaceSearchMigrationRehearsalPermit({
        claims: {
          ...createClaims(),
          integrityResourceIdentities:
            [...createClaims().integrityResourceIdentities].reverse(),
        },
        signingKey,
      }),
    ]

    for (const candidate of candidates) {
      expect(candidate).toThrow('NON_PRODUCTION_REHEARSAL_GUARD_FAILED')
    }
  })
})
