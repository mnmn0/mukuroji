import { expect, test } from 'bun:test'
import {
  createMutationHeaders,
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../src/api/mutationHeaders'

test('creates stable headers from one explicit mutation context', () => {
  const context: MutationRequestContext = {
    correlationId: 'correlation-1',
    idempotencyKey: 'request-1',
  }

  expect(createMutationHeaders(context)).toEqual({
    'Idempotency-Key': 'request-1',
    'X-Correlation-Id': 'correlation-1',
  })
  expect(createMutationHeaders(context)).toEqual(createMutationHeaders(context))
})

test('retains a context only while the HTTP mutation rejects and clears it on resolve', async () => {
  const contexts: MutationRequestContext[] = [
    { correlationId: 'correlation-1', idempotencyKey: 'request-1' },
    { correlationId: 'correlation-2', idempotencyKey: 'request-2' },
  ]
  let contextIndex = 0
  const runner = createMutationRequestRunner(() => {
    const context = contexts[contextIndex]

    if (!context) {
      throw new Error('Unexpected request context allocation')
    }

    contextIndex += 1
    return context
  })
  const observedContexts: MutationRequestContext[] = []

  await expect(runner.run('team:create', 'same-input', async (context) => {
    observedContexts.push(context)
    throw new Error('network error')
  })).rejects.toThrow('network error')

  await runner.run('team:create', 'same-input', async (context) => {
    observedContexts.push(context)
  })
  await runner.run('team:create', 'same-input', async (context) => {
    observedContexts.push(context)
  })

  expect(observedContexts).toEqual([contexts[0], contexts[0], contexts[1]])
})

test('allocates a new context when the logical mutation input changes', async () => {
  const contexts: MutationRequestContext[] = [
    { correlationId: 'correlation-1', idempotencyKey: 'request-1' },
    { correlationId: 'correlation-2', idempotencyKey: 'request-2' },
  ]
  let contextIndex = 0
  const runner = createMutationRequestRunner(() => contexts[contextIndex++]!)
  const observedContexts: MutationRequestContext[] = []

  await expect(runner.run('issue:update', 'status:todo', async (context) => {
    observedContexts.push(context)
    throw new Error('network error')
  })).rejects.toThrow('network error')
  await runner.run('issue:update', 'status:done', async (context) => {
    observedContexts.push(context)
  })

  expect(observedContexts).toEqual(contexts)
})

test('shares one in-flight request for concurrent calls to the same logical mutation', async () => {
  const context: MutationRequestContext = {
    correlationId: 'correlation-1',
    idempotencyKey: 'request-1',
  }
  const runner = createMutationRequestRunner(() => context)
  let requestCount = 0
  let resolveRequest: ((result: string) => void) | undefined
  const request = async (observedContext: MutationRequestContext) => {
    requestCount += 1
    expect(observedContext).toBe(context)

    return new Promise<string>((resolve) => {
      resolveRequest = resolve
    })
  }

  const firstResult = runner.run('issue:comment:team-1:issue-1', 'same-body', request)
  const secondResult = runner.run('issue:comment:team-1:issue-1', 'same-body', request)

  expect(secondResult).toBe(firstResult)
  await Promise.resolve()
  expect(requestCount).toBe(1)
  resolveRequest?.('created')

  expect(await Promise.all([firstResult, secondResult])).toEqual(['created', 'created'])
  expect(requestCount).toBe(1)
})
