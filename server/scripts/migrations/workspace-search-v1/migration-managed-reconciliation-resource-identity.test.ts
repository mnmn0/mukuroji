import { describe, expect, test } from 'bun:test'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  parseCrossDomainIntegrityResourceIdentities,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationTableRole,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationManagedReconciliationResourceIdentities,
  validateWorkspaceSearchMigrationManagedReconciliationResourceIdentities,
  type WorkspaceSearchMigrationManagedReconciliationResourceIdentities,
} from './migration-identity-aws'

/** Creates one complete table identity with a selectable immutable incarnation. */
function createMeasuredTable(
  role: WorkspaceSearchMigrationTableRole,
  tableName: string,
  incarnation: 'current' | 'replacement' | 'stable',
): MigrationTableIdentity {
  return {
    role,
    tableName,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${tableName}`,
    tableId: `${role}-table-id-${incarnation}`,
    creationTime: incarnation === 'replacement'
      ? '2026-07-02T00:00:00.000Z'
      : '2026-07-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key: [],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'AWS_OWNED',
    kmsKeyDigest: null,
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-08-01T00:00:00.000Z',
    },
  }
}

/** Creates one measured configuration with unchanged names and ARNs. */
function createMeasuredConfiguration(
  incarnation: 'current' | 'replacement',
): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'migration-rehearsal-test',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/MigrationRehearsal/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createMeasuredTable(
        'project-directory',
        'rehearsal-project-directory',
        incarnation,
      ),
      'work-items': createMeasuredTable(
        'work-items',
        'rehearsal-work-items',
        incarnation,
      ),
      collaboration: createMeasuredTable(
        'collaboration',
        'rehearsal-collaboration',
        'stable',
      ),
      documents: createMeasuredTable(
        'documents',
        'rehearsal-documents',
        'stable',
      ),
      'workspace-search': createMeasuredTable(
        'workspace-search',
        'rehearsal-workspace-search',
        'stable',
      ),
      'migration-state': createMeasuredTable(
        'migration-state',
        'rehearsal-migration-state',
        'stable',
      ),
    },
    journal: {
      bucketName: 'rehearsal-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/' +
        '11111111-2222-4333-8444-555555555555',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'rehearsal-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/** Creates one strict canonical vector around the two managed identities. */
function createResourceIdentityVector(
  managed:
    WorkspaceSearchMigrationManagedReconciliationResourceIdentities,
): readonly CrossDomainIntegrityResourceIdentity[] {
  return parseCrossDomainIntegrityResourceIdentities(
    CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target) => {
      if (target === 'table:project-directory') {
        return managed.projectDirectory
      }
      if (target === 'table:work-items') return managed.workItems
      return Object.freeze({
        target,
        identityDigest: createMigrationDigest({
          label: `unchanged-integrity-resource:${target}`,
        }),
      })
    }),
  )
}

describe('managed reconciliation immutable resource identities', () => {
  test('retains precomputed identities after key consumption and rejects a coherent replacement incarnation', () => {
    const integrityKey = new Uint8Array(32).fill(0x63)
    const currentConfiguration = createMeasuredConfiguration('current')
    const replacementConfiguration =
      createMeasuredConfiguration('replacement')
    expect(
      currentConfiguration.tables['project-directory'].tableName,
    ).toBe(replacementConfiguration.tables['project-directory'].tableName)
    expect(
      currentConfiguration.tables['project-directory'].tableId,
    ).not.toBe(replacementConfiguration.tables['project-directory'].tableId)

    const current =
      createWorkspaceSearchMigrationManagedReconciliationResourceIdentities(
        currentConfiguration,
        integrityKey,
      )
    const replacement =
      createWorkspaceSearchMigrationManagedReconciliationResourceIdentities(
        replacementConfiguration,
        integrityKey,
      )
    const currentVector = createResourceIdentityVector(current)
    const replacementVector = createResourceIdentityVector(replacement)
    const currentDigest = calculateCrossDomainIntegrityResourceIdentityDigest(
      currentVector,
      integrityKey,
    )
    const replacementDigest =
      calculateCrossDomainIntegrityResourceIdentityDigest(
        replacementVector,
        integrityKey,
      )

    expect(() =>
      validateWorkspaceSearchMigrationManagedReconciliationResourceIdentities({
        expected: replacement,
        resourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        resourceIdentities: replacementVector,
      })
    ).not.toThrow()
    expect(replacementDigest).not.toBe(currentDigest)

    integrityKey.fill(0)
    expect(Array.from(integrityKey).every((byte) => byte === 0)).toBe(true)
    for (const resourceIdentities of [currentVector, currentVector]) {
      expect(() =>
        validateWorkspaceSearchMigrationManagedReconciliationResourceIdentities({
          expected: current,
          resourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
          resourceIdentities,
        })
      ).not.toThrow()
    }
    for (const resourceIdentities of [replacementVector, replacementVector]) {
      expect(() =>
        validateWorkspaceSearchMigrationManagedReconciliationResourceIdentities({
          expected: current,
          resourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
          resourceIdentities,
        })
      ).toThrow('Workspace Search migration rehearsal reconciliation failed.')
    }
  })
})
