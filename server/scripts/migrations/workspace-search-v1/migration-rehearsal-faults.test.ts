import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchMigrationRehearsalFaultController,
  parseWorkspaceSearchMigrationRehearsalFaultReceipt,
  snapshotWorkspaceSearchMigrationRehearsalFaultPlan,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS,
  WorkspaceSearchMigrationRehearsalFaultError,
  type WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint,
  type WorkspaceSearchMigrationRehearsalFaultErrorCode,
  type WorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultReach,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
  type WorkspaceSearchMigrationRehearsalPlanningPageFailpoint,
} from './migration-rehearsal-faults'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'

/** Stable test time used by every secret-free reach receipt. */
const reachedAt = '2026-08-02T00:00:00.000Z'

/** Small deferred Promise used to hold a process-kill barrier in tests. */
type Deferred = {
  /** Promise settled by the explicit resolver. */
  readonly promise: Promise<void>
  /** Resolves the pending Promise once. */
  readonly resolve: () => void
}

/**
 * Creates one deterministic deferred Promise.
 *
 * @returns Promise and its explicit resolver.
 */
function createDeferred(): Deferred {
  let settle = (): void => {
    throw new Error('Deferred resolver was not initialized.')
  }
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve()
  })
  return { promise, resolve: settle }
}

/**
 * Creates one valid source-page fault plan.
 *
 * @param failpoint - Exact page failpoint under test.
 * @param source - Exact migration source role.
 * @param pageSequence - Positive successor page sequence.
 * @returns Valid non-production fault plan.
 */
function createSourcePlan(
  failpoint:
    WorkspaceSearchMigrationRehearsalPlanningPageFailpoint =
      'planning-page-artifact-uploaded-before-checkpoint-commit',
  source: 'documents' | 'work-items' = 'documents',
  pageSequence = 2,
): WorkspaceSearchMigrationRehearsalFaultPlan {
  return {
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    failpoint,
    target: {
      kind: 'source',
      source,
      pageSequence,
      cursorState: 'present',
    },
  }
}

/**
 * Creates one valid target-table page fault plan.
 *
 * @param failpoint - Exact page failpoint under test.
 * @param pageSequence - Positive successor page sequence.
 * @returns Valid non-production target-page plan.
 */
function createTargetPlan(
  failpoint:
    WorkspaceSearchMigrationRehearsalPlanningPageFailpoint =
      'planning-page-artifact-uploaded-before-checkpoint-commit',
  pageSequence = 3,
): WorkspaceSearchMigrationRehearsalFaultPlan {
  return {
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    failpoint,
    target: {
      kind: 'target',
      pageSequence,
      cursorState: 'present',
    },
  }
}

/**
 * Creates the unique valid planning-lease fault plan.
 *
 * @returns Valid non-production planning-lease plan.
 */
function createLeasePlan(): WorkspaceSearchMigrationRehearsalFaultPlan {
  return {
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    failpoint: 'lease-acquired-before-first-heartbeat',
    target: { kind: 'planning-lease' },
  }
}

/**
 * Creates one valid non-terminal apply-checkpoint fault plan.
 *
 * @param failpoint - Exact cursor boundary under test.
 * @returns Valid non-production apply-checkpoint plan.
 */
function createApplyCheckpointPlan(
  failpoint:
    WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint =
      'apply-checkpoint-cursor-captured-before-commit',
): WorkspaceSearchMigrationRehearsalFaultPlan {
  return {
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    failpoint,
    target: {
      kind: 'apply-checkpoint',
      location: 'documents',
      pageSequence: 2,
      cursorState: 'present',
    },
  }
}

/** Creates one valid strict partial-prefix apply interruption plan. */
function createApplyOperationPlan():
  WorkspaceSearchMigrationRehearsalFaultPlan {
  return {
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    failpoint: 'apply-operation-committed-before-return',
    target: {
      kind: 'apply-operation',
      planSequence: 1,
      remainingOperations: 'present',
    },
  }
}

/**
 * Creates one valid source-page reach event.
 *
 * @param failpoint - Exact page failpoint reached by the runtime.
 * @param source - Exact migration source role.
 * @param pageSequence - Positive successor page sequence.
 * @returns Valid semantic reach event.
 */
function createSourceReach(
  failpoint:
    WorkspaceSearchMigrationRehearsalPlanningPageFailpoint =
      'planning-page-artifact-uploaded-before-checkpoint-commit',
  source: 'documents' | 'work-items' = 'documents',
  pageSequence = 2,
): WorkspaceSearchMigrationRehearsalFaultReach {
  return {
    failpoint,
    target: {
      kind: 'source',
      source,
      pageSequence,
      cursorState: 'present',
    },
    reachedAt,
  }
}

/**
 * Creates one valid target-page reach event.
 *
 * @param failpoint - Exact page failpoint reached by the runtime.
 * @param pageSequence - Positive successor page sequence.
 * @returns Valid target-page reach event.
 */
function createTargetReach(
  failpoint:
    WorkspaceSearchMigrationRehearsalPlanningPageFailpoint =
      'planning-page-artifact-uploaded-before-checkpoint-commit',
  pageSequence = 2,
): WorkspaceSearchMigrationRehearsalFaultReach {
  return {
    failpoint,
    target: {
      kind: 'target',
      pageSequence,
      cursorState: 'present',
    },
    reachedAt,
  }
}

/**
 * Creates the unique valid planning-lease reach event.
 *
 * @returns Valid planning-lease reach event.
 */
function createLeaseReach(): WorkspaceSearchMigrationRehearsalFaultReach {
  return {
    failpoint: 'lease-acquired-before-first-heartbeat',
    target: { kind: 'planning-lease' },
    reachedAt,
  }
}

/**
 * Creates one valid non-terminal apply-checkpoint reach event.
 *
 * @param failpoint - Exact cursor boundary reached by apply.
 * @returns Valid semantic apply-checkpoint reach event.
 */
function createApplyCheckpointReach(
  failpoint:
    WorkspaceSearchMigrationRehearsalApplyCheckpointFailpoint =
      'apply-checkpoint-cursor-captured-before-commit',
): WorkspaceSearchMigrationRehearsalFaultReach {
  return {
    failpoint,
    target: {
      kind: 'apply-checkpoint',
      location: 'documents',
      pageSequence: 2,
      cursorState: 'present',
    },
    reachedAt,
  }
}

/**
 * Requires one synchronous operation to raise the expected stable code.
 *
 * @param operation - Operation expected to fail.
 * @param code - Stable expected error code.
 */
function expectRehearsalFaultError(
  operation: () => unknown,
  code: WorkspaceSearchMigrationRehearsalFaultErrorCode,
): void {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalFaultError,
    )
    if (!(error instanceof WorkspaceSearchMigrationRehearsalFaultError)) {
      throw error
    }
    expect(error.code).toBe(code)
    expect(error.message).toBe(code)
    return
  }
  throw new Error('Expected a migration rehearsal fault error.')
}

describe('Workspace Search migration rehearsal fault plan', () => {
  test('publishes exactly the six reviewed finite failpoints', () => {
    expect(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS).toEqual([
      'planning-page-artifact-uploaded-before-checkpoint-commit',
      'planning-page-transaction-response-lost',
      'apply-checkpoint-cursor-captured-before-commit',
      'apply-checkpoint-cursor-committed-before-return',
      'apply-operation-committed-before-return',
      'lease-acquired-before-first-heartbeat',
    ])
    expect(
      new Set(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS).size,
    ).toBe(6)
    expect(
      Object.isFrozen(WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS),
    ).toBe(true)
  })

  test('detaches and freezes source, target, and lease plan variants', () => {
    const mutableTarget = {
      kind: 'source',
      source: 'documents',
      pageSequence: 2,
      cursorState: 'present',
    }
    const mutablePlan = {
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      failpoint:
        'planning-page-artifact-uploaded-before-checkpoint-commit',
      target: mutableTarget,
    }
    const sourceSnapshot =
      snapshotWorkspaceSearchMigrationRehearsalFaultPlan(mutablePlan)
    mutableTarget.pageSequence = 99
    mutablePlan.failpoint =
      'planning-page-transaction-response-lost'

    expect(sourceSnapshot).toEqual(createSourcePlan())
    expect(Object.isFrozen(sourceSnapshot)).toBe(true)
    expect(Object.isFrozen(sourceSnapshot.target)).toBe(true)

    const targetSnapshot =
      snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
        createTargetPlan(),
      )
    expect(targetSnapshot).toEqual(createTargetPlan())
    expect(Object.isFrozen(targetSnapshot.target)).toBe(true)

    const leaseSnapshot =
      snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
        createLeasePlan(),
      )
    expect(leaseSnapshot).toEqual(createLeasePlan())
    expect(Object.isFrozen(leaseSnapshot.target)).toBe(true)

    const applyCheckpointSnapshot =
      snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
        createApplyCheckpointPlan(),
      )
    expect(applyCheckpointSnapshot).toEqual(
      createApplyCheckpointPlan(),
    )
    expect(Object.isFrozen(applyCheckpointSnapshot.target)).toBe(true)

    const applyOperationSnapshot =
      snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
        createApplyOperationPlan(),
      )
    expect(applyOperationSnapshot).toEqual(createApplyOperationPlan())
    expect(Object.isFrozen(applyOperationSnapshot.target)).toBe(true)
  })

  test('rejects non-production bypasses, mismatched targets, and extras', () => {
    const invalidPlans: readonly unknown[] = [
      {
        ...createSourcePlan(),
        stage: 'production',
      },
      {
        ...createSourcePlan(),
        approval: 'approve',
      },
      {
        ...createSourcePlan(),
        failpoint: 'unreviewed-fault',
      },
      {
        ...createSourcePlan(),
        target: { kind: 'planning-lease' },
      },
      {
        ...createLeasePlan(),
        target: createSourcePlan().target,
      },
      {
        ...createApplyCheckpointPlan(),
        target: {
          kind: 'apply-checkpoint',
          location: 'unknown-location',
          pageSequence: 2,
          cursorState: 'present',
        },
      },
      {
        ...createApplyOperationPlan(),
        target: {
          kind: 'apply-operation',
          planSequence: 1,
          remainingOperations: 'absent',
        },
      },
      {
        ...createSourcePlan(),
        target: {
          kind: 'source',
          source: 'unknown-source',
          pageSequence: 2,
          cursorState: 'present',
        },
      },
      {
        ...createSourcePlan(),
        target: {
          kind: 'source',
          source: 'documents',
          pageSequence: 0,
          cursorState: 'present',
        },
      },
      {
        ...createSourcePlan(),
        target: {
          kind: 'source',
          source: 'documents',
          pageSequence: 2,
          cursorState: 'absent',
        },
      },
      {
        ...createSourcePlan(),
        extra: 'must-not-be-ignored',
      },
    ]

    for (const candidate of invalidPlans) {
      expectRehearsalFaultError(
        () => snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
          candidate,
        ),
        'INVALID_PLAN',
      )
    }
  })

  test('rejects accessors and Proxies without invoking their traps', () => {
    let getterCalls = 0
    const accessorPlan = {
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      failpoint:
        'planning-page-artifact-uploaded-before-checkpoint-commit',
    }
    Object.defineProperty(accessorPlan, 'target', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return createSourcePlan().target
      },
    })
    expectRehearsalFaultError(
      () => snapshotWorkspaceSearchMigrationRehearsalFaultPlan(
        accessorPlan,
      ),
      'INVALID_PLAN',
    )
    expect(getterCalls).toBe(0)

    let ownKeysCalls = 0
    const targetProxy = new Proxy({}, {
      ownKeys: () => {
        ownKeysCalls += 1
        return []
      },
    })
    expectRehearsalFaultError(
      () => snapshotWorkspaceSearchMigrationRehearsalFaultPlan({
        ...createSourcePlan(),
        target: targetProxy,
      }),
      'INVALID_PLAN',
    )
    expect(ownKeysCalls).toBe(0)
  })
})

describe('Workspace Search migration rehearsal fault controller', () => {
  test('matches an exact apply checkpoint cursor boundary', async () => {
    const receipts: WorkspaceSearchMigrationRehearsalFaultReceipt[] = []
    const controller =
      createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createApplyCheckpointPlan(
          'apply-checkpoint-cursor-committed-before-return',
        ),
        waitAtBarrier: async (receipt) => {
          receipts.push(receipt)
        },
        reportResponseLoss: async () => undefined,
      })

    await expect(controller.reach(createApplyCheckpointReach()))
      .resolves.toBeUndefined()
    await expect(controller.reach(createApplyCheckpointReach(
      'apply-checkpoint-cursor-committed-before-return',
    ))).resolves.toMatchObject({
      action: 'barrier',
      target: {
        kind: 'apply-checkpoint',
        location: 'documents',
        pageSequence: 2,
        cursorState: 'present',
      },
    })
    expect(receipts).toHaveLength(1)
  })

  test('matches only an exact strict partial apply prefix', async () => {
    const receipts: WorkspaceSearchMigrationRehearsalFaultReceipt[] = []
    const controller =
      createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createApplyOperationPlan(),
        waitAtBarrier: async (receipt) => {
          receipts.push(receipt)
        },
        reportResponseLoss: async () => undefined,
      })

    await expect(controller.reach({
      failpoint: 'apply-operation-committed-before-return',
      target: {
        kind: 'apply-operation',
        planSequence: 2,
        remainingOperations: 'present',
      },
      reachedAt,
    })).resolves.toBeUndefined()
    await expect(controller.reach({
      failpoint: 'apply-operation-committed-before-return',
      target: createApplyOperationPlan().target,
      reachedAt,
    })).resolves.toMatchObject({ action: 'barrier' })
    expect(receipts).toHaveLength(1)
  })

  test('matches exact page semantics and emits only safe receipt fields', async () => {
    let barrierCalls = 0
    let responseLossCalls = 0
    let observedReceipt:
      WorkspaceSearchMigrationRehearsalFaultReceipt | undefined
    const controller =
      createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createSourcePlan(),
        waitAtBarrier: async (receipt) => {
          barrierCalls += 1
          observedReceipt = receipt
        },
        reportResponseLoss: async () => {
          responseLossCalls += 1
        },
      })

    expect(Object.isFrozen(controller)).toBe(true)
    expect(Reflect.ownKeys(controller)).toEqual([])
    expect(Object.isFrozen(Object.getPrototypeOf(controller))).toBe(true)
    expect(controller.readReceipt()).toBeUndefined()
    expectRehearsalFaultError(
      () => controller.requireReceipt(),
      'NOT_REACHED',
    )
    await expect(controller.reach(createSourceReach(
      'planning-page-transaction-response-lost',
    ))).resolves.toBeUndefined()
    await expect(controller.reach(createSourceReach(
      'planning-page-artifact-uploaded-before-checkpoint-commit',
      'work-items',
    ))).resolves.toBeUndefined()
    await expect(controller.reach(createSourceReach(
      'planning-page-artifact-uploaded-before-checkpoint-commit',
      'documents',
      3,
    ))).resolves.toBeUndefined()
    await expect(controller.reach(createTargetReach())).resolves
      .toBeUndefined()
    expect(barrierCalls).toBe(0)
    expect(responseLossCalls).toBe(0)

    const receipt = await controller.reach(createSourceReach())
    if (receipt === undefined) {
      throw new Error('Expected the exact semantic target to match.')
    }
    expect(receipt).toEqual({
      receiptVersion: 1,
      stage: 'non-production',
      failpoint:
        'planning-page-artifact-uploaded-before-checkpoint-commit',
      action: 'barrier',
      target: {
        kind: 'source',
        source: 'documents',
        pageSequence: 2,
        cursorState: 'present',
      },
      occurrence: 1,
      reachedAt,
    })
    expect(observedReceipt).toEqual(receipt)
    expect(barrierCalls).toBe(1)
    expect(responseLossCalls).toBe(0)
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.target)).toBe(true)
    expect(Object.keys(receipt).sort()).toEqual([
      'action',
      'failpoint',
      'occurrence',
      'reachedAt',
      'receiptVersion',
      'stage',
      'target',
    ])
    expect(JSON.stringify(receipt)).not.toContain('acknowledge-')
    expect(JSON.stringify(receipt)).not.toContain('account')
    expect(JSON.stringify(receipt)).not.toContain('tableName')
    expect(controller.requireReceipt()).toEqual(receipt)
    expect(controller.readReceipt()).not.toBe(receipt)
    expect(parseWorkspaceSearchMigrationRehearsalFaultReceipt(
      structuredClone(receipt),
    )).toEqual(receipt)
    expectRehearsalFaultError(
      () => parseWorkspaceSearchMigrationRehearsalFaultReceipt({
        ...receipt,
        action: 'response-loss',
      }),
      'INVALID_REACH',
    )
  })

  test('claims a barrier before awaiting it and rejects concurrent reuse', async () => {
    const entered = createDeferred()
    const release = createDeferred()
    let barrierCalls = 0
    const controller =
      createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createLeasePlan(),
        waitAtBarrier: async () => {
          barrierCalls += 1
          entered.resolve()
          await release.promise
        },
        reportResponseLoss: async () => undefined,
      })

    const firstReach = controller.reach(createLeaseReach())
    await entered.promise
    expect(controller.requireReceipt().target).toEqual({
      kind: 'planning-lease',
    })
    await expect(controller.reach(createLeaseReach())).rejects
      .toMatchObject({
        code: 'ALREADY_REACHED',
        message: 'ALREADY_REACHED',
      })
    expect(barrierCalls).toBe(1)

    release.resolve()
    await expect(firstReach).resolves.toMatchObject({
      failpoint: 'lease-acquired-before-first-heartbeat',
      action: 'barrier',
      occurrence: 1,
    })
  })

  test('reports transaction response loss before raising its stable error', async () => {
    let responseLossCalls = 0
    let observedReceipt:
      WorkspaceSearchMigrationRehearsalFaultReceipt | undefined
    const controller =
      createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createSourcePlan(
          'planning-page-transaction-response-lost',
        ),
        waitAtBarrier: async () => undefined,
        reportResponseLoss: async (receipt) => {
          responseLossCalls += 1
          observedReceipt = receipt
        },
      })

    await expect(controller.reach(createSourceReach(
      'planning-page-transaction-response-lost',
    ))).rejects.toMatchObject({
      code: 'TRANSACTION_RESPONSE_LOST',
      message: 'TRANSACTION_RESPONSE_LOST',
    })
    expect(responseLossCalls).toBe(1)
    expect(observedReceipt).toEqual(controller.requireReceipt())
    expect(controller.requireReceipt().action).toBe('response-loss')
    await expect(controller.reach(createSourceReach(
      'planning-page-transaction-response-lost',
    ))).rejects.toMatchObject({
      code: 'ALREADY_REACHED',
    })
  })

  test('normalizes callback rejection without reflecting its error', async () => {
    const restrictedCanary = 'restricted-callback-value'
    const controller =
      createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createTargetPlan(),
        waitAtBarrier: async () => {
          throw new Error(restrictedCanary)
        },
        reportResponseLoss: async () => undefined,
      })

    await expect(controller.reach(createTargetReach(
      'planning-page-artifact-uploaded-before-checkpoint-commit',
      3,
    ))).rejects.toMatchObject({
      code: 'CALLBACK_FAILED',
      message: 'CALLBACK_FAILED',
    })
    expect(controller.requireReceipt().action).toBe('barrier')
    expect(JSON.stringify(controller.requireReceipt()))
      .not.toContain(restrictedCanary)
  })

  test('rejects hostile reach shapes before invoking callbacks', async () => {
    let callbackCalls = 0
    const controller =
      createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createSourcePlan(),
        waitAtBarrier: async () => {
          callbackCalls += 1
        },
        reportResponseLoss: async () => {
          callbackCalls += 1
        },
      })

    await expect(controller.reach({
      ...createSourceReach(),
      reachedAt: '2026-08-02T09:00:00+09:00',
    })).rejects.toMatchObject({ code: 'INVALID_REACH' })
    await expect(controller.reach({
      ...createSourceReach(),
      extra: 'must-not-be-ignored',
    })).rejects.toMatchObject({ code: 'INVALID_REACH' })
    await expect(controller.reach({
      ...createSourceReach(),
      target: {
        kind: 'source',
        source: 'documents',
        pageSequence: 2,
        cursorState: 'absent',
      },
    })).rejects.toMatchObject({ code: 'INVALID_REACH' })

    let getterCalls = 0
    const accessorReach = {
      failpoint:
        'planning-page-artifact-uploaded-before-checkpoint-commit',
      reachedAt,
    }
    Object.defineProperty(accessorReach, 'target', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return createSourceReach().target
      },
    })
    await expect(controller.reach(accessorReach)).rejects
      .toMatchObject({ code: 'INVALID_REACH' })
    expect(getterCalls).toBe(0)

    let ownKeysCalls = 0
    const targetProxy = new Proxy({}, {
      ownKeys: () => {
        ownKeysCalls += 1
        return []
      },
    })
    await expect(controller.reach({
      ...createSourceReach(),
      target: targetProxy,
    })).rejects.toMatchObject({ code: 'INVALID_REACH' })
    expect(ownKeysCalls).toBe(0)
    expect(callbackCalls).toBe(0)
    expect(controller.readReceipt()).toBeUndefined()
  })

  test('rejects proxied callbacks at construction', () => {
    const proxiedCallback = new Proxy(async () => undefined, {})
    expectRehearsalFaultError(
      () => createWorkspaceSearchMigrationRehearsalFaultController({
        plan: createLeasePlan(),
        waitAtBarrier: proxiedCallback,
        reportResponseLoss: async () => undefined,
      }),
      'INVALID_CONTROLLER',
    )
  })
})
