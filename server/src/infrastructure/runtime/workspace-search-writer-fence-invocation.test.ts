import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceGuardMaterial,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
  encodeWorkspaceSearchWriterFenceRecord,
  parseWorkspaceSearchWriterFenceObservation,
  type WorkspaceSearchWriterFenceGuardMaterial,
} from './workspace-search-writer-fence'
import {
  createWorkspaceSearchWriterFenceGuardProvider,
  runWithWorkspaceSearchWriterFenceInvocation,
  WorkspaceSearchWriterFenceInvocationScopeError,
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
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: 'WorkspaceSearchMigrationState',
    stateTableId,
    stateIncarnationDigest: createHash('sha256')
      .update(`state-${suffix}`)
      .digest('hex'),
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
  )
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

test('shares the first acquisition across providers in one invocation', async () => {
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
    const [first, repeatedFirst, second] = await Promise.all([
      firstProvider.get(),
      firstProvider.get(),
      secondProvider.get(),
    ])

    expect(repeatedFirst).toBe(first)
    expect(second).toBe(first)
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
