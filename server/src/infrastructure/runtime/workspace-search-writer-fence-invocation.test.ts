import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  createWorkspaceSearchWriterFenceReleasedOpenSuccessor,
  createWorkspaceSearchWriterFenceStateIncarnationDigest,
  encodeWorkspaceSearchWriterFenceRecord,
  parseWorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceGuardMaterial,
  type WorkspaceSearchWriterFenceReleaseBinding,
  type WorkspaceSearchWriterFenceStateIdentity,
} from './workspace-search-writer-fence'
import {
  createWorkspaceSearchWriterFenceGuardProvider,
  runWithWorkspaceSearchWriterFenceInvocation,
  WorkspaceSearchWriterFenceInvocationScopeError,
  WorkspaceSearchWriterFenceInvocationSourceMismatchError,
} from './workspace-search-writer-fence-invocation'

/**
 * Creates deterministic open-row guard material for invocation tests.
 *
 * @param suffix - Fixture identity suffix.
 * @returns Exact valid guard material.
 */
function createGuardFixture(
  suffix = 'primary',
): WorkspaceSearchWriterFenceGuardMaterial {
  const stateTableId = `migration-state-${suffix}`
  const stateTableIdentity: WorkspaceSearchWriterFenceStateIdentity = {
    role: 'migration-state',
    tableName: 'WorkspaceSearchMigrationState',
    tableArn:
      'arn:aws:dynamodb:ap-northeast-1:123456789012:table/WorkspaceSearchMigrationState',
    tableId: stateTableId,
    creationTime: '2026-07-29T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
  }
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTableIdentity.tableName,
    stateTableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        stateTableIdentity,
      ),
    tableIds: {
      'project-directory': `project-directory-${suffix}`,
      'work-items': `work-items-${suffix}`,
      collaboration: `collaboration-${suffix}`,
      documents: `documents-${suffix}`,
      'workspace-search': `workspace-search-${suffix}`,
      'migration-state': stateTableId,
    },
  })
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const observation = parseWorkspaceSearchWriterFenceObservation(
    encodeWorkspaceSearchWriterFenceRecord(open),
    binding,
  )
  return createWorkspaceSearchWriterFenceGuardMaterial(
    observation,
    binding,
    stateTableIdentity,
  )
}

/**
 * Exact old and released guard pair sharing one durable fence binding.
 */
type WorkspaceSearchWriterFenceReleaseInvocationFixture = {
  /** Guard acquired from the initial version-one open row. */
  readonly initial: WorkspaceSearchWriterFenceGuardMaterial
  /** Guard acquired from its released version-two open successor. */
  readonly released: WorkspaceSearchWriterFenceGuardMaterial
}

/**
 * Creates one initial-open, closed, and released-open invocation fixture.
 *
 * @returns Exact guards before close and after terminal release.
 */
function createReleaseInvocationFixture():
  WorkspaceSearchWriterFenceReleaseInvocationFixture {
  const stateTableIdentity: WorkspaceSearchWriterFenceStateIdentity = {
    role: 'migration-state',
    tableName: 'WorkspaceSearchMigrationState',
    tableArn:
      'arn:aws:dynamodb:ap-northeast-1:123456789012:table/WorkspaceSearchMigrationState',
    tableId: 'migration-state-release-invocation',
    creationTime: '2026-07-29T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
  }
  const configurationHash = createHash('sha256')
    .update('invocation-release-configuration')
    .digest('hex')
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: stateTableIdentity.tableName,
    stateTableId: stateTableIdentity.tableId,
    stateIncarnationDigest:
      createWorkspaceSearchWriterFenceStateIncarnationDigest(
        stateTableIdentity,
      ),
    tableIds: {
      'project-directory': 'project-directory-release-invocation',
      'work-items': 'work-items-release-invocation',
      collaboration: 'collaboration-release-invocation',
      documents: 'documents-release-invocation',
      'workspace-search': 'workspace-search-release-invocation',
      'migration-state': stateTableIdentity.tableId,
    },
  })
  const initialOpen = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:00:00.000Z'),
  )
  const closed = createWorkspaceSearchWriterFenceClosedSuccessor(
    initialOpen,
    {
      configurationHash,
      runId: 'invocation-release-run',
      ownerId: 'invocation-release-owner',
      leaseFenceToken: 5,
      maintenanceEvidenceReceiptDigest: createHash('sha256')
        .update('invocation-release-maintenance-receipt')
        .digest('hex'),
      maintenanceEvidencePointerRevision: 3,
    },
    new Date('2026-07-29T00:05:00.000Z'),
  )
  const release: WorkspaceSearchWriterFenceReleaseBinding = {
    releaseVersion: 1,
    configurationHash,
    runId: 'invocation-release-run',
    executionBoundaryDigest: createHash('sha256')
      .update('invocation-release-execution-boundary')
      .digest('hex'),
    sealedPlanningAuthorityDigest: createHash('sha256')
      .update('invocation-release-sealed-planning-authority')
      .digest('hex'),
    executionRunDigest: createHash('sha256')
      .update('invocation-release-execution-run')
      .digest('hex'),
    terminal: {
      kind: 'verified',
      persistenceVersion: 1,
      rootDigest: createHash('sha256')
        .update('invocation-release-verified-root')
        .digest('hex'),
    },
  }
  const releasedOpen = createWorkspaceSearchWriterFenceReleasedOpenSuccessor(
    closed,
    release,
    new Date('2026-07-29T00:10:00.000Z'),
  )
  return {
    initial: createWorkspaceSearchWriterFenceGuardMaterial(
      parseWorkspaceSearchWriterFenceObservation(
        encodeWorkspaceSearchWriterFenceRecord(initialOpen),
        binding,
      ),
      binding,
      stateTableIdentity,
    ),
    released: createWorkspaceSearchWriterFenceGuardMaterial(
      parseWorkspaceSearchWriterFenceObservation(
        encodeWorkspaceSearchWriterFenceRecord(releasedOpen),
        binding,
      ),
      binding,
      stateTableIdentity,
    ),
  }
}

test('requires an explicit application invocation scope', async () => {
  const provider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      return createGuardFixture()
    },
  })

  await expect(provider.get()).rejects.toBeInstanceOf(
    WorkspaceSearchWriterFenceInvocationScopeError,
  )
})

test('retains one fulfilled acquisition promise within an invocation', async () => {
  let acquisitionCount = 0
  const material = createGuardFixture()
  const provider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      acquisitionCount += 1
      await Promise.resolve()
      return material
    },
  })

  await runWithWorkspaceSearchWriterFenceInvocation(async () => {
    const first = provider.get()
    const second = provider.get()

    expect(second).toBe(first)
    const acquired = await first
    expect(acquired).toEqual(material)
    expect(await provider.get()).toBe(acquired)
    expect(Object.isFrozen(acquired)).toBe(true)
    expect(Object.isFrozen(acquired.conditionCheck)).toBe(true)
    expect(Reflect.set(acquired, 'writerEpoch', 9)).toBe(false)
  })

  expect(acquisitionCount).toBe(1)
})

test('retains the first rejection and never refreshes in one invocation', async () => {
  let acquisitionCount = 0
  const failure = new Error('fixture acquisition failure')
  const provider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      acquisitionCount += 1
      throw failure
    },
  })

  await runWithWorkspaceSearchWriterFenceInvocation(async () => {
    const first = provider.get()
    await expect(first).rejects.toBe(failure)
    const repeated = provider.get()
    expect(repeated).toBe(first)
    await expect(repeated).rejects.toBe(failure)
  })

  expect(acquisitionCount).toBe(1)
})

test('retains pre-release tokens and closed failures while new invocations acquire epoch three', async () => {
  const fixture = createReleaseInvocationFixture()
  const closedFailure = new Error('fixture closed writer fence')
  let current: WorkspaceSearchWriterFenceGuardMaterial | Error =
    fixture.initial
  let acquisitionCount = 0
  const provider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      acquisitionCount += 1
      if (current instanceof Error) throw current
      return current
    },
  })

  await runWithWorkspaceSearchWriterFenceInvocation(async () => {
    const initial = await provider.get()
    current = fixture.released

    const retained = await provider.get()

    expect(retained).toBe(initial)
    expect(retained.writerEpoch).toBe(1)
    expect(retained.controlRevision).toBe(1)
  })

  current = closedFailure
  await runWithWorkspaceSearchWriterFenceInvocation(async () => {
    const first = provider.get()
    await expect(first).rejects.toBe(closedFailure)
    current = fixture.released

    const retained = provider.get()

    expect(retained).toBe(first)
    await expect(retained).rejects.toBe(closedFailure)
  })

  const released = await runWithWorkspaceSearchWriterFenceInvocation(
    () => provider.get(),
  )
  const initialCondition =
    fixture.initial.conditionCheck.ConditionCheck
  const releasedCondition =
    released.conditionCheck.ConditionCheck
  const initialCanonicalBytes =
    initialCondition?.ExpressionAttributeValues?.[':canonicalBytes']?.S
  const releasedCanonicalBytes =
    releasedCondition?.ExpressionAttributeValues?.[':canonicalBytes']?.S
  const initialRecordDigest =
    initialCondition?.ExpressionAttributeValues?.[':recordDigest']?.S
  const releasedRecordDigest =
    releasedCondition?.ExpressionAttributeValues?.[':recordDigest']?.S

  expect(released).toEqual(fixture.released)
  expect(released.writerEpoch).toBe(3)
  expect(released.controlRevision).toBe(3)
  expect(released.materialFingerprint).not.toBe(
    fixture.initial.materialFingerprint,
  )
  expect(releasedCanonicalBytes).not.toBe(initialCanonicalBytes)
  expect(releasedRecordDigest).not.toBe(initialRecordDigest)
  expect(acquisitionCount).toBe(3)
})

test('acquires independently for separate and concurrent invocations', async () => {
  let acquisitionCount = 0
  const provider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      acquisitionCount += 1
      return createGuardFixture(`invocation-${acquisitionCount}`)
    },
  })

  const [first, second] = await Promise.all([
    runWithWorkspaceSearchWriterFenceInvocation(() => provider.get()),
    runWithWorkspaceSearchWriterFenceInvocation(() => provider.get()),
  ])
  const third = await runWithWorkspaceSearchWriterFenceInvocation(
    () => provider.get(),
  )

  expect(acquisitionCount).toBe(3)
  expect(new Set([
    first.materialFingerprint,
    second.materialFingerprint,
    third.materialFingerprint,
  ]).size).toBe(3)
})

test('shares the first acquisition across providers using one source', async () => {
  let firstCount = 0
  const source = {
    async acquire() {
      firstCount += 1
      return createGuardFixture('first-provider')
    },
  }
  const firstProvider = createWorkspaceSearchWriterFenceGuardProvider(source)
  const secondProvider = createWorkspaceSearchWriterFenceGuardProvider(source)

  await runWithWorkspaceSearchWriterFenceInvocation(async () => {
    const [first, repeatedFirst, second] = await Promise.all([
      firstProvider.get(),
      firstProvider.get(),
      secondProvider.get(),
    ])

    expect(repeatedFirst).toBe(first)
    expect(second).toBe(first)
  })

  expect(firstCount).toBe(1)
})

test('fails closed when one invocation mixes distinct guard sources', async () => {
  let firstCount = 0
  let secondCount = 0
  const firstProvider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      firstCount += 1
      return createGuardFixture('first-provider')
    },
  })
  const secondProvider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      secondCount += 1
      return createGuardFixture('second-provider')
    },
  })

  await runWithWorkspaceSearchWriterFenceInvocation(async () => {
    const first = firstProvider.get()
    await expect(secondProvider.get()).rejects.toBeInstanceOf(
      WorkspaceSearchWriterFenceInvocationSourceMismatchError,
    )
    await first
  })

  expect(firstCount).toBe(1)
  expect(secondCount).toBe(0)
})

test('keeps nested invocation boundaries on the original acquisition', async () => {
  let acquisitionCount = 0
  const provider = createWorkspaceSearchWriterFenceGuardProvider({
    async acquire() {
      acquisitionCount += 1
      return createGuardFixture(`nested-${acquisitionCount}`)
    },
  })

  await runWithWorkspaceSearchWriterFenceInvocation(async () => {
    const first = await provider.get()
    const nested = await runWithWorkspaceSearchWriterFenceInvocation(
      () => provider.get(),
    )

    expect(nested).toBe(first)
  })

  expect(acquisitionCount).toBe(1)
})
