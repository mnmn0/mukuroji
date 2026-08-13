import { describe, expect, test } from 'bun:test'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  COLLABORATION_CONTEXT_SCHEMA_VERSION,
  type CuratedContextItem,
} from '@mukuroji/contracts'
import {
  createCuratedContextItemWorkspaceSearchDocument,
  createTeamWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
} from './dynamodb-attribute-codec'
import {
  createAbsentMigrationItemDigest,
} from './migration-journal'
import {
  createMigrationDigest,
  createWorkspaceSearchMigrationScanSnapshotDigest,
  createWorkspaceSearchOperationId,
  serializeCanonicalJson,
  type MigrationScanAggregate,
  type WorkspaceSearchDryRunEvidence,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchPlanSeal,
} from './migration-contract'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'
import {
  parseWorkspaceSearchDryRunEvidence,
  parseWorkspaceSearchPlannedOperation,
  parseWorkspaceSearchPlanSeal,
  serializeWorkspaceSearchDryRunEvidence,
  serializeWorkspaceSearchPlannedOperation,
  serializeWorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
  WorkspaceSearchMigrationArtifactError,
} from './migration-artifacts'

/**
 * Creates one internally consistent complete scan aggregate.
 *
 * @param label - Stable fixture label used to create distinct digests.
 * @param scanned - Number of mapped put rows represented by the aggregate.
 * @returns Complete clean aggregate.
 */
function createAggregate(label: string, scanned = 1): MigrationScanAggregate {
  return {
    scanned,
    mapped: scanned,
    ignored: 0,
    invalid: 0,
    projected: scanned,
    deleted: 0,
    keyDigest: createMigrationDigest(`${label}:keys`),
    contentDigest: createMigrationDigest(`${label}:content`),
    pageCount: 1,
  }
}

/**
 * Creates complete canonical dry-run evidence.
 *
 * @returns Reviewed dry-run evidence fixture.
 */
function createDryRunEvidence(): WorkspaceSearchDryRunEvidence {
  return {
    kind: 'workspace-search-migration-dry-run',
    evidenceVersion: 1,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    configurationHash: 'a'.repeat(64),
    startedAt: '2026-07-26T01:00:00.000Z',
    completedAt: '2026-07-26T01:01:00.000Z',
    sources: {
      'project-directory': createAggregate('project-directory'),
      'work-items': createAggregate('work-items'),
      collaboration: createAggregate('collaboration'),
      documents: createAggregate('documents'),
    },
    target: createAggregate('target', 4),
    status: 'pass',
  }
}

/**
 * Creates a plan seal bound to the dry-run aggregate snapshot.
 *
 * @param evidence - Reviewed dry-run evidence.
 * @param planDigest - Exact operation-plan root.
 * @returns Canonical plan seal.
 */
function createPlanSeal(
  evidence: WorkspaceSearchDryRunEvidence,
  planDigest: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId: 'run-20260726',
    configurationHash: evidence.configurationHash,
    dryRunEvidenceDigest: createMigrationDigest(evidence),
    planningSnapshotDigest:
      createWorkspaceSearchMigrationScanSnapshotDigest({
        configurationHash: evidence.configurationHash,
        sources: evidence.sources,
        target: evidence.target,
      }),
    planDigest,
    planOperationCount: 1,
    sourceOperationCount: 1,
    orphanOperationCount: 0,
    createdAt: '2026-07-26T01:02:00.000Z',
  }
}

/**
 * Creates one valid planned Team projection containing lossless source extras.
 *
 * @returns Planned operation whose only Merkle leaf is the plan root.
 */
function createPlannedOperation(): WorkspaceSearchPlannedOperation {
  const configurationHash = 'a'.repeat(64)
  const sourceKey = {
    directoryId: { S: 'workspace-1' },
    entryKey: { S: '000001#000000#TEAM#team-1' },
  }
  const sourceItem: Record<string, AttributeValue> = {
    ...sourceKey,
    entryType: { S: 'team' },
    teamId: { S: 'team-1' },
    teamSortOrder: { N: '1' },
    nameJa: { S: 'チーム' },
    nameEn: { S: 'Team' },
    expanded: { BOOL: true },
    preciseNumber: { N: '1.2300' },
    opaqueBytes: { B: new Uint8Array([0, 127, 255]) },
  }
  const document = createTeamWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    title: 'チーム',
    subtitle: 'Team',
  })
  const targetItem = encodeWorkspaceSearchMigrationDocument(document)
  const targetKey = {
    workspaceId: targetItem.workspaceId,
    recordKey: targetItem.recordKey,
  }
  if (!targetKey.workspaceId || !targetKey.recordKey) {
    throw new Error('Fixture target key is incomplete.')
  }
  const sourceKeyDigest = createAttributeMapDigest(sourceKey)
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const operation: WorkspaceSearchMigrationOperation = {
    operationId: createWorkspaceSearchOperationId({
      configurationHash,
      sourceTableId: '00000000-0000-0000-0000-000000000001',
      sourceKeyDigest,
      targetKeyDigest,
    }),
    sourceCondition: {
      exists: true,
      source: 'project-directory',
      tableId: '00000000-0000-0000-0000-000000000001',
      tableName: 'project-directory-production',
      key: sourceKey,
      keyDigest: sourceKeyDigest,
      item: sourceItem,
      itemDigest: createAttributeMapDigest(sourceItem),
    },
    targetKey,
    targetKeyDigest,
    before: {
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    },
    after: {
      exists: true,
      item: targetItem,
      digest: createAttributeMapDigest(targetItem),
    },
    entityType: 'team',
  }
  const operationDigest =
    createWorkspaceSearchMigrationOperationDigest(operation)
  const planSequence = 1
  const planDigest = createWorkspaceSearchPlanLeafDigest({
    planSequence,
    operationDigest,
  })
  return {
    runId: 'run-20260726',
    configurationHash,
    planDigest,
    planSequence,
    operationDigest,
    membershipProof: [],
    operation,
  }
}

/**
 * Creates one valid planned curated-context projection.
 *
 * @returns Planned operation whose source and target are both collaboration-owned.
 */
function createPlannedContextOperation(): WorkspaceSearchPlannedOperation {
  const configurationHash = 'a'.repeat(64)
  const sourceKey = {
    entityKey: {
      S: 'workspace-1#work-item#team/team-1/issue/issue-1',
    },
    recordKey: { S: 'CONTEXT#context-1' },
  }
  const sourceItem: Record<string, AttributeValue> = {
    ...sourceKey,
    entryType: { S: 'context' },
    schemaVersion: { N: String(COLLABORATION_CONTEXT_SCHEMA_VERSION) },
    id: { S: 'context-1' },
    teamId: { S: 'team-1' },
    workItemId: { S: 'issue-1' },
    kind: { S: 'context' },
    state: { S: 'active' },
    title: { S: 'Release context' },
    body: { S: 'The release is ready after verification.' },
    mentionMemberKeys: { L: [] },
    createdBy: {
      M: {
        id: { S: 'creator@example.com' },
        displayName: { S: 'Creator' },
      },
    },
    createdAt: { S: '2026-07-24T01:00:00.000Z' },
    updatedBy: {
      M: {
        id: { S: 'editor@example.com' },
        displayName: { S: 'Editor' },
      },
    },
    updatedAt: { S: '2026-07-24T02:00:00.000Z' },
    revision: { N: '2' },
  }
  const item: CuratedContextItem = {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: 'context-1',
    teamId: 'team-1',
    workItemId: 'issue-1',
    kind: 'context',
    state: 'active',
    title: 'Release context',
    body: 'The release is ready after verification.',
    mentionMemberKeys: [],
    createdBy: { id: 'creator@example.com', displayName: 'Creator' },
    createdAt: '2026-07-24T01:00:00.000Z',
    updatedBy: { id: 'editor@example.com', displayName: 'Editor' },
    updatedAt: '2026-07-24T02:00:00.000Z',
    revision: 2,
  }
  const document = createCuratedContextItemWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    item,
  })
  const targetItem = encodeWorkspaceSearchMigrationDocument(document)
  const targetKey = {
    workspaceId: targetItem.workspaceId,
    recordKey: targetItem.recordKey,
  }
  if (!targetKey.workspaceId || !targetKey.recordKey) {
    throw new Error('Fixture target key is incomplete.')
  }
  const sourceKeyDigest = createAttributeMapDigest(sourceKey)
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const operation: WorkspaceSearchMigrationOperation = {
    operationId: createWorkspaceSearchOperationId({
      configurationHash,
      sourceTableId: '00000000-0000-0000-0000-000000000002',
      sourceKeyDigest,
      targetKeyDigest,
    }),
    sourceCondition: {
      exists: true,
      source: 'collaboration',
      tableId: '00000000-0000-0000-0000-000000000002',
      tableName: 'collaboration-production',
      key: sourceKey,
      keyDigest: sourceKeyDigest,
      item: sourceItem,
      itemDigest: createAttributeMapDigest(sourceItem),
    },
    targetKey,
    targetKeyDigest,
    before: {
      exists: false,
      digest: createAbsentMigrationItemDigest(),
    },
    after: {
      exists: true,
      item: targetItem,
      digest: createAttributeMapDigest(targetItem),
    },
    entityType: 'context-item',
  }
  const operationDigest = createWorkspaceSearchMigrationOperationDigest(operation)
  const planSequence = 1
  const planDigest = createWorkspaceSearchPlanLeafDigest({
    planSequence,
    operationDigest,
  })
  return {
    runId: 'run-20260726',
    configurationHash,
    planDigest,
    planSequence,
    operationDigest,
    membershipProof: [],
    operation,
  }
}

/**
 * Rebuilds the one-leaf fixture with one exact extra source attribute.
 *
 * @param extra - Additional low-level source attribute.
 * @returns Planned operation whose digests include the extra source content.
 */
function createPlannedOperationWithSourceExtra(
  extra: AttributeValue,
): WorkspaceSearchPlannedOperation {
  const planned = createPlannedOperation()
  const source = planned.operation.sourceCondition
  if (!source.exists) {
    throw new Error('Expected a present source fixture.')
  }
  const item = {
    ...source.item,
    artifactBoundaryExtra: extra,
  }
  const operation: WorkspaceSearchMigrationOperation = {
    ...planned.operation,
    sourceCondition: {
      ...source,
      item,
      itemDigest: createAttributeMapDigest(item),
    },
  }
  const operationDigest =
    createWorkspaceSearchMigrationOperationDigest(operation)
  return {
    ...planned,
    operation,
    operationDigest,
    planDigest: createWorkspaceSearchPlanLeafDigest({
      planSequence: planned.planSequence,
      operationDigest,
    }),
  }
}

/**
 * Parses canonical artifact bytes into a mutable plain record for tampering.
 *
 * @param bytes - Canonical artifact bytes.
 * @returns Mutable parsed record.
 */
function parseFixtureRecord(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isRecord(parsed)) {
    throw new Error('Expected a fixture record.')
  }
  return parsed
}

/**
 * Encodes one deliberately modified JSON fixture canonically.
 *
 * @param value - Modified JSON-compatible fixture.
 * @returns Canonical bytes.
 */
function encodeFixture(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Requires one nested test fixture value to be a record.
 *
 * @param value - Candidate nested fixture.
 * @returns Mutable nested record.
 */
function requireFixtureRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected a nested fixture record.')
  }
  return value
}

/**
 * Checks whether a value is a plain record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Expects a synchronous artifact operation to fail without exposing raw data.
 *
 * @param operation - Deferred artifact operation.
 */
function expectArtifactFailure(operation: () => unknown): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationArtifactError)
    if (!(error instanceof WorkspaceSearchMigrationArtifactError)) {
      throw error
    }
    expect(error.code).toBe('INVALID_MIGRATION_ARTIFACT')
    expect(error.message).toBe('INVALID_MIGRATION_ARTIFACT')
    return
  }
  throw new Error('Expected a migration artifact failure.')
}

describe('Workspace Search dry-run artifact codec', () => {
  test('round-trips complete canonical evidence and validates planning aggregates', () => {
    const evidence = createDryRunEvidence()
    const bytes = serializeWorkspaceSearchDryRunEvidence(evidence)
    const parsed = parseWorkspaceSearchDryRunEvidence(bytes)

    expect(parsed).toEqual(evidence)
    expect(serializeWorkspaceSearchDryRunEvidence(parsed)).toEqual(bytes)
    expect(
      createWorkspaceSearchMigrationScanSnapshotDigest({
        configurationHash: parsed.configurationHash,
        sources: parsed.sources,
        target: parsed.target,
      }),
    ).toBe(
      createWorkspaceSearchMigrationScanSnapshotDigest({
        configurationHash: evidence.configurationHash,
        sources: evidence.sources,
        target: evidence.target,
      }),
    )
  })

  test('rejects noncanonical bytes, unknown keys, invalid rows, and timestamps', () => {
    const bytes = serializeWorkspaceSearchDryRunEvidence(
      createDryRunEvidence(),
    )
    const noncanonical = new TextEncoder().encode(
      `${new TextDecoder().decode(bytes)}\n`,
    )
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(noncanonical),
    )

    const unknown = parseFixtureRecord(bytes)
    unknown.unexpected = 'raw-secret-value'
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(encodeFixture(unknown)),
    )

    const invalid = parseFixtureRecord(bytes)
    const sources = requireFixtureRecord(invalid.sources)
    const workItems = requireFixtureRecord(sources['work-items'])
    workItems.invalid = 1
    workItems.mapped = 0
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(encodeFixture(invalid)),
    )

    const badTimestamp = parseFixtureRecord(bytes)
    badTimestamp.completedAt = 'not-a-timestamp'
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(
        encodeFixture(badTimestamp),
      ),
    )

    const canonicalText = new TextDecoder().decode(bytes)
    const duplicateTopLevel = new TextEncoder().encode(
      canonicalText.replace(
        '{',
        '{"kind":"workspace-search-migration-dry-run",',
      ),
    )
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(duplicateTopLevel),
    )
    const contentDigest =
      createDryRunEvidence().sources['project-directory'].contentDigest
    const contentField = `"contentDigest":"${contentDigest}"`
    const duplicateNested = new TextEncoder().encode(
      canonicalText.replace(
        contentField,
        `${contentField},${contentField}`,
      ),
    )
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(duplicateNested),
    )
  })

  test('rejects invalid UTF-8 and oversized input with the stable boundary', () => {
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(
        new Uint8Array([0xc3, 0x28]),
      ),
    )
    expectArtifactFailure(
      () => parseWorkspaceSearchDryRunEvidence(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_ARTIFACT_MAX_BYTES + 1,
        ),
      ),
    )
  })
})

describe('Workspace Search plan-seal artifact codec', () => {
  test('round-trips every dry-run and planning binding canonically', () => {
    const evidence = createDryRunEvidence()
    const planned = createPlannedOperation()
    const seal = createPlanSeal(evidence, planned.planDigest)
    const bytes = serializeWorkspaceSearchPlanSeal(seal)

    expect(bytes.byteLength).toBeLessThanOrEqual(
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
    )
    expect(parseWorkspaceSearchPlanSeal(bytes)).toEqual(seal)
    expect(
      serializeWorkspaceSearchPlanSeal(
        parseWorkspaceSearchPlanSeal(bytes),
      ),
    ).toEqual(bytes)
  })

  test('rejects plan-seal input beyond its dedicated byte ceiling', () => {
    expectArtifactFailure(
      () => parseWorkspaceSearchPlanSeal(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES + 1,
        ),
      ),
    )
  })

  test('rejects count, digest, unknown-field, and canonical-byte tampering', () => {
    const seal = createPlanSeal(
      createDryRunEvidence(),
      createPlannedOperation().planDigest,
    )
    const bytes = serializeWorkspaceSearchPlanSeal(seal)

    const wrongCount = parseFixtureRecord(bytes)
    wrongCount.orphanOperationCount = 1
    expectArtifactFailure(
      () => parseWorkspaceSearchPlanSeal(encodeFixture(wrongCount)),
    )

    const wrongPlanningDigest = parseFixtureRecord(bytes)
    wrongPlanningDigest.planningSnapshotDigest = 'not-a-digest'
    expectArtifactFailure(
      () => parseWorkspaceSearchPlanSeal(
        encodeFixture(wrongPlanningDigest),
      ),
    )

    const nonemptyCountWithEmptyRoot = parseFixtureRecord(bytes)
    nonemptyCountWithEmptyRoot.planDigest =
      createEmptyWorkspaceSearchPlanDigest()
    expectArtifactFailure(
      () => parseWorkspaceSearchPlanSeal(
        encodeFixture(nonemptyCountWithEmptyRoot),
      ),
    )

    const legacyVersion = parseFixtureRecord(bytes)
    legacyVersion.sealVersion = 1
    expectArtifactFailure(
      () => parseWorkspaceSearchPlanSeal(encodeFixture(legacyVersion)),
    )

    const missingPlanningBinding = parseFixtureRecord(bytes)
    delete missingPlanningBinding.planningSnapshotDigest
    expectArtifactFailure(
      () => parseWorkspaceSearchPlanSeal(
        encodeFixture(missingPlanningBinding),
      ),
    )

    const unknown = parseFixtureRecord(bytes)
    unknown.rawTableName = 'tenant-table'
    expectArtifactFailure(
      () => parseWorkspaceSearchPlanSeal(encodeFixture(unknown)),
    )

    const padded = new TextEncoder().encode(
      ` ${new TextDecoder().decode(bytes)}`,
    )
    expectArtifactFailure(() => parseWorkspaceSearchPlanSeal(padded))
  })
})

describe('Workspace Search planned-operation artifact codec', () => {
  test('round-trips exact AttributeValue number and binary encodings', () => {
    const planned = createPlannedOperation()
    const bytes = serializeWorkspaceSearchPlannedOperation(planned)
    const parsed = parseWorkspaceSearchPlannedOperation(bytes)

    expect(parsed).toEqual(planned)
    expect(serializeWorkspaceSearchPlannedOperation(parsed)).toEqual(bytes)
    if (!parsed.operation.sourceCondition.exists) {
      throw new Error('Expected a present source fixture.')
    }
    expect(parsed.operation.sourceCondition.item.preciseNumber).toEqual({
      N: '1.2300',
    })
    expect(parsed.operation.sourceCondition.item.opaqueBytes).toEqual({
      B: new Uint8Array([0, 127, 255]),
    })
  })

  test('round-trips the curated context entity type', () => {
    const contextPlanned = createPlannedContextOperation()
    const parsed = parseWorkspaceSearchPlannedOperation(
      serializeWorkspaceSearchPlannedOperation(contextPlanned),
    )

    expect(parsed).toEqual(contextPlanned)
  })

  test('rejects encoded item, operation digest, plan root, and shape tampering', () => {
    const planned = createPlannedOperation()
    const bytes = serializeWorkspaceSearchPlannedOperation(planned)

    const itemTamper = parseFixtureRecord(bytes)
    const operation = requireFixtureRecord(itemTamper.operation)
    const source = requireFixtureRecord(operation.sourceCondition)
    const item = requireFixtureRecord(source.item)
    const preciseNumber = requireFixtureRecord(item.preciseNumber)
    preciseNumber.value = '1.2301'
    expectArtifactFailure(
      () => parseWorkspaceSearchPlannedOperation(
        encodeFixture(itemTamper),
      ),
    )

    const operationDigestTamper = parseFixtureRecord(bytes)
    operationDigestTamper.operationDigest = 'b'.repeat(64)
    expectArtifactFailure(
      () => parseWorkspaceSearchPlannedOperation(
        encodeFixture(operationDigestTamper),
      ),
    )

    const rootTamper = parseFixtureRecord(bytes)
    rootTamper.planDigest = 'c'.repeat(64)
    expectArtifactFailure(
      () => parseWorkspaceSearchPlannedOperation(
        encodeFixture(rootTamper),
      ),
    )

    const unknown = parseFixtureRecord(bytes)
    unknown.sourceItem = 'must-not-leak'
    expectArtifactFailure(
      () => parseWorkspaceSearchPlannedOperation(encodeFixture(unknown)),
    )
  })

  test('rejects runtime extra fields before serializing typed input', () => {
    const planned = createPlannedOperation()
    Object.defineProperty(planned, 'unexpected', {
      configurable: true,
      enumerable: true,
      value: 'raw-value',
      writable: true,
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchPlannedOperation(planned),
    )
  })

  test('accepts legal expanded items and rejects impossible oversized items', () => {
    const legal = createPlannedOperationWithSourceExtra({
      S: '\u0000'.repeat(350_000),
    })
    const legalBytes = serializeWorkspaceSearchPlannedOperation(legal)
    expect(legalBytes.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    expect(parseWorkspaceSearchPlannedOperation(legalBytes)).toEqual(legal)

    const oversized = createPlannedOperationWithSourceExtra({
      S: 'x'.repeat(500_000),
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchPlannedOperation(oversized),
    )
  })

  test('rejects non-Boolean discriminants and lone surrogate content', () => {
    const sourceDiscriminant = createPlannedOperation()
    Object.defineProperty(
      sourceDiscriminant.operation.sourceCondition,
      'exists',
      {
        configurable: true,
        enumerable: true,
        value: 1,
        writable: true,
      },
    )
    expectArtifactFailure(
      () => serializeWorkspaceSearchPlannedOperation(sourceDiscriminant),
    )

    const snapshotFields: readonly ('before' | 'after')[] = ['before', 'after']
    for (const field of snapshotFields) {
      const snapshotDiscriminant = createPlannedOperation()
      Object.defineProperty(snapshotDiscriminant.operation[field], 'exists', {
        configurable: true,
        enumerable: true,
        value: 0,
        writable: true,
      })
      expectArtifactFailure(
        () => serializeWorkspaceSearchPlannedOperation(snapshotDiscriminant),
      )
    }

    const surrogateContent = createPlannedOperation()
    const source = surrogateContent.operation.sourceCondition
    if (!source.exists) {
      throw new Error('Expected a present source fixture.')
    }
    Object.defineProperty(source.item, 'artifactBoundaryExtra', {
      configurable: true,
      enumerable: true,
      value: { S: '\ud800' },
      writable: true,
    })
    expectArtifactFailure(
      () => serializeWorkspaceSearchPlannedOperation(surrogateContent),
    )

    const surrogateTableName = createPlannedOperation()
    Object.defineProperty(
      surrogateTableName.operation.sourceCondition,
      'tableName',
      {
        configurable: true,
        enumerable: true,
        value: '\ud800',
        writable: true,
      },
    )
    expectArtifactFailure(
      () => serializeWorkspaceSearchPlannedOperation(surrogateTableName),
    )
  })

  test('canonicalizes even hostile same-class failures', () => {
    const planned = createPlannedOperation()
    Object.defineProperty(planned, 'runId', {
      configurable: true,
      enumerable: true,
      get() {
        const error = new WorkspaceSearchMigrationArtifactError()
        Object.defineProperty(error, 'message', {
          configurable: true,
          value: 'TENANT_SECRET',
          writable: true,
        })
        Object.defineProperty(error, 'code', {
          configurable: true,
          value: 'RAW_SECRET_CODE',
          writable: true,
        })
        throw error
      },
    })

    expectArtifactFailure(
      () => serializeWorkspaceSearchPlannedOperation(planned),
    )
  })
})
