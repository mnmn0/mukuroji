import { describe, expect, test } from 'bun:test'
import {
  createTeamWorkspaceSearchDocument,
  createWorkspaceSearchDocument,
  createWorkItemWorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  createWorkspaceSearchMigrationScanSnapshotDigest,
  type DynamoAttributeMap,
  MigrationDigestAccumulator,
  type MigrationKeyAttribute,
  type MigrationScanAggregate,
  type MigrationTableIdentity,
  type WorkspaceSearchDryRunEvidence,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationScanSnapshot,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationSourceName,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeWorkspaceSearchDryRunEvidence,
} from './migration-artifacts'
import {
  createWorkspaceSearchMigrationOperationDigest,
  createWorkspaceSearchPlanLeafDigest,
  createWorkspaceSearchPlanNodeDigest,
  type WorkspaceSearchPlannedOperation,
} from './migration-state-machine'
import {
  classifyWorkspaceSearchMigrationTargetRow,
  type CreateWorkspaceSearchMigrationOrphanCandidateInput,
  type CreateWorkspaceSearchMigrationSourceCandidateInput,
  createWorkspaceSearchMigrationOrphanCandidate,
  createWorkspaceSearchMigrationSourceCandidate,
  type SealWorkspaceSearchMigrationPlanInput,
  sealWorkspaceSearchMigrationPlan,
  type WorkspaceSearchMigrationPlanCandidate,
  type WorkspaceSearchMigrationSourceOwnershipBinding,
  type WorkspaceSearchMigrationSourceScanRowEvidence,
  type WorkspaceSearchMigrationTargetOwnershipEvidence,
} from './migration-planner'
import {
  encodeWorkspaceSearchMigrationDocument,
} from './migration-target-snapshot'

const configuration = createConfiguration()
const configurationHash =
  createWorkspaceSearchConfigurationHash(configuration)

describe('Workspace Search migration planner', () => {
  test('derives exact source operations and ignores recognized non-target rows', () => {
    const sourceTable = createSourceTable('project-directory')
    const candidate = requireCandidate(
      createWorkspaceSearchMigrationSourceCandidate({
        configurationHash,
        source: 'project-directory',
        sourceTable,
        sourceItem: createTeamSourceItem('team-1', 1),
      }),
    )

    expect(candidate.origin).toBe('source')
    expect(candidate.operation.sourceCondition.exists).toBe(true)
    expect(candidate.operation.entityType).toBe('team')
    expect(candidate.operation.before.exists).toBe(false)
    expect(candidate.operation.after.exists).toBe(true)
    expect(candidate.operation.sourceCondition.tableId)
      .toBe(sourceTable.tableId)

    const ignored = createWorkspaceSearchMigrationSourceCandidate({
      configurationHash,
      source: 'project-directory',
      sourceTable,
      sourceItem: {
        directoryId: { S: 'workspace-1' },
        entryKey: { S: 'WORKSPACE_MEMBER#member-1' },
        entryType: { S: 'workspace-member' },
      },
    })
    expect(ignored).toBeUndefined()
  })

  test('fails closed for malformed source and target rows', () => {
    expect(() => createWorkspaceSearchMigrationSourceCandidate({
      configurationHash,
      source: 'project-directory',
      sourceTable: createSourceTable('project-directory'),
      sourceItem: {
        ...createTeamSourceItem('team-1', 1),
        nameJa: { N: '1' },
      },
    })).toThrow(WorkspaceSearchMigrationFailure)

    expect(() => classifyWorkspaceSearchMigrationTargetRow({
      workspaceId: { S: 'workspace-1' },
      recordKey: { S: 'VIEW#view-1' },
      entryType: { S: 'search-document' },
    })).toThrow(WorkspaceSearchMigrationFailure)
  })

  test('classifies non-migration target families without deleting them', () => {
    expect(classifyWorkspaceSearchMigrationTargetRow({
      workspaceId: { S: 'workspace-1' },
      recordKey: { S: 'VIEW#view-1' },
      entryType: { S: 'saved-view' },
    })).toEqual({
      classification: 'ignored',
      reasonCode: 'RECOGNIZED_NON_TARGET_ROW',
    })

    const file = createWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      entityType: 'file',
      entityId: 'file-1',
      title: 'Retained file',
      url: '/files/file-1',
    })
    const fileItem = encodeWorkspaceSearchMigrationDocument(file)
    expect(classifyWorkspaceSearchMigrationTargetRow(fileItem)).toEqual({
      classification: 'ignored',
      reasonCode: 'UNOWNED_SEARCH_ENTITY',
    })
    expect(createWorkspaceSearchMigrationOrphanCandidate({
      configurationHash,
      sourceTable: createSourceTable('documents'),
      targetItem: fileItem,
    })).toBeUndefined()
  })

  test('derives recoverable orphan source keys and rejects directory ambiguity', () => {
    const orphanDocument = createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'issue-1',
      title: 'Orphan projection',
    })
    const orphan = requireCandidate(
      createWorkspaceSearchMigrationOrphanCandidate({
        configurationHash,
        sourceTable: createSourceTable('work-items'),
        targetItem: encodeWorkspaceSearchMigrationDocument(orphanDocument),
      }),
    )
    const source = orphan.operation.sourceCondition
    expect(source.exists).toBe(false)
    if (source.exists) {
      throw new Error('Expected an absent orphan source.')
    }
    expect(source.key).toEqual({
      directoryTeamId: { S: 'workspace-1#team#team-1' },
      issueId: { S: 'issue-1' },
    })
    expect(orphan.operation.before.exists).toBe(true)
    expect(orphan.operation.after.exists).toBe(false)

    const team = createTeamWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      title: 'Ambiguous orphan',
    })
    expectMigrationFailureCode(
      () => createWorkspaceSearchMigrationOrphanCandidate({
        configurationHash,
        sourceTable: createSourceTable('project-directory'),
        targetItem: encodeWorkspaceSearchMigrationDocument(team),
      }),
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
  })

  test('orders by target digest and creates duplicate-last Merkle proofs', () => {
    const candidates = [
      createTeamCandidate('team-3', 3),
      createTeamCandidate('team-1', 1),
      createTeamCandidate('team-2', 2),
    ]
    const scanSnapshot = createScanSnapshot(candidates)
    const reviewedDryRun = createReviewedDryRun(scanSnapshot)
    const plan = sealWorkspaceSearchMigrationPlan({
      runId: 'run-1',
      configurationHash,
      configuration,
      dryRunEvidenceDigest: reviewedDryRun.digest,
      reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
      scanSnapshot,
      targetOwnershipEvidence: createTargetOwnershipEvidence(candidates),
      candidates,
      createdAt: '2026-07-26T02:00:00.000Z',
    })

    const sortedTargetDigests = candidates
      .map(({ operation }) => operation.targetKeyDigest)
      .sort()
    expect(plan.operations.map(({ operation }) => operation.targetKeyDigest))
      .toEqual(sortedTargetDigests)
    expect(plan.operations.map(({ planSequence }) => planSequence))
      .toEqual([1, 2, 3])
    for (const operation of plan.operations) {
      expect(reproducePlanRoot(operation)).toBe(plan.seal.planDigest)
    }
    const lastProof = plan.operations[2]?.membershipProof[0]
    expect(lastProof?.side).toBe('right')
    expect(lastProof?.digest).toBe(
      createWorkspaceSearchPlanLeafDigest({
        planSequence: 3,
        operationDigest: plan.operations[2]?.operationDigest ?? '',
      }),
    )
    expect(plan.seal).toMatchObject({
      sealVersion: 2,
      dryRunEvidenceDigest: reviewedDryRun.digest,
      planningSnapshotDigest:
        createWorkspaceSearchMigrationScanSnapshotDigest(scanSnapshot),
      planOperationCount: 3,
      sourceOperationCount: 3,
      orphanOperationCount: 0,
    })

    const reversed = sealWorkspaceSearchMigrationPlan({
      runId: 'run-1',
      configurationHash,
      configuration,
      dryRunEvidenceDigest: reviewedDryRun.digest,
      reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
      scanSnapshot,
      targetOwnershipEvidence: createTargetOwnershipEvidence(candidates),
      candidates: [...candidates].reverse(),
      createdAt: '2026-07-26T02:00:00.000Z',
    })
    expect(reversed).toEqual(plan)
  })

  test('binds orphan counts and rejects duplicate target ownership', () => {
    const source = createTeamCandidate('team-1', 1)
    const orphanDocument = createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'issue-1',
      title: 'Orphan projection',
    })
    const orphan = requireCandidate(
      createWorkspaceSearchMigrationOrphanCandidate({
        configurationHash,
        sourceTable: createSourceTable('work-items'),
        targetItem: encodeWorkspaceSearchMigrationDocument(orphanDocument),
      }),
    )
    const candidates = [orphan, source]
    const scanSnapshot = createScanSnapshot(candidates)
    const reviewedDryRun = createReviewedDryRun(scanSnapshot)
    const plan = sealWorkspaceSearchMigrationPlan({
      runId: 'run-2',
      configurationHash,
      configuration,
      dryRunEvidenceDigest: reviewedDryRun.digest,
      reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
      scanSnapshot,
      targetOwnershipEvidence: createTargetOwnershipEvidence(candidates),
      candidates,
      createdAt: '2026-07-26T02:00:00.000Z',
    })
    expect(plan.seal).toMatchObject({
      planOperationCount: 2,
      sourceOperationCount: 1,
      orphanOperationCount: 1,
    })

    expectMigrationFailureCode(
      () => {
        const collisionCandidates = [source, source]
        const collisionSnapshot = createScanSnapshot(collisionCandidates)
        const collisionDryRun = createReviewedDryRun(collisionSnapshot)
        return sealWorkspaceSearchMigrationPlan({
          runId: 'run-collision',
          configurationHash,
          configuration,
          dryRunEvidenceDigest: collisionDryRun.digest,
          reviewedDryRunEvidenceBytes: collisionDryRun.bytes,
          scanSnapshot: collisionSnapshot,
          targetOwnershipEvidence:
            createTargetOwnershipEvidence(collisionCandidates),
          candidates: collisionCandidates,
          createdAt: '2026-07-26T02:00:00.000Z',
        })
      },
      'AMBIGUOUS_OPERATION_UNRESOLVED',
    )
  })

  test('rejects sparse candidate lists before counting or Merkle sealing', () => {
    const source = createTeamCandidate('team-sparse', 4)
    const sparseCandidates: WorkspaceSearchMigrationPlanCandidate[] = [source]
    sparseCandidates.length = 2

    expectMigrationFailureCode(
      () => sealFixture(
        sparseCandidates,
        createScanSnapshot([source]),
        createTargetOwnershipEvidence([source]),
      ),
      'INVALID_STATE',
    )

    const replacedIndex: WorkspaceSearchMigrationPlanCandidate[] = [source]
    replacedIndex.length = 2
    Object.defineProperty(replacedIndex, 'extra', {
      configurable: true,
      enumerable: true,
      value: source,
      writable: true,
    })
    expectMigrationFailureCode(
      () => sealFixture(
        replacedIndex,
        createScanSnapshot([source]),
        createTargetOwnershipEvidence([source]),
      ),
      'INVALID_STATE',
    )
  })

  test('rejects invalid scan evidence and source-operation omissions', () => {
    const source = createTeamCandidate('team-1', 1)
    const cleanSnapshot = createScanSnapshot([source])
    const cleanDryRun = createReviewedDryRun(cleanSnapshot)
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-invalid-scan',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: cleanDryRun.digest,
        reviewedDryRunEvidenceBytes: cleanDryRun.bytes,
        scanSnapshot: {
          ...cleanSnapshot,
          target: {
            ...cleanSnapshot.target,
            scanned: 1,
            invalid: 1,
          },
        },
        targetOwnershipEvidence: createTargetOwnershipEvidence([source]),
        candidates: [source],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'DRY_RUN_INVALID_ROWS',
    )
    const completeSources = [
      source,
      createTeamCandidate('team-2', 2),
    ]
    const omittedSourceSnapshot = createScanSnapshot(completeSources)
    const omittedSourceDryRun = createReviewedDryRun(omittedSourceSnapshot)
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-omitted-source',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: omittedSourceDryRun.digest,
        reviewedDryRunEvidenceBytes: omittedSourceDryRun.bytes,
        scanSnapshot: omittedSourceSnapshot,
        targetOwnershipEvidence:
          createTargetOwnershipEvidence(completeSources),
        candidates: [source],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'INVALID_STATE',
    )
  })

  test('binds sealing to exact reviewed dry-run bytes and planning scans', () => {
    const source = createTeamCandidate('team-1', 1)
    const scanSnapshot = createScanSnapshot([source])
    const reviewedDryRun = createReviewedDryRun(scanSnapshot)
    const targetOwnershipEvidence = createTargetOwnershipEvidence([source])
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-dry-run-digest-mismatch',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: createMigrationDigest('unreviewed-evidence'),
        reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
        scanSnapshot,
        targetOwnershipEvidence,
        candidates: [source],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'INVALID_STATE',
    )

    const differentPlanningSnapshot = {
      ...scanSnapshot,
      target: {
        ...scanSnapshot.target,
        contentDigest: createMigrationDigest('different-target-content'),
      },
    }
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-planning-snapshot-mismatch',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: reviewedDryRun.digest,
        reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
        scanSnapshot: differentPlanningSnapshot,
        targetOwnershipEvidence,
        candidates: [source],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'INVALID_STATE',
    )

    const otherConfigurationHash = createMigrationDigest(
      'different-configuration',
    )
    const otherConfigurationDryRun = createReviewedDryRun({
      ...scanSnapshot,
      configurationHash: otherConfigurationHash,
    })
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-dry-run-configuration-mismatch',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: otherConfigurationDryRun.digest,
        reviewedDryRunEvidenceBytes: otherConfigurationDryRun.bytes,
        scanSnapshot,
        targetOwnershipEvidence,
        candidates: [source],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'CONFIGURATION_HASH_MISMATCH',
    )

    const noncanonicalBytes = new Uint8Array([
      ...reviewedDryRun.bytes,
      0x0a,
    ])
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-noncanonical-dry-run',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: reviewedDryRun.digest,
        reviewedDryRunEvidenceBytes: noncanonicalBytes,
        scanSnapshot,
        targetOwnershipEvidence,
        candidates: [source],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'DRY_RUN_INVALID_ROWS',
    )
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-before-dry-run',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: reviewedDryRun.digest,
        reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
        scanSnapshot,
        targetOwnershipEvidence,
        candidates: [source],
        createdAt: '2026-07-26T01:29:59.999Z',
      }),
      'INVALID_STATE',
    )
  })

  test('rejects omitted and injected valid orphan candidates', () => {
    const source = createTeamCandidate('team-1', 1)
    const orphanDocument = createWorkItemWorkspaceSearchDocument({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      issueId: 'issue-1',
      title: 'Orphan projection',
    })
    const orphan = requireCandidate(
      createWorkspaceSearchMigrationOrphanCandidate({
        configurationHash,
        sourceTable: createSourceTable('work-items'),
        targetItem: encodeWorkspaceSearchMigrationDocument(orphanDocument),
      }),
    )

    const observedOrphanSnapshot = createScanSnapshot([source, orphan])
    const observedOrphanDryRun = createReviewedDryRun(
      observedOrphanSnapshot,
    )
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-omitted-orphan',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: observedOrphanDryRun.digest,
        reviewedDryRunEvidenceBytes: observedOrphanDryRun.bytes,
        scanSnapshot: observedOrphanSnapshot,
        targetOwnershipEvidence:
          createTargetOwnershipEvidence([source, orphan]),
        candidates: [source],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'INVALID_STATE',
    )

    const noOrphanSnapshot = createScanSnapshot([source])
    const noOrphanDryRun = createReviewedDryRun(noOrphanSnapshot)
    expectMigrationFailureCode(
      () => sealWorkspaceSearchMigrationPlan({
        runId: 'run-injected-orphan',
        configurationHash,
        configuration,
        dryRunEvidenceDigest: noOrphanDryRun.digest,
        reviewedDryRunEvidenceBytes: noOrphanDryRun.bytes,
        scanSnapshot: noOrphanSnapshot,
        targetOwnershipEvidence: createTargetOwnershipEvidence([source]),
        candidates: [source, orphan],
        createdAt: '2026-07-26T02:00:00.000Z',
      }),
      'INVALID_STATE',
    )
  })

  test('rejects nonliteral discriminators and nonexact operation shapes', () => {
    const source = createTeamCandidate('team-1', 1)
    const scanSnapshot = createScanSnapshot([source])
    const ownership = createTargetOwnershipEvidence([source])
    const unknownOrigin = structuredClone(source)
    Object.defineProperty(unknownOrigin, 'origin', {
      configurable: true,
      enumerable: true,
      value: 'unexpected',
      writable: true,
    })
    expectMigrationFailureCode(
      () => sealFixture([unknownOrigin], scanSnapshot, ownership),
      'INVALID_STATE',
    )

    const nonBooleanSource = structuredClone(source)
    Object.defineProperty(nonBooleanSource.operation.sourceCondition, 'exists', {
      configurable: true,
      enumerable: true,
      value: 1,
      writable: true,
    })
    expectMigrationFailureCode(
      () => sealFixture([nonBooleanSource], scanSnapshot, ownership),
      'INVALID_STATE',
    )

    const nonBooleanBefore = structuredClone(source)
    Object.defineProperty(nonBooleanBefore.operation.before, 'exists', {
      configurable: true,
      enumerable: true,
      value: 0,
      writable: true,
    })
    const nonBooleanAfter = structuredClone(source)
    Object.defineProperty(nonBooleanAfter.operation.after, 'exists', {
      configurable: true,
      enumerable: true,
      value: 1,
      writable: true,
    })
    const extraOperationField = structuredClone(source)
    Object.defineProperty(extraOperationField.operation, 'unsealed', {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    })
    const extraSourceField = structuredClone(source)
    Object.defineProperty(extraSourceField.operation.sourceCondition, 'unsealed', {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    })
    const extraBeforeField = structuredClone(source)
    Object.defineProperty(extraBeforeField.operation.before, 'unsealed', {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    })
    const extraAfterField = structuredClone(source)
    Object.defineProperty(extraAfterField.operation.after, 'unsealed', {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    })
    for (const invalid of [
      nonBooleanBefore,
      nonBooleanAfter,
      extraOperationField,
      extraSourceField,
      extraBeforeField,
      extraAfterField,
    ]) {
      expectMigrationFailureCode(
        () => sealFixture([invalid], scanSnapshot, ownership),
        'INVALID_STATE',
      )
    }

    const replacedEnumerableKey = structuredClone(source.operation)
    Object.defineProperty(replacedEnumerableKey, 'operationId', {
      configurable: true,
      enumerable: false,
      value: replacedEnumerableKey.operationId,
      writable: true,
    })
    Object.defineProperty(replacedEnumerableKey, 'unsealed', {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    })
    expectMigrationFailureCode(
      () => createWorkspaceSearchMigrationOperationDigest(
        replacedEnumerableKey,
      ),
      'INVALID_STATE',
    )
  })

  test('detaches source candidates and sealed plans from caller-owned values', () => {
    const sourceItem = createTeamSourceItem('team-detached', 8)
    const inputBinary = new Uint8Array([1, 2, 3])
    sourceItem.opaqueBinary = { B: inputBinary }
    const candidate = requireCandidate(
      createWorkspaceSearchMigrationSourceCandidate({
        configurationHash,
        source: 'project-directory',
        sourceTable: createSourceTable('project-directory'),
        sourceItem,
      }),
    )
    const source = candidate.operation.sourceCondition
    if (!source.exists) {
      throw new Error('Expected a present source candidate.')
    }

    sourceItem.directoryId = { S: 'workspace-mutated' }
    sourceItem.nameEn = { S: 'Mutated input' }
    inputBinary[0] = 9
    expect(source.key.directoryId).toEqual({ S: 'workspace-1' })
    expect(source.item.nameEn).toEqual({ S: 'Team team-detached' })
    expect(source.item.opaqueBinary).toEqual({ B: new Uint8Array([1, 2, 3]) })

    const scanSnapshot = createScanSnapshot([candidate])
    const plan = sealFixture(
      [candidate],
      scanSnapshot,
      createTargetOwnershipEvidence([candidate]),
    )
    const planned = plan.operations[0]
    if (!planned || !planned.operation.sourceCondition.exists) {
      throw new Error('Expected one sealed present-source operation.')
    }
    source.item.nameEn = { S: 'Mutated candidate' }
    const candidateBinary = source.item.opaqueBinary?.B
    if (!(candidateBinary instanceof Uint8Array)) {
      throw new Error('Expected a binary candidate attribute.')
    }
    candidateBinary[1] = 8
    candidate.operation.targetKey.workspaceId = { S: 'workspace-mutated' }

    expect(planned.operation.sourceCondition.item.nameEn)
      .toEqual({ S: 'Team team-detached' })
    expect(planned.operation.sourceCondition.item.opaqueBinary)
      .toEqual({ B: new Uint8Array([1, 2, 3]) })
    expect(planned.operation.targetKey.workspaceId)
      .toEqual({ S: 'workspace-1' })
    expect(createWorkspaceSearchMigrationOperationDigest(planned.operation))
      .toBe(planned.operationDigest)
    expect(reproducePlanRoot(planned)).toBe(plan.seal.planDigest)
  })

  test('replaces hostile failures at every public planner boundary', () => {
    const canary = 'TENANT_SECRET_RAW_VALUE'
    const unsafeFailure = new WorkspaceSearchMigrationFailure(
      'IDENTITY_MISMATCH',
      canary,
    )
    let codeReads = 0
    Object.defineProperty(unsafeFailure, 'code', {
      configurable: true,
      enumerable: true,
      get() {
        codeReads += 1
        return codeReads === 1 ? 'IDENTITY_MISMATCH' : canary
      },
    })
    const sourceTable = createSourceTable('project-directory')
    Object.defineProperty(sourceTable, 'role', {
      configurable: true,
      enumerable: true,
      get() {
        throw unsafeFailure
      },
    })
    const sourceInput: CreateWorkspaceSearchMigrationSourceCandidateInput = {
      configurationHash,
      source: 'project-directory',
      sourceTable,
      sourceItem: createTeamSourceItem('team-hostile', 9),
    }
    const sourceFailure = capturePlannerFailure(
      () => createWorkspaceSearchMigrationSourceCandidate(sourceInput),
    )
    expect(sourceFailure).not.toBe(unsafeFailure)
    expect(sourceFailure.code).toBe('IDENTITY_MISMATCH')
    expect(sourceFailure.message).not.toContain(canary)

    const rawTargetFailure = new Error(canary)
    const hostileTarget = new Proxy<DynamoAttributeMap>({}, {
      ownKeys() {
        throw rawTargetFailure
      },
    })
    const targetFailure = capturePlannerFailure(
      () => classifyWorkspaceSearchMigrationTargetRow(hostileTarget),
    )
    expect(targetFailure).not.toBe(rawTargetFailure)
    expect(targetFailure.message).not.toContain(canary)

    const orphanInput: CreateWorkspaceSearchMigrationOrphanCandidateInput = {
      configurationHash,
      sourceTable: createSourceTable('work-items'),
      targetItem: encodeWorkspaceSearchMigrationDocument(
        createWorkItemWorkspaceSearchDocument({
          workspaceId: 'workspace-1',
          teamId: 'team-1',
          issueId: 'issue-hostile',
          title: 'Hostile orphan',
        }),
      ),
    }
    const rawOrphanFailure = new Error(canary)
    Object.defineProperty(orphanInput, 'configurationHash', {
      configurable: true,
      enumerable: true,
      get() {
        throw rawOrphanFailure
      },
    })
    const orphanFailure = capturePlannerFailure(
      () => createWorkspaceSearchMigrationOrphanCandidate(orphanInput),
    )
    expect(orphanFailure).not.toBe(rawOrphanFailure)
    expect(orphanFailure.message).not.toContain(canary)

    const candidate = createTeamCandidate('team-seal-hostile', 10)
    const scanSnapshot = createScanSnapshot([candidate])
    const reviewedDryRun = createReviewedDryRun(scanSnapshot)
    const sealInput: SealWorkspaceSearchMigrationPlanInput = {
      runId: 'run-hostile',
      configurationHash,
      configuration,
      dryRunEvidenceDigest: reviewedDryRun.digest,
      reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
      scanSnapshot,
      targetOwnershipEvidence: createTargetOwnershipEvidence([candidate]),
      candidates: [candidate],
      createdAt: '2026-07-26T02:00:00.000Z',
    }
    const changingSealInput: SealWorkspaceSearchMigrationPlanInput = {
      ...sealInput,
    }
    let runIdReads = 0
    Object.defineProperty(changingSealInput, 'runId', {
      configurable: true,
      enumerable: true,
      get() {
        runIdReads += 1
        return `run-snapshot-${runIdReads}`
      },
    })
    const snapshottedPlan = sealWorkspaceSearchMigrationPlan(changingSealInput)
    expect(runIdReads).toBe(1)
    expect(snapshottedPlan.seal.runId).toBe('run-snapshot-1')
    expect(snapshottedPlan.operations.every(
      ({ runId }) => runId === 'run-snapshot-1',
    )).toBe(true)

    const rawSealFailure = new Error(canary)
    Object.defineProperty(sealInput, 'runId', {
      configurable: true,
      enumerable: true,
      get() {
        throw rawSealFailure
      },
    })
    const sealFailure = capturePlannerFailure(
      () => sealWorkspaceSearchMigrationPlan(sealInput),
    )
    expect(sealFailure).not.toBe(rawSealFailure)
    expect(sealFailure.message).not.toContain(canary)
  })

  test('rebinds candidates to the complete reviewed configuration', () => {
    const source = createTeamCandidate('team-1', 1)
    const scanSnapshot = createScanSnapshot([source])
    const ownership = createTargetOwnershipEvidence([source])
    expectMigrationFailureCode(
      () => sealFixture(
        [source],
        scanSnapshot,
        ownership,
        {
          ...configuration,
          profile: 'different-operator-profile',
        },
      ),
      'CONFIGURATION_HASH_MISMATCH',
    )

    const otherConfigurationHash = createMigrationDigest(
      'other-candidate-configuration',
    )
    const otherConfigurationCandidate = createTeamCandidate(
      'team-1',
      1,
      otherConfigurationHash,
    )
    expectMigrationFailureCode(
      () => sealFixture(
        [otherConfigurationCandidate],
        createScanSnapshot([otherConfigurationCandidate]),
        createTargetOwnershipEvidence([otherConfigurationCandidate]),
      ),
      'CONFIGURATION_HASH_MISMATCH',
    )

    const staleTable = {
      ...createSourceTable('project-directory'),
      tableId: 'stale-project-directory-table-id',
    }
    const staleTableCandidate = createTeamCandidate(
      'team-1',
      1,
      configurationHash,
      staleTable,
    )
    expectMigrationFailureCode(
      () => sealFixture(
        [staleTableCandidate],
        createScanSnapshot([staleTableCandidate]),
        createTargetOwnershipEvidence([staleTableCandidate]),
      ),
      'IDENTITY_MISMATCH',
    )
  })

  test('rejects same-count source, action, and evidence substitutions', () => {
    const reviewedSource = createTeamCandidate('team-1', 1)
    const substitutedSource = createTeamCandidate('team-2', 2)
    const scanSnapshot = createScanSnapshot([reviewedSource])
    const ownership = createTargetOwnershipEvidence([reviewedSource])
    expectMigrationFailureCode(
      () => sealFixture([substitutedSource], scanSnapshot, ownership),
      'INVALID_STATE',
    )
    expectMigrationFailureCode(
      () => sealFixture(
        [substitutedSource],
        scanSnapshot,
        createTargetOwnershipEvidence([substitutedSource]),
      ),
      'INVALID_STATE',
    )

    const crossSourceCandidate = createWorkItemCandidate()
    expectMigrationFailureCode(
      () => sealFixture([crossSourceCandidate], scanSnapshot, ownership),
      'INVALID_STATE',
    )

    const archivedSource = createArchivedTeamCandidate('team-1', 1)
    expectMigrationFailureCode(
      () => sealFixture(
        [archivedSource],
        scanSnapshot,
        createTargetOwnershipEvidence([archivedSource]),
      ),
      'INVALID_STATE',
    )

    const reviewedOrphan = createWorkItemOrphanCandidate('issue-reviewed')
    const substitutedOrphan =
      createWorkItemOrphanCandidate('issue-substituted')
    const orphanSnapshot = createScanSnapshot([reviewedOrphan])
    const orphanOwnership =
      createTargetOwnershipEvidence([reviewedOrphan])
    expectMigrationFailureCode(
      () => sealFixture(
        [substitutedOrphan],
        orphanSnapshot,
        orphanOwnership,
      ),
      'INVALID_STATE',
    )
    expectMigrationFailureCode(
      () => sealFixture(
        [substitutedOrphan],
        orphanSnapshot,
        createTargetOwnershipEvidence([substitutedOrphan]),
      ),
      'INVALID_STATE',
    )
  })

  test('reconstructs ignored-row aggregates without creating operations', () => {
    const sourceKeyDigest = createMigrationDigest('ignored-source-key')
    const sourceItemDigest = createMigrationDigest('ignored-source-item')
    const targetKeyDigest = createMigrationDigest('ignored-target-key')
    const targetItemDigest = createMigrationDigest('ignored-target-item')
    const emptySnapshot = createScanSnapshot([])
    const sourceIgnoredAggregate = {
      ...createAggregateFromDigests(
        [sourceKeyDigest],
        [sourceItemDigest],
        0,
        0,
      ),
      mapped: 0,
      ignored: 1,
    }
    const targetIgnoredAggregate = {
      ...createAggregateFromDigests(
        [targetKeyDigest],
        [targetItemDigest],
        0,
        0,
      ),
      mapped: 0,
      ignored: 1,
    }
    const scanSnapshot: WorkspaceSearchMigrationScanSnapshot = {
      ...emptySnapshot,
      sources: {
        ...emptySnapshot.sources,
        documents: sourceIgnoredAggregate,
      },
      target: targetIgnoredAggregate,
    }
    const emptyOwnership = createTargetOwnershipEvidence([])
    const ownership: WorkspaceSearchMigrationTargetOwnershipEvidence = {
      ...emptyOwnership,
      sourceRows: {
        ...emptyOwnership.sourceRows,
        documents: [
          ...emptyOwnership.sourceRows.documents,
          {
            classification: 'ignored',
            sourceKeyDigest,
            sourceItemDigest,
          },
        ],
      },
      targetRows: [
        ...emptyOwnership.targetRows,
        {
          classification: 'ignored',
          targetKeyDigest,
          targetItemDigest,
        },
      ],
    }

    const plan = sealFixture([], scanSnapshot, ownership)

    expect(plan.operations).toEqual([])
    expect(plan.seal.planOperationCount).toBe(0)
  })
})

/**
 * Creates exact canonical reviewed dry-run bytes and their SHA-256 digest.
 *
 * @param scanSnapshot - Complete aggregate evidence to serialize.
 * @returns Canonical bytes and the digest of those exact bytes.
 */
function createReviewedDryRun(
  scanSnapshot: WorkspaceSearchMigrationScanSnapshot,
) {
  const evidence: WorkspaceSearchDryRunEvidence = {
    kind: 'workspace-search-migration-dry-run',
    evidenceVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    configurationHash: scanSnapshot.configurationHash,
    startedAt: '2026-07-26T01:00:00.000Z',
    completedAt: '2026-07-26T01:30:00.000Z',
    sources: scanSnapshot.sources,
    target: scanSnapshot.target,
    status: 'pass',
  }
  return {
    bytes: serializeWorkspaceSearchDryRunEvidence(evidence),
    digest: createMigrationDigest(evidence),
  }
}

/**
 * Seals one planner fixture against exact reviewed scan evidence.
 *
 * @param candidates - Candidate set supplied to the final seal.
 * @param scanSnapshot - Independently reproduced aggregate snapshot.
 * @param ownership - Independently reproduced row and ownership evidence.
 * @param measuredConfiguration - Full configuration supplied to the seal.
 * @returns Sealed deterministic plan.
 */
function sealFixture(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
  scanSnapshot: WorkspaceSearchMigrationScanSnapshot,
  ownership: ReturnType<typeof createTargetOwnershipEvidence>,
  measuredConfiguration: WorkspaceSearchMigrationConfiguration = configuration,
) {
  const reviewedDryRun = createReviewedDryRun(scanSnapshot)
  return sealWorkspaceSearchMigrationPlan({
    runId: 'run-adversarial-fixture',
    configurationHash,
    configuration: measuredConfiguration,
    dryRunEvidenceDigest: reviewedDryRun.digest,
    reviewedDryRunEvidenceBytes: reviewedDryRun.bytes,
    scanSnapshot,
    targetOwnershipEvidence: ownership,
    candidates,
    createdAt: '2026-07-26T02:00:00.000Z',
  })
}

/**
 * Reproduces explicit source ownership, observed-target, and orphan sets.
 *
 * @param candidates - Complete plan candidates for the fixture.
 * @returns Exact target-ownership evidence.
 */
function createTargetOwnershipEvidence(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
): WorkspaceSearchMigrationTargetOwnershipEvidence {
  return {
    sourceRows: {
      'project-directory': createSourceScanRows(
        candidates,
        'project-directory',
      ),
      'work-items': createSourceScanRows(candidates, 'work-items'),
      collaboration: createSourceScanRows(candidates, 'collaboration'),
      documents: createSourceScanRows(candidates, 'documents'),
    },
    targetRows: candidates
      .filter(({ operation }) => operation.before.exists)
      .map((candidate) => {
        const before = candidate.operation.before
        if (!before.exists) {
          throw new Error('Expected an owned target scan row.')
        }
        const classification = 'owned'
        return {
          classification,
          targetKeyDigest: candidate.operation.targetKeyDigest,
          targetItemDigest: before.digest,
        }
      }),
    sourceBindings: {
      'project-directory': createSourceOwnershipBindings(
        candidates,
        'project-directory',
      ),
      'work-items': createSourceOwnershipBindings(candidates, 'work-items'),
      collaboration:
        createSourceOwnershipBindings(candidates, 'collaboration'),
      documents: createSourceOwnershipBindings(candidates, 'documents'),
    },
    observedTargetBindings: candidates
      .filter(({ operation }) => operation.before.exists)
      .map((candidate) => {
        const before = candidate.operation.before
        if (!before.exists) {
          throw new Error('Expected an observed target preimage.')
        }
        return {
          targetKeyDigest: candidate.operation.targetKeyDigest,
          targetItemDigest: before.digest,
        }
      }),
    expectedSourceTargetKeyDigests: candidates
      .filter(({ origin }) => origin === 'source')
      .map(({ operation }) => operation.targetKeyDigest),
    observedTargetKeyDigests: candidates
      .filter(({ operation }) => operation.before.exists)
      .map(({ operation }) => operation.targetKeyDigest),
    orphanTargetKeyDigests: candidates
      .filter(({ origin }) => origin === 'orphan')
      .map(({ operation }) => operation.targetKeyDigest),
  }
}

/**
 * Creates exact mapped-row evidence for one complete source scan fixture.
 *
 * @param candidates - Complete fixture candidate set.
 * @param source - Source scan whose rows are requested.
 * @returns Exact mapped source row digests.
 */
function createSourceScanRows(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
  source: WorkspaceSearchMigrationSourceName,
): readonly WorkspaceSearchMigrationSourceScanRowEvidence[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.origin === 'source' &&
        candidate.operation.sourceCondition.source === source,
    )
    .map((candidate) => {
      const condition = candidate.operation.sourceCondition
      if (!condition.exists) {
        throw new Error('Expected a mapped source scan row.')
      }
      const classification = 'mapped'
      return {
        classification,
        sourceKeyDigest: condition.keyDigest,
        sourceItemDigest: condition.itemDigest,
      }
    })
}

/**
 * Creates exact source ownership bindings for one independent scan fixture.
 *
 * @param candidates - Complete fixture candidate set.
 * @param source - Source scan whose bindings are requested.
 * @returns Exact source key, item, target, and action bindings.
 */
function createSourceOwnershipBindings(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
  source: WorkspaceSearchMigrationSourceName,
): readonly WorkspaceSearchMigrationSourceOwnershipBinding[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.origin === 'source' &&
        candidate.operation.sourceCondition.source === source,
    )
    .map((candidate) => {
      const condition = candidate.operation.sourceCondition
      if (!condition.exists) {
        throw new Error('Expected a present source ownership binding.')
      }
      const targetAction = candidate.operation.after.exists ? 'put' : 'delete'
      return {
        sourceKeyDigest: condition.keyDigest,
        sourceItemDigest: condition.itemDigest,
        targetKeyDigest: candidate.operation.targetKeyDigest,
        targetAction,
      }
    })
}

/**
 * Creates one canonical Project Directory Team source item.
 *
 * @param teamId - Canonical Team ID.
 * @param sortOrder - Physical directory display order.
 * @param archivedAt - Optional canonical archive time.
 * @returns Exact low-level source item.
 */
function createTeamSourceItem(
  teamId: string,
  sortOrder: number,
  archivedAt?: string,
): DynamoAttributeMap {
  return {
    directoryId: { S: 'workspace-1' },
    entryKey: {
      S: `${String(sortOrder).padStart(6, '0')}#000000#TEAM#${teamId}`,
    },
    entryType: { S: 'team' },
    teamId: { S: teamId },
    teamSortOrder: { N: String(sortOrder) },
    nameJa: { S: `チーム ${teamId}` },
    nameEn: { S: `Team ${teamId}` },
    expanded: { BOOL: true },
    ...(archivedAt ? { archivedAt: { S: archivedAt } } : {}),
  }
}

/**
 * Creates one validated Team plan candidate.
 *
 * @param teamId - Canonical Team ID.
 * @param sortOrder - Physical directory display order.
 * @param candidateConfigurationHash - Configuration digest bound to the operation.
 * @param sourceTable - Physical source table bound to the operation.
 * @returns Exact source-derived operation candidate.
 */
function createTeamCandidate(
  teamId: string,
  sortOrder: number,
  candidateConfigurationHash = configurationHash,
  sourceTable = createSourceTable('project-directory'),
): WorkspaceSearchMigrationPlanCandidate {
  return requireCandidate(createWorkspaceSearchMigrationSourceCandidate({
    configurationHash: candidateConfigurationHash,
    source: 'project-directory',
    sourceTable,
    sourceItem: createTeamSourceItem(teamId, sortOrder),
  }))
}

/**
 * Creates one canonical archived Team deletion candidate.
 *
 * @param teamId - Canonical Team ID.
 * @param sortOrder - Physical directory display order.
 * @returns Exact source-derived deletion candidate.
 */
function createArchivedTeamCandidate(
  teamId: string,
  sortOrder: number,
): WorkspaceSearchMigrationPlanCandidate {
  return requireCandidate(createWorkspaceSearchMigrationSourceCandidate({
    configurationHash,
    source: 'project-directory',
    sourceTable: createSourceTable('project-directory'),
    sourceItem: createTeamSourceItem(
      teamId,
      sortOrder,
      '2026-07-25T01:00:00.000Z',
    ),
  }))
}

/**
 * Creates one canonical Work Item put candidate owned by a different source.
 *
 * @returns Exact Work Item source-derived candidate.
 */
function createWorkItemCandidate(): WorkspaceSearchMigrationPlanCandidate {
  return requireCandidate(createWorkspaceSearchMigrationSourceCandidate({
    configurationHash,
    source: 'work-items',
    sourceTable: createSourceTable('work-items'),
    sourceItem: {
      schemaVersion: { N: '1' },
      revision: { N: '3' },
      workflowSchemaVersion: { N: '1' },
      directoryId: { S: 'workspace-1' },
      directoryTeamId: { S: 'workspace-1#team#team-1' },
      directoryProjectId: { S: 'workspace-1#project#project-1' },
      teamId: { S: 'team-1' },
      assignedProjectId: { S: 'project-1' },
      issueId: { S: 'issue-1' },
      sortOrder: { N: '10' },
      title: { S: 'Prepare migration' },
      description: { S: 'Verify the maintenance controls.' },
      assigneeUserId: { S: 'assignee@example.com' },
      creatorMemberKey: { S: 'creator@example.com' },
      workflowStatusId: { S: 'in-progress' },
      statusCategory: { S: 'started' },
      customFieldValues: {
        M: {
          estimate: { N: '3' },
        },
      },
      relationIds: { L: [{ S: 'blocks:issue-2' }] },
      dueDate: { S: '2026/07/31' },
      priority: { S: 'high' },
      createdAt: { S: '2026-07-20T01:00:00.000Z' },
      updatedAt: { S: '2026-07-25T01:00:00.000Z' },
    },
  }))
}

/**
 * Creates one exact Work Item orphan deletion candidate.
 *
 * @param issueId - Canonical orphan Work Item ID.
 * @returns Exact absent-source deletion candidate.
 */
function createWorkItemOrphanCandidate(
  issueId: string,
): WorkspaceSearchMigrationPlanCandidate {
  const document = createWorkItemWorkspaceSearchDocument({
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    issueId,
    title: `Orphan ${issueId}`,
  })
  return requireCandidate(createWorkspaceSearchMigrationOrphanCandidate({
    configurationHash,
    sourceTable: createSourceTable('work-items'),
    targetItem: encodeWorkspaceSearchMigrationDocument(document),
  }))
}

/**
 * Requires one candidate in tests that expect a mapped row.
 *
 * @param candidate - Optional planner result.
 * @returns Required plan candidate.
 */
function requireCandidate(
  candidate: WorkspaceSearchMigrationPlanCandidate | undefined,
): WorkspaceSearchMigrationPlanCandidate {
  if (!candidate) throw new Error('Expected a migration plan candidate.')
  return candidate
}

/**
 * Creates the complete measured configuration bound to every planner fixture.
 *
 * @returns Reviewed migration configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
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
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one complete measured source table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source identity fixture.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key: sourceKeyDescriptors(role),
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: false,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? createMigrationDigest('documents-key')
      : null,
    ttl: role === 'collaboration'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : role === 'documents'
        ? { status: 'ENABLED', attribute: 'expiresAtEpoch' }
        : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Creates one complete target or state table identity.
 *
 * @param role - Non-source migration table role.
 * @returns Stable supporting table identity fixture.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key: role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection: true,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`${role}-key`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the exact measured key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered partition and sort key descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Creates complete scan aggregates for planner sealing tests.
 *
 * @param candidates - Independent source and target scan fixture results.
 * @returns Complete planning scan snapshot.
 */
function createScanSnapshot(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
): WorkspaceSearchMigrationScanSnapshot {
  return {
    configurationHash,
    sources: {
      'project-directory': createSourceAggregate(
        candidates,
        'project-directory',
      ),
      'work-items': createSourceAggregate(candidates, 'work-items'),
      collaboration: createSourceAggregate(candidates, 'collaboration'),
      documents: createSourceAggregate(candidates, 'documents'),
    },
    target: createTargetAggregate(candidates),
  }
}

/**
 * Creates one exact source aggregate from mapped candidate scan rows.
 *
 * @param candidates - Complete fixture candidate set.
 * @param source - Source table whose aggregate is requested.
 * @returns Exact one-page source aggregate.
 */
function createSourceAggregate(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
  source: WorkspaceSearchMigrationSourceName,
): MigrationScanAggregate {
  const sourceCandidates = candidates.filter(
    (candidate) =>
      candidate.origin === 'source' &&
      candidate.operation.sourceCondition.source === source,
  )
  const keyDigests: string[] = []
  const itemDigests: string[] = []
  for (const candidate of sourceCandidates) {
    const condition = candidate.operation.sourceCondition
    if (!condition.exists) {
      throw new Error('Expected a present source aggregate row.')
    }
    keyDigests.push(condition.keyDigest)
    itemDigests.push(condition.itemDigest)
  }
  const projected = sourceCandidates.filter(
    ({ operation }) => operation.after.exists,
  ).length
  return createAggregateFromDigests(
    keyDigests,
    itemDigests,
    projected,
    sourceCandidates.length - projected,
  )
}

/**
 * Creates the exact target aggregate from observed candidate preimages.
 *
 * @param candidates - Complete fixture candidate set.
 * @returns Exact one-page target aggregate.
 */
function createTargetAggregate(
  candidates: readonly WorkspaceSearchMigrationPlanCandidate[],
): MigrationScanAggregate {
  const observed = candidates.filter(
    ({ operation }) => operation.before.exists,
  )
  const keyDigests = observed.map(
    ({ operation }) => operation.targetKeyDigest,
  )
  const itemDigests = observed.map(({ operation }) => {
    if (!operation.before.exists) {
      throw new Error('Expected an observed target aggregate row.')
    }
    return operation.before.digest
  })
  const projected = observed.filter(
    ({ operation }) => operation.after.exists,
  ).length
  return createAggregateFromDigests(
    keyDigests,
    itemDigests,
    projected,
    observed.length - projected,
  )
}

/**
 * Creates an internally consistent mapped-only scan aggregate.
 *
 * @param keyDigests - Exact physical row-key digests.
 * @param itemDigests - Exact low-level row-content digests.
 * @param projected - Exact present target outcome count.
 * @param deleted - Exact absent target outcome count.
 * @returns Complete one-page aggregate.
 */
function createAggregateFromDigests(
  keyDigests: readonly string[],
  itemDigests: readonly string[],
  projected: number,
  deleted: number,
): MigrationScanAggregate {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  for (const digest of keyDigests) keyAccumulator.add(digest)
  for (const digest of itemDigests) contentAccumulator.add(digest)
  return {
    scanned: keyDigests.length,
    mapped: keyDigests.length,
    ignored: 0,
    invalid: 0,
    projected,
    deleted,
    keyDigest: keyAccumulator.digest(),
    contentDigest: contentAccumulator.digest(),
    pageCount: 1,
  }
}

/**
 * Reproduces the root accepted by the state-machine membership validator.
 *
 * @param planned - Planned operation and exact sibling path.
 * @returns Root digest reached by the proof.
 */
function reproducePlanRoot(
  planned: WorkspaceSearchPlannedOperation,
): string {
  let digest = createWorkspaceSearchPlanLeafDigest({
    planSequence: planned.planSequence,
    operationDigest: planned.operationDigest,
  })
  for (const step of planned.membershipProof) {
    digest = step.side === 'left'
      ? createWorkspaceSearchPlanNodeDigest(step.digest, digest)
      : createWorkspaceSearchPlanNodeDigest(digest, step.digest)
  }
  return digest
}

/**
 * Captures one fresh safe planner failure for detailed boundary assertions.
 *
 * @param call - Deferred planner entrypoint invocation.
 * @returns Exact migration failure emitted by the public boundary.
 */
function capturePlannerFailure(
  call: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) return error
  }
  throw new Error('Expected a WorkspaceSearchMigrationFailure.')
}

/**
 * Requires one synchronous planner call to fail with an exact stable code.
 *
 * @param call - Deferred planner operation.
 * @param code - Expected safe failure code.
 */
function expectMigrationFailureCode(
  call: () => unknown,
  code: WorkspaceSearchMigrationFailureCode,
): void {
  try {
    call()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkspaceSearchMigrationFailure)
    if (error instanceof WorkspaceSearchMigrationFailure) {
      expect(error.code).toBe(code)
      return
    }
  }
  throw new Error(`Expected WorkspaceSearchMigrationFailure ${code}.`)
}
