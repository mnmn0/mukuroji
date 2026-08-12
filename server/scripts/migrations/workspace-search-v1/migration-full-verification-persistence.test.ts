import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationSourceCheckpoint,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationFullVerificationProgress,
  type WorkspaceSearchMigrationFullVerificationResult,
  type WorkspaceSearchMigrationVerificationBindingAggregate,
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
} from './migration-full-verification'
import {
  createWorkspaceSearchMigrationFullVerificationPageCommandIdentity,
  createWorkspaceSearchMigrationFullVerificationPageReceipt,
  createWorkspaceSearchMigrationFullVerificationPersistenceState,
  createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  createWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  parseWorkspaceSearchMigrationFullVerificationPageReceipt,
  parseWorkspaceSearchMigrationFullVerificationPersistenceState,
  parseWorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  parseWorkspaceSearchMigrationFullVerificationResultArtifact,
  parseWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  serializeWorkspaceSearchMigrationFullVerificationPageReceipt,
  serializeWorkspaceSearchMigrationFullVerificationPersistenceState,
  serializeWorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  serializeWorkspaceSearchMigrationFullVerificationResultArtifact,
  serializeWorkspaceSearchMigrationFullVerificationVerifiedRoot,
  validateWorkspaceSearchMigrationFullVerificationPageReceiptTransition,
  validateWorkspaceSearchMigrationFullVerificationResultArtifactReference,
  type WorkspaceSearchMigrationFullVerificationArtifactReference,
  type WorkspaceSearchMigrationFullVerificationPageCommandIdentity,
  type WorkspaceSearchMigrationFullVerificationPageReceipt,
  type WorkspaceSearchMigrationFullVerificationPersistenceState,
  type WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  type WorkspaceSearchMigrationFullVerificationResultArtifactReference,
  type WorkspaceSearchMigrationFullVerificationTableIds,
} from './migration-full-verification-persistence'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  type WorkspaceSearchMigrationCheckpointLocation,
} from './migration-state-machine'

describe('full-verification persistence contract', () => {
  test('round-trips the exact plan, state, receipt, result, and root chain', () => {
    const fixture = createPersistenceFixture()

    expect(
      parseWorkspaceSearchMigrationFullVerificationPlanArtifactBinding(
        serializeWorkspaceSearchMigrationFullVerificationPlanArtifactBinding(
          fixture.binding,
        ),
      ),
    ).toEqual(fixture.binding)
    expect(
      parseWorkspaceSearchMigrationFullVerificationPersistenceState(
        serializeWorkspaceSearchMigrationFullVerificationPersistenceState(
          fixture.terminalState,
        ),
      ),
    ).toEqual(fixture.terminalState)
    expect(
      parseWorkspaceSearchMigrationFullVerificationPageReceipt(
        serializeWorkspaceSearchMigrationFullVerificationPageReceipt(
          fixture.terminalReceipt,
        ),
      ),
    ).toEqual(fixture.terminalReceipt)
    expect(
      parseWorkspaceSearchMigrationFullVerificationResultArtifact(
        serializeWorkspaceSearchMigrationFullVerificationResultArtifact(
          fixture.result,
        ),
      ),
    ).toEqual(fixture.result)
    expect(
      parseWorkspaceSearchMigrationFullVerificationVerifiedRoot(
        serializeWorkspaceSearchMigrationFullVerificationVerifiedRoot(
          fixture.root,
        ),
      ),
    ).toEqual(fixture.root)
    expect(fixture.receipts[1]?.predecessorCursor).toEqual({
      pk: { type: 'S', value: 'cursor-1' },
    })
    expect(fixture.receipts[0]?.predecessorCommandDigest).toBeNull()
    expect(fixture.receipts[1]?.predecessorCommandDigest).toBe(
      fixture.states[0]?.lastCommandDigest,
    )
  })

  test('rejects stale predecessors and predecessor-command substitution', () => {
    const fixture = createPersistenceFixture()
    const receipt = requireElement(fixture.receipts, 2)
    const staleState = requireElement(fixture.states, 0)
    const successor = requireElement(fixture.states, 2)

    expect(() =>
      validateWorkspaceSearchMigrationFullVerificationPageReceiptTransition(
        receipt,
        { kind: 'verification-state', state: staleState },
        successor,
      )
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')

    const substituted = rehashReceipt({
      ...receipt,
      predecessorCommandDigest: digest('substituted-command'),
    })
    expect(() =>
      validateWorkspaceSearchMigrationFullVerificationPageReceiptTransition(
        substituted,
        {
          kind: 'verification-state',
          state: requireElement(fixture.states, 1),
        },
        successor,
      )
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')
  })

  test('rejects receipt replay across location, revision, cursor, plan, and root', () => {
    const fixture = createPersistenceFixture()
    const predecessorState = requireElement(fixture.states, 0)
    const successorState = requireElement(fixture.states, 1)
    const predecessorProgress = requireElement(fixture.progress, 1)

    const replayInputs = [
      {
        binding: fixture.binding,
        root: fixture.appliedRootDigest,
        location: 'project-directory',
        revision: predecessorState.revision,
        digest: predecessorState.stateDigest,
        progress: predecessorProgress,
      },
      {
        binding: fixture.binding,
        root: fixture.appliedRootDigest,
        location: 'target',
        revision: predecessorState.revision + 1,
        digest: predecessorState.stateDigest,
        progress: predecessorProgress,
      },
      {
        binding: fixture.binding,
        root: fixture.appliedRootDigest,
        location: 'target',
        revision: predecessorState.revision,
        digest: predecessorState.stateDigest,
        progress: replaceTargetCursor(
          predecessorProgress,
          'replayed-cursor',
        ),
      },
      {
        binding: createAlternateBinding(fixture.binding),
        root: fixture.appliedRootDigest,
        location: 'target',
        revision: predecessorState.revision,
        digest: predecessorState.stateDigest,
        progress: predecessorProgress,
      },
      {
        binding: fixture.binding,
        root: digest('substituted-applied-root'),
        location: 'target',
        revision: predecessorState.revision,
        digest: predecessorState.stateDigest,
        progress: predecessorProgress,
      },
    ] satisfies readonly {
      /** Plan-artifact binding selected by the replay. */
      readonly binding:
        WorkspaceSearchMigrationFullVerificationPlanArtifactBinding
      /** Applied root selected by the replay. */
      readonly root: string
      /** Page location selected by the replay. */
      readonly location: WorkspaceSearchMigrationCheckpointLocation
      /** Predecessor revision selected by the replay. */
      readonly revision: number
      /** Predecessor digest selected by the replay. */
      readonly digest: string
      /** Predecessor progress selected by the replay. */
      readonly progress: WorkspaceSearchMigrationFullVerificationProgress
    }[]

    for (const replay of replayInputs) {
      expect(() => {
        const command =
          createWorkspaceSearchMigrationFullVerificationPageCommandIdentity({
            planArtifactBinding: replay.binding,
            tableIds: fixture.tableIds,
            appliedRootDigest: replay.root,
            location: replay.location,
            expectedRevision: replay.revision,
            predecessorDigest: replay.digest,
            predecessorProgress: replay.progress,
          })
        createWorkspaceSearchMigrationFullVerificationPageReceipt({
          commandIdentity: command,
          predecessor: {
            kind: 'verification-state',
            state: predecessorState,
          },
          successorState,
          committedAt: '2026-07-30T00:01:00.000Z',
        })
      }).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')
    }
  })

  test('rejects forged terminal progress and applied-root substitution', () => {
    const fixture = createPersistenceFixture()
    const forgedResult = forgeTerminalProgress(fixture.result)
    const forgedReference = createResultReference(
      fixture.binding,
      fixture.appliedRootDigest,
      forgedResult.resultDigest,
    )

    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
        planArtifactBinding: fixture.binding,
        tableIds: fixture.tableIds,
        appliedRootDigest: fixture.appliedRootDigest,
        verificationResult: forgedResult,
        verificationResultReference: forgedReference,
        terminalState: fixture.terminalState,
        terminalReceipt: fixture.terminalReceipt,
        sealedPlanningAuthorityDigest:
          fixture.binding.sealedPlanningAuthorityDigest,
        publicationAuthority: createPublicationAuthority(),
        verifiedAt: '2026-07-30T00:10:00.000Z',
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')

    const otherRoot = digest('other-applied-root')
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
        planArtifactBinding: fixture.binding,
        tableIds: fixture.tableIds,
        appliedRootDigest: otherRoot,
        verificationResult: fixture.result,
        verificationResultReference: createResultReference(
          fixture.binding,
          otherRoot,
          fixture.result.resultDigest,
        ),
        terminalState: fixture.terminalState,
        terminalReceipt: fixture.terminalReceipt,
        sealedPlanningAuthorityDigest:
          fixture.binding.sealedPlanningAuthorityDigest,
        publicationAuthority: createPublicationAuthority(),
        verifiedAt: '2026-07-30T00:10:00.000Z',
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')
  })

  test('rejects self-rehashed same-count observed-binding substitution', () => {
    const fixture = createPersistenceFixture()
    const exact = createSingleBindingResult(fixture.result)
    expect(() =>
      parseWorkspaceSearchMigrationFullVerificationResultArtifact(
        serializeWorkspaceSearchMigrationFullVerificationResultArtifact(
          exact,
        ),
      )
    ).not.toThrow()

    const substitutedAccumulator = new MigrationDigestAccumulator()
    substitutedAccumulator.add(digest('substituted-binding'))
    const substitutedAggregate =
      createBindingAggregate(substitutedAccumulator)
    const common = {
      kind: exact.kind,
      verificationVersion: exact.verificationVersion,
      migrationId: exact.migrationId,
      migrationVersion: exact.migrationVersion,
      runId: exact.runId,
      configurationHash: exact.configurationHash,
      planDigest: exact.planDigest,
      verificationPlanDigest: exact.verificationPlanDigest,
      planOperationCount: exact.planOperationCount,
      sourceOperationCount: exact.sourceOperationCount,
      orphanOperationCount: exact.orphanOperationCount,
      applySealDigest: exact.applySealDigest,
      sealedPlanningAuthorityDigest:
        exact.sealedPlanningAuthorityDigest,
      sourceCheckpointDigests: exact.sourceCheckpointDigests,
      targetCheckpointDigest: exact.targetCheckpointDigest,
      verification: exact.verification,
      expectedSourceBindings: {
        ...exact.expectedSourceBindings,
        'project-directory': substitutedAggregate,
      },
      observedSourceBindings: {
        ...exact.observedSourceBindings,
        'project-directory': substitutedAggregate,
      },
      expectedTargetPresentBindings:
        exact.expectedTargetPresentBindings,
      observedTargetPresentBindings:
        exact.observedTargetPresentBindings,
      status: exact.status,
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationResult,
      'resultDigest'
    >
    const substituted = {
      ...common,
      resultDigest: createMigrationDigest(common),
    }
    const bytes = new TextEncoder().encode(
      serializeCanonicalJson(substituted),
    )
    expect(() =>
      parseWorkspaceSearchMigrationFullVerificationResultArtifact(
        bytes,
      )
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')
  })

  test('rejects selected binding substitution when mapped count does not advance', () => {
    const fixture = createPersistenceFixture()
    const transition = createZeroMappedDeltaTransition(
      fixture.binding,
      fixture.tableIds,
      fixture.appliedRootDigest,
    )
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationPageReceipt({
        commandIdentity: transition.command,
        predecessor: {
          kind: 'verification-state',
          state: transition.predecessorState,
        },
        successorState: transition.successorState,
        committedAt: '2026-07-30T00:02:00.000Z',
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')
  })

  test('rejects future terminal receipts, retention mismatch, and null versions', () => {
    const fixture = createPersistenceFixture()
    const futureReceipt = rehashReceipt({
      ...fixture.terminalReceipt,
      committedAt: '2026-07-30T00:09:01.000Z',
    })
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
        planArtifactBinding: fixture.binding,
        tableIds: fixture.tableIds,
        appliedRootDigest: fixture.appliedRootDigest,
        verificationResult: fixture.result,
        verificationResultReference: fixture.resultReference,
        terminalState: fixture.terminalState,
        terminalReceipt: futureReceipt,
        sealedPlanningAuthorityDigest:
          fixture.binding.sealedPlanningAuthorityDigest,
        publicationAuthority: createPublicationAuthority(),
        verifiedAt: '2026-07-30T00:10:00.000Z',
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')

    expect(() =>
      createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding({
        runId: fixture.binding.runId,
        configurationHash: fixture.binding.configurationHash,
        planDigest: fixture.binding.planDigest,
        verificationPlanDigest:
          fixture.binding.verificationPlanDigest,
        sealedPlanningAuthorityDigest:
          fixture.binding.sealedPlanningAuthorityDigest,
        planSealReference: fixture.binding.planSealReference,
        planManifestHeadReference: {
          ...fixture.binding.planManifestHeadReference,
          retainUntil: '2027-08-01T00:00:00.000Z',
        },
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')

    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
        planArtifactBinding: fixture.binding,
        tableIds: fixture.tableIds,
        appliedRootDigest: fixture.appliedRootDigest,
        verificationResult: fixture.result,
        verificationResultReference: {
          ...fixture.resultReference,
          retainUntil: '2027-08-01T00:00:00.000Z',
        },
        terminalState: fixture.terminalState,
        terminalReceipt: fixture.terminalReceipt,
        sealedPlanningAuthorityDigest:
          fixture.binding.sealedPlanningAuthorityDigest,
        publicationAuthority: createPublicationAuthority(),
        verifiedAt: '2026-07-30T00:10:00.000Z',
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')

    expect(() =>
      createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding({
        runId: fixture.binding.runId,
        configurationHash: fixture.binding.configurationHash,
        planDigest: fixture.binding.planDigest,
        verificationPlanDigest:
          fixture.binding.verificationPlanDigest,
        sealedPlanningAuthorityDigest:
          fixture.binding.sealedPlanningAuthorityDigest,
        planSealReference: {
          ...fixture.binding.planSealReference,
          versionId: 'null',
        },
        planManifestHeadReference:
          fixture.binding.planManifestHeadReference,
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')

    expect(() =>
      validateWorkspaceSearchMigrationFullVerificationResultArtifactReference({
        ...fixture.resultReference,
        versionId: 'null',
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')
  })

  test('rejects noncanonical bytes and rich result-reference substitution', () => {
    const fixture = createPersistenceFixture()
    const canonical =
      serializeWorkspaceSearchMigrationFullVerificationPageReceipt(
        fixture.terminalReceipt,
      )
    const noncanonical = new TextEncoder().encode(
      ` ${new TextDecoder().decode(canonical)}`,
    )
    expect(() =>
      parseWorkspaceSearchMigrationFullVerificationPageReceipt(
        noncanonical,
      )
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')

    expect(() =>
      validateWorkspaceSearchMigrationFullVerificationResultArtifactReference({
        ...fixture.resultReference,
        appliedRootDigest: digest('other-root'),
      })
    ).not.toThrow()
    expect(() =>
      createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
        planArtifactBinding: fixture.binding,
        tableIds: fixture.tableIds,
        appliedRootDigest: fixture.appliedRootDigest,
        verificationResult: fixture.result,
        verificationResultReference: {
          ...fixture.resultReference,
          appliedRootDigest: digest('other-root'),
        },
        terminalState: fixture.terminalState,
        terminalReceipt: fixture.terminalReceipt,
        sealedPlanningAuthorityDigest:
          fixture.binding.sealedPlanningAuthorityDigest,
        publicationAuthority: createPublicationAuthority(),
        verifiedAt: '2026-07-30T00:10:00.000Z',
      })
    ).toThrow('INVALID_FULL_VERIFICATION_PERSISTENCE')
  })
})

/**
 * Creates one complete six-page verification persistence chain.
 *
 * @returns Exact binding, state/receipt chain, result, and verified root.
 */
function createPersistenceFixture() {
  const binding =
    createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding({
      runId: 'verification-run',
      configurationHash: digest('configuration'),
      planDigest: digest('plan'),
      verificationPlanDigest: digest('verification-plan'),
      sealedPlanningAuthorityDigest: digest('sealed-authority'),
      planSealReference: createArtifactReference('plan-seal'),
      planManifestHeadReference:
        createArtifactReference('plan-manifest-head'),
    })
  const tableIds = createTableIds()
  const appliedRootDigest = digest('applied-root')
  const states:
    WorkspaceSearchMigrationFullVerificationPersistenceState[] = []
  const receipts:
    WorkspaceSearchMigrationFullVerificationPageReceipt[] = []
  const commands:
    WorkspaceSearchMigrationFullVerificationPageCommandIdentity[] = []
  const progress: WorkspaceSearchMigrationFullVerificationProgress[] = [
    createInitialProgress(binding),
  ]
  const locations: readonly WorkspaceSearchMigrationCheckpointLocation[] = [
    'target',
    'target',
    'project-directory',
    'work-items',
    'collaboration',
    'documents',
  ]

  for (let index = 0; index < locations.length; index += 1) {
    const location = requireElement(locations, index)
    const predecessorProgress = requireElement(progress, index)
    const predecessorState = states[index - 1] ?? null
    const expectedRevision = predecessorState?.revision ?? 0
    const predecessorDigest =
      predecessorState?.stateDigest ?? appliedRootDigest
    const command =
      createWorkspaceSearchMigrationFullVerificationPageCommandIdentity({
        planArtifactBinding: binding,
        tableIds,
        appliedRootDigest,
        location,
        expectedRevision,
        predecessorDigest,
        predecessorProgress,
      })
    const successorProgress = advanceProgress(
      predecessorProgress,
      location,
      index !== 0,
    )
    const successorState =
      createWorkspaceSearchMigrationFullVerificationPersistenceState({
        planArtifactBinding: binding,
        tableIds,
        appliedRootDigest,
        revision: expectedRevision + 1,
        predecessorKind:
          predecessorState === null
            ? 'applied-root'
            : 'verification-state',
        predecessorDigest,
        lastCommandDigest: command.commandDigest,
        progress: successorProgress,
      })
    const committedAt = `2026-07-30T00:0${index}:00.000Z`
    const receipt =
      predecessorState === null
        ? createWorkspaceSearchMigrationFullVerificationPageReceipt({
            commandIdentity: command,
            predecessor: {
              kind: 'applied-root',
              progress: predecessorProgress,
            },
            successorState,
            committedAt,
          })
        : createWorkspaceSearchMigrationFullVerificationPageReceipt({
            commandIdentity: command,
            predecessor: {
              kind: 'verification-state',
              state: predecessorState,
            },
            successorState,
            committedAt,
          })
    commands.push(command)
    states.push(successorState)
    receipts.push(receipt)
    progress.push(successorProgress)
  }

  const terminalState = requireElement(states, states.length - 1)
  const terminalReceipt = requireElement(receipts, receipts.length - 1)
  const terminalProgress = requireElement(progress, progress.length - 1)
  const result = createResult(binding, terminalProgress)
  const resultReference = createResultReference(
    binding,
    appliedRootDigest,
    result.resultDigest,
  )
  const root =
    createWorkspaceSearchMigrationFullVerificationVerifiedRoot({
      planArtifactBinding: binding,
      tableIds,
      appliedRootDigest,
      verificationResult: result,
      verificationResultReference: resultReference,
      terminalState,
      terminalReceipt,
      sealedPlanningAuthorityDigest:
        binding.sealedPlanningAuthorityDigest,
      publicationAuthority: createPublicationAuthority(),
      verifiedAt: '2026-07-30T00:10:00.000Z',
    })
  return {
    appliedRootDigest,
    binding,
    commands,
    progress,
    receipts,
    result,
    resultReference,
    root,
    states,
    tableIds,
    terminalReceipt,
    terminalState,
  }
}

/**
 * Creates canonical initial pure-kernel progress for one plan binding.
 *
 * @param binding - Exact compact plan-artifact binding.
 * @returns Fresh canonical initial progress.
 */
function createInitialProgress(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
): WorkspaceSearchMigrationFullVerificationProgress {
  return {
    kind: 'workspace-search-migration-full-verification-progress',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    planDigest: binding.planDigest,
    verificationPlanDigest: binding.verificationPlanDigest,
    traversal: createEmptyWorkspaceSearchMigrationTraversal(),
    sourceBindings: {
      'project-directory':
        new MigrationDigestAccumulator().exportState(),
      'work-items':
        new MigrationDigestAccumulator().exportState(),
      collaboration:
        new MigrationDigestAccumulator().exportState(),
      documents:
        new MigrationDigestAccumulator().exportState(),
    },
    targetPresentBindings:
      new MigrationDigestAccumulator().exportState(),
  }
}

/**
 * Advances exactly one selected empty-table checkpoint by one page.
 *
 * @param progress - Exact predecessor progress.
 * @param location - Selected source or target traversal.
 * @param completed - Whether this page completes the selected traversal.
 * @returns Detached exact successor progress.
 */
function advanceProgress(
  progress: WorkspaceSearchMigrationFullVerificationProgress,
  location: WorkspaceSearchMigrationCheckpointLocation,
  completed: boolean,
): WorkspaceSearchMigrationFullVerificationProgress {
  if (location === 'target') {
    return {
      ...progress,
      traversal: {
        sources: progress.traversal.sources,
        target: advanceCheckpoint(
          progress.traversal.target,
          completed,
        ),
      },
    }
  }
  const next = advanceCheckpoint(
    progress.traversal.sources[location],
    completed,
  )
  return {
    ...progress,
    traversal: {
      sources: {
        'project-directory':
          location === 'project-directory'
            ? next
            : progress.traversal.sources['project-directory'],
        'work-items':
          location === 'work-items'
            ? next
            : progress.traversal.sources['work-items'],
        collaboration:
          location === 'collaboration'
            ? next
            : progress.traversal.sources.collaboration,
        documents:
          location === 'documents'
            ? next
            : progress.traversal.sources.documents,
      },
      target: progress.traversal.target,
    },
  }
}

/**
 * Advances one empty checkpoint and optionally retains a binary-safe cursor.
 *
 * @param checkpoint - Exact selected predecessor checkpoint.
 * @param completed - Whether this page completes the traversal.
 * @returns Detached exact successor checkpoint.
 */
function advanceCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
  completed: boolean,
): MigrationSourceCheckpoint {
  const common = {
    completed,
    aggregate: {
      ...checkpoint.aggregate,
      pageCount: checkpoint.aggregate.pageCount + 1,
    },
    keyDigestState: checkpoint.keyDigestState,
    contentDigestState: checkpoint.contentDigestState,
  }
  return completed
    ? common
    : {
        ...common,
        cursor: { pk: { S: 'cursor-1' } },
      }
}

/**
 * Replaces the target cursor while retaining a valid predecessor checkpoint.
 *
 * @param progress - Exact predecessor progress.
 * @param cursor - Replacement cursor text.
 * @returns Detached progress with a different exact cursor.
 */
function replaceTargetCursor(
  progress: WorkspaceSearchMigrationFullVerificationProgress,
  cursor: string,
): WorkspaceSearchMigrationFullVerificationProgress {
  return {
    ...progress,
    traversal: {
      sources: progress.traversal.sources,
      target: {
        ...progress.traversal.target,
        cursor: { pk: { S: cursor } },
      },
    },
  }
}

/**
 * Creates one strict successful result from terminal empty-table progress.
 *
 * @param binding - Exact compact plan binding.
 * @param progress - Exact terminal pure-kernel progress.
 * @returns Strict self-digested verification result.
 */
function createResult(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  progress: WorkspaceSearchMigrationFullVerificationProgress,
): WorkspaceSearchMigrationFullVerificationResult {
  const aggregate = createEmptyBindingAggregate()
  const sourceCheckpointDigests = {
    'project-directory':
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.traversal.sources['project-directory'],
      ),
    'work-items':
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.traversal.sources['work-items'],
      ),
    collaboration:
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.traversal.sources.collaboration,
      ),
    documents:
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.traversal.sources.documents,
      ),
  }
  const common = {
    kind: 'workspace-search-migration-full-verification-result',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    migrationId: 'workspace-search-maintenance',
    migrationVersion: 1,
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    planDigest: binding.planDigest,
    verificationPlanDigest: binding.verificationPlanDigest,
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    applySealDigest: digest('apply-seal'),
    sealedPlanningAuthorityDigest:
      binding.sealedPlanningAuthorityDigest,
    sourceCheckpointDigests,
    targetCheckpointDigest:
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        progress.traversal.target,
      ),
    verification: progress,
    expectedSourceBindings: {
      'project-directory': aggregate,
      'work-items': aggregate,
      collaboration: aggregate,
      documents: aggregate,
    },
    observedSourceBindings: {
      'project-directory': aggregate,
      'work-items': aggregate,
      collaboration: aggregate,
      documents: aggregate,
    },
    expectedTargetPresentBindings: aggregate,
    observedTargetPresentBindings: aggregate,
    status: 'pass',
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationResult,
    'resultDigest'
  >
  return { ...common, resultDigest: createMigrationDigest(common) }
}

/**
 * Creates a valid one-source-binding result for substitution testing.
 *
 * @param result - Exact empty-table successful result.
 * @returns Self-digested result whose Project Directory progress has one binding.
 */
function createSingleBindingResult(
  result: WorkspaceSearchMigrationFullVerificationResult,
): WorkspaceSearchMigrationFullVerificationResult {
  const bindingAccumulator = new MigrationDigestAccumulator()
  bindingAccumulator.add(digest('exact-binding'))
  const bindingAggregate =
    createBindingAggregate(bindingAccumulator)
  const checkpoint = createScannedCheckpoint({
    completed: true,
    contentDigests: [digest('source-content-1')],
    ignored: 0,
    keyDigests: [digest('source-key-1')],
    mapped: 1,
    pageCount: 1,
  })
  const progress = {
    ...result.verification,
    traversal: {
      sources: {
        ...result.verification.traversal.sources,
        'project-directory': checkpoint,
      },
      target: result.verification.traversal.target,
    },
    sourceBindings: {
      ...result.verification.sourceBindings,
      'project-directory': bindingAccumulator.exportState(),
    },
  }
  const common = {
    kind: result.kind,
    verificationVersion: result.verificationVersion,
    migrationId: result.migrationId,
    migrationVersion: result.migrationVersion,
    runId: result.runId,
    configurationHash: result.configurationHash,
    planDigest: result.planDigest,
    verificationPlanDigest: result.verificationPlanDigest,
    planOperationCount: 1,
    sourceOperationCount: 1,
    orphanOperationCount: 0,
    applySealDigest: result.applySealDigest,
    sealedPlanningAuthorityDigest:
      result.sealedPlanningAuthorityDigest,
    sourceCheckpointDigests: {
      ...result.sourceCheckpointDigests,
      'project-directory':
        createWorkspaceSearchMigrationSourceCheckpointDigest(
          checkpoint,
        ),
    },
    targetCheckpointDigest: result.targetCheckpointDigest,
    verification: progress,
    expectedSourceBindings: {
      ...result.expectedSourceBindings,
      'project-directory': bindingAggregate,
    },
    observedSourceBindings: {
      ...result.observedSourceBindings,
      'project-directory': bindingAggregate,
    },
    expectedTargetPresentBindings:
      result.expectedTargetPresentBindings,
    observedTargetPresentBindings:
      result.observedTargetPresentBindings,
    status: result.status,
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationResult,
    'resultDigest'
  >
  return { ...common, resultDigest: createMigrationDigest(common) }
}

/**
 * Creates a selected target transition with no mapped-count delta but a
 * substituted same-count binding accumulator.
 *
 * @param binding - Exact compact plan binding.
 * @param tableIds - Exact physical table identities.
 * @param appliedRootDigest - Immutable applied root being verified.
 * @returns Predecessor, command, and deliberately invalid successor.
 */
function createZeroMappedDeltaTransition(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  tableIds: WorkspaceSearchMigrationFullVerificationTableIds,
  appliedRootDigest: string,
) {
  const predecessorBinding = new MigrationDigestAccumulator()
  predecessorBinding.add(digest('predecessor-target-binding'))
  const successorBinding = new MigrationDigestAccumulator()
  successorBinding.add(digest('successor-target-binding'))
  const initial = createInitialProgress(binding)
  const predecessorProgress = {
    ...initial,
    traversal: {
      sources: initial.traversal.sources,
      target: {
        ...createScannedCheckpoint({
          completed: false,
          contentDigests: [digest('target-content-1')],
          ignored: 0,
          keyDigests: [digest('target-key-1')],
          mapped: 1,
          pageCount: 1,
        }),
        cursor: { pk: { S: 'target-cursor-1' } },
      },
    },
    targetPresentBindings: predecessorBinding.exportState(),
  }
  const predecessorState =
    createWorkspaceSearchMigrationFullVerificationPersistenceState({
      planArtifactBinding: binding,
      tableIds,
      appliedRootDigest,
      revision: 1,
      predecessorKind: 'applied-root',
      predecessorDigest: appliedRootDigest,
      lastCommandDigest: digest('predecessor-command'),
      progress: predecessorProgress,
    })
  const command =
    createWorkspaceSearchMigrationFullVerificationPageCommandIdentity({
      planArtifactBinding: binding,
      tableIds,
      appliedRootDigest,
      location: 'target',
      expectedRevision: predecessorState.revision,
      predecessorDigest: predecessorState.stateDigest,
      predecessorProgress,
    })
  const successorProgress = {
    ...predecessorProgress,
    traversal: {
      sources: predecessorProgress.traversal.sources,
      target: createScannedCheckpoint({
        completed: true,
        contentDigests: [
          digest('target-content-1'),
          digest('target-content-2'),
        ],
        ignored: 1,
        keyDigests: [
          digest('target-key-1'),
          digest('target-key-2'),
        ],
        mapped: 1,
        pageCount: 2,
      }),
    },
    targetPresentBindings: successorBinding.exportState(),
  }
  const successorState =
    createWorkspaceSearchMigrationFullVerificationPersistenceState({
      planArtifactBinding: binding,
      tableIds,
      appliedRootDigest,
      revision: 2,
      predecessorKind: 'verification-state',
      predecessorDigest: predecessorState.stateDigest,
      lastCommandDigest: command.commandDigest,
      progress: successorProgress,
    })
  return { command, predecessorState, successorState }
}

/**
 * Input for one internally consistent scanned-checkpoint fixture.
 */
type CreateScannedCheckpointInput = {
  /** Whether the selected traversal is terminal. */
  readonly completed: boolean
  /** Exact content digests accumulated in this checkpoint. */
  readonly contentDigests: readonly string[]
  /** Exact number of ignored rows. */
  readonly ignored: number
  /** Exact physical-key digests accumulated in this checkpoint. */
  readonly keyDigests: readonly string[]
  /** Exact number of mapped rows. */
  readonly mapped: number
  /** Exact cumulative page count. */
  readonly pageCount: number
}

/**
 * Creates one internally consistent scanned checkpoint.
 *
 * @param input - Exact row digests, counters, completion, and page count.
 * @returns Strict cumulative checkpoint without a cursor.
 */
function createScannedCheckpoint(
  input: CreateScannedCheckpointInput,
): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  for (const value of input.keyDigests) keyAccumulator.add(value)
  const contentAccumulator = new MigrationDigestAccumulator()
  for (const value of input.contentDigests) {
    contentAccumulator.add(value)
  }
  const scanned = input.keyDigests.length
  if (
    input.contentDigests.length !== scanned ||
    input.mapped + input.ignored !== scanned
  ) {
    throw new Error('Invalid scanned-checkpoint fixture.')
  }
  return {
    completed: input.completed,
    aggregate: {
      scanned,
      mapped: input.mapped,
      ignored: input.ignored,
      invalid: 0,
      projected: input.mapped,
      deleted: 0,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: input.pageCount,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates one internally consistent empty verification binding aggregate.
 *
 * @returns Exact empty binding aggregate.
 */
function createEmptyBindingAggregate():
  WorkspaceSearchMigrationVerificationBindingAggregate {
  const accumulator = new MigrationDigestAccumulator()
  return createBindingAggregate(accumulator)
}

/**
 * Creates one binding aggregate from an exact accumulator.
 *
 * @param accumulator - Exact verification binding accumulator.
 * @returns Count, state, and derived digest.
 */
function createBindingAggregate(
  accumulator: MigrationDigestAccumulator,
): WorkspaceSearchMigrationVerificationBindingAggregate {
  return {
    count: accumulator.size(),
    digestState: accumulator.exportState(),
    digest: accumulator.digest(),
  }
}

/**
 * Creates a self-consistent but state-divergent terminal result.
 *
 * @param result - Exact successful fixture result.
 * @returns Successful result with a forged terminal target page count.
 */
function forgeTerminalProgress(
  result: WorkspaceSearchMigrationFullVerificationResult,
): WorkspaceSearchMigrationFullVerificationResult {
  const forgedProgress = {
    ...result.verification,
    traversal: {
      sources: result.verification.traversal.sources,
      target: {
        ...result.verification.traversal.target,
        aggregate: {
          ...result.verification.traversal.target.aggregate,
          pageCount:
            result.verification.traversal.target.aggregate.pageCount + 1,
        },
      },
    },
  }
  const common = {
    kind: result.kind,
    verificationVersion: result.verificationVersion,
    migrationId: result.migrationId,
    migrationVersion: result.migrationVersion,
    runId: result.runId,
    configurationHash: result.configurationHash,
    planDigest: result.planDigest,
    verificationPlanDigest: result.verificationPlanDigest,
    planOperationCount: result.planOperationCount,
    sourceOperationCount: result.sourceOperationCount,
    orphanOperationCount: result.orphanOperationCount,
    applySealDigest: result.applySealDigest,
    sealedPlanningAuthorityDigest:
      result.sealedPlanningAuthorityDigest,
    sourceCheckpointDigests: result.sourceCheckpointDigests,
    targetCheckpointDigest:
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        forgedProgress.traversal.target,
      ),
    verification: forgedProgress,
    expectedSourceBindings: result.expectedSourceBindings,
    observedSourceBindings: result.observedSourceBindings,
    expectedTargetPresentBindings:
      result.expectedTargetPresentBindings,
    observedTargetPresentBindings:
      result.observedTargetPresentBindings,
    status: result.status,
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationResult,
    'resultDigest'
  >
  return { ...common, resultDigest: createMigrationDigest(common) }
}

/**
 * Creates one alternate self-consistent plan binding.
 *
 * @param binding - Original exact binding.
 * @returns Binding with a different verification-plan digest.
 */
function createAlternateBinding(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
): WorkspaceSearchMigrationFullVerificationPlanArtifactBinding {
  return createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding({
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    planDigest: binding.planDigest,
    verificationPlanDigest: digest('alternate-verification-plan'),
    sealedPlanningAuthorityDigest:
      binding.sealedPlanningAuthorityDigest,
    planSealReference: binding.planSealReference,
    planManifestHeadReference: binding.planManifestHeadReference,
  })
}

/**
 * Creates one exact generic immutable artifact reference.
 *
 * @param label - Stable fixture label.
 * @returns Exact rich immutable reference.
 */
function createArtifactReference(
  label: string,
): WorkspaceSearchMigrationFullVerificationArtifactReference {
  return {
    objectKey: `workspace-search/v1/${label}`,
    versionId: `${label}-version`,
    contentDigest: digest(`${label}-content`),
    byteLength: 128,
    retainUntil: '2027-07-30T00:00:00.000Z',
  }
}

/**
 * Creates one rich semantic-envelope result reference.
 *
 * @param binding - Exact compact plan binding.
 * @param appliedRootDigest - Exact applied root carried by the envelope.
 * @param resultDigest - Exact semantic verification-result digest.
 * @returns Strict rich result-artifact reference.
 */
function createResultReference(
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
  appliedRootDigest: string,
  resultDigest: string,
): WorkspaceSearchMigrationFullVerificationResultArtifactReference {
  return {
    kind:
      'workspace-search-migration-verification-result-artifact-reference',
    artifactVersion: 1,
    runId: binding.runId,
    configurationHash: binding.configurationHash,
    appliedRootDigest,
    verificationResultDigest: resultDigest,
    envelopeDigest: digest(`envelope:${resultDigest}`),
    objectKey: `workspace-search/v1/results/${resultDigest}`,
    versionId: 'result-version',
    contentDigest: digest(`content:${resultDigest}`),
    byteLength: 1024,
    retainUntil: '2027-07-30T00:00:00.000Z',
  }
}

/**
 * Creates all six exact physical fixture TableIds.
 *
 * @returns Fixed-role TableId record.
 */
function createTableIds():
  WorkspaceSearchMigrationFullVerificationTableIds {
  return {
    'project-directory': 'table-project-directory',
    'work-items': 'table-work-items',
    collaboration: 'table-collaboration',
    documents: 'table-documents',
    'workspace-search': 'table-workspace-search',
    'migration-state': 'table-migration-state',
  }
}

/**
 * Creates one exact authority snapshot used by verified publication.
 *
 * @returns Fresh canonical publication authority.
 */
function createPublicationAuthority() {
  return {
    ownerId: 'verification-owner',
    fenceToken: 7,
    maintenanceEvidencePointerRevision: 11,
    maintenanceEvidenceReceiptDigest: digest('maintenance-receipt'),
    evaluatedAt: '2026-07-30T00:09:00.000Z',
  }
}

/**
 * Recomputes one receipt digest after a deliberate test-only substitution.
 *
 * @param receipt - Receipt fields carrying one substituted value.
 * @returns Self-digested substituted receipt.
 */
function rehashReceipt(
  receipt: WorkspaceSearchMigrationFullVerificationPageReceipt,
): WorkspaceSearchMigrationFullVerificationPageReceipt {
  const {
    receiptDigest: _receiptDigest,
    ...fields
  } = receipt
  return {
    ...fields,
    receiptDigest: createMigrationDigest(fields),
  }
}

/**
 * Returns one required array element without a type assertion.
 *
 * @param values - Candidate readonly array.
 * @param index - Required zero-based index.
 * @returns Existing array element.
 */
function requireElement<Value>(
  values: readonly Value[],
  index: number,
): Value {
  const value = values[index]
  if (value === undefined) {
    throw new Error('Expected persistence fixture element.')
  }
  return value
}

/**
 * Creates a deterministic lowercase digest for one fixture label.
 *
 * @param label - Stable test label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}
