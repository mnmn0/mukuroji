import { expect, test } from 'bun:test'
import {
  RuntimeControlBlockedError,
  createStaticRuntimeControlProvider,
} from '../infrastructure/runtime/runtime-control'
import {
  createAuditProjectionEntrypoint,
} from './audit-projection-handler'

test('blocks Audit fan-out before constructing downstream projections', async () => {
  let fanOutConstructionCount = 0
  let downstreamInvocationCount = 0
  const handler = createAuditProjectionEntrypoint(
    async () => {
      fanOutConstructionCount += 1
      return async () => {
        downstreamInvocationCount += 1
        return { batchItemFailures: [] }
      }
    },
    {
      provider: createStaticRuntimeControlProvider('disabled', 2),
      recordObservation: () => undefined,
    },
  )

  await expect(handler({ Records: [] }))
    .rejects.toBeInstanceOf(RuntimeControlBlockedError)
  expect(fanOutConstructionCount).toBe(0)
  expect(downstreamInvocationCount).toBe(0)
})

test('delegates one admitted Audit batch through the lazy fan-out', async () => {
  let fanOutConstructionCount = 0
  let downstreamInvocationCount = 0
  const handler = createAuditProjectionEntrypoint(
    async () => {
      fanOutConstructionCount += 1
      return async () => {
        downstreamInvocationCount += 1
        return { batchItemFailures: [] }
      }
    },
    {
      provider: createStaticRuntimeControlProvider('enabled', 3),
      recordObservation: () => undefined,
    },
  )

  await expect(handler({ Records: [] })).resolves.toEqual({
    batchItemFailures: [],
  })
  expect(fanOutConstructionCount).toBe(1)
  expect(downstreamInvocationCount).toBe(1)
})

test('single-flights concurrent admitted Audit fan-out construction', async () => {
  let markConstructionStarted: (() => void) | undefined
  const constructionStarted = new Promise<void>((resolve) => {
    markConstructionStarted = resolve
  })
  let releaseConstruction: (() => void) | undefined
  const constructionGate = new Promise<void>((resolve) => {
    releaseConstruction = resolve
  })
  let fanOutConstructionCount = 0
  let downstreamInvocationCount = 0
  const handler = createAuditProjectionEntrypoint(
    async () => {
      fanOutConstructionCount += 1
      markConstructionStarted?.()
      await constructionGate
      return async () => {
        downstreamInvocationCount += 1
        return { batchItemFailures: [] }
      }
    },
    {
      provider: createStaticRuntimeControlProvider('enabled', 4),
      recordObservation: () => undefined,
    },
  )

  const first = handler({ Records: [] })
  await constructionStarted
  const second = handler({ Records: [] })
  expect(fanOutConstructionCount).toBe(1)
  if (!releaseConstruction) {
    throw new Error('Audit fan-out construction did not start.')
  }
  releaseConstruction()
  await expect(Promise.all([first, second])).resolves.toEqual([
    { batchItemFailures: [] },
    { batchItemFailures: [] },
  ])
  expect(fanOutConstructionCount).toBe(1)
  expect(downstreamInvocationCount).toBe(2)
})

test('retries Audit fan-out construction after an initialization failure', async () => {
  let fanOutConstructionCount = 0
  const handler = createAuditProjectionEntrypoint(
    async () => {
      fanOutConstructionCount += 1
      if (fanOutConstructionCount === 1) {
        throw new Error('Test initialization failure.')
      }
      return async () => ({ batchItemFailures: [] })
    },
    {
      provider: createStaticRuntimeControlProvider('enabled', 5),
      recordObservation: () => undefined,
    },
  )

  await expect(handler({ Records: [] }))
    .rejects.toThrow('Test initialization failure.')
  await expect(handler({ Records: [] })).resolves.toEqual({
    batchItemFailures: [],
  })
  expect(fanOutConstructionCount).toBe(2)
})
