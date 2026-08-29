import { expect, test } from 'bun:test'
import {
  createMutationHeaders,
  createMutationFingerprint,
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../src/shared/api/mutationHeaders'

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

test('hashes secret mutation inputs without retaining their plaintext', async () => {
  const first = await createMutationFingerprint(
    'invitee@example.com',
    'challenge-session-1',
    'replacement-password-1',
  )
  const changedPassword = await createMutationFingerprint(
    'invitee@example.com',
    'challenge-session-1',
    'replacement-password-2',
  )
  const changedSession = await createMutationFingerprint(
    'invitee@example.com',
    'challenge-session-2',
    'replacement-password-1',
  )

  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(first).not.toContain('replacement-password')
  expect(changedPassword).not.toBe(first)
  expect(changedSession).not.toBe(first)
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

test('discards a context after a caller-classified HTTP response error', async () => {
  const contexts: MutationRequestContext[] = [
    { correlationId: 'correlation-1', idempotencyKey: 'request-1' },
    { correlationId: 'correlation-2', idempotencyKey: 'request-2' },
  ]
  let contextIndex = 0
  const runner = createMutationRequestRunner(() => contexts[contextIndex++]!)
  const observedContexts: MutationRequestContext[] = []

  await expect(runner.run(
    'workspace-invitation:resend:invitee@example.com',
    'same-input',
    async (context) => {
      observedContexts.push(context)
      throw new Error('confirmed HTTP error')
    },
    () => false,
  )).rejects.toThrow('confirmed HTTP error')
  await runner.run(
    'workspace-invitation:resend:invitee@example.com',
    'same-input',
    async (context) => {
      observedContexts.push(context)
    },
  )

  expect(observedContexts).toEqual(contexts)
})

test('discards a retained context after external state recovery', async () => {
  const contexts: MutationRequestContext[] = [
    { correlationId: 'correlation-1', idempotencyKey: 'request-1' },
    { correlationId: 'correlation-2', idempotencyKey: 'request-2' },
  ]
  let contextIndex = 0
  const runner = createMutationRequestRunner(() => contexts[contextIndex++]!)
  const observedContexts: MutationRequestContext[] = []

  await expect(runner.run('workspace-invitation:create', 'same-input', async (context) => {
    observedContexts.push(context)
    throw new Error('network error')
  })).rejects.toThrow('network error')

  runner.discardRetainedContexts()
  await runner.run('workspace-invitation:create', 'same-input', async (context) => {
    observedContexts.push(context)
  })

  expect(observedContexts).toEqual(contexts)
})

test('does not discard an in-flight context during external state recovery', async () => {
  const context: MutationRequestContext = {
    correlationId: 'correlation-1',
    idempotencyKey: 'request-1',
  }
  const runner = createMutationRequestRunner(() => context)
  let resolveRequest: ((result: string) => void) | undefined
  const request = async () => new Promise<string>((resolve) => {
    resolveRequest = resolve
  })

  const firstResult = runner.run('workspace-member:update:member-1', 'same-input', request)
  await Promise.resolve()
  runner.discardRetainedContexts()
  const secondResult = runner.run('workspace-member:update:member-1', 'same-input', request)

  expect(secondResult).toBe(firstResult)
  resolveRequest?.('updated')
  expect(await Promise.all([firstResult, secondResult])).toEqual(['updated', 'updated'])
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

test('reuses one AI generation header context after cancel without retaining raw input', async () => {
  const context: MutationRequestContext = {
    correlationId: 'ai-correlation-1',
    idempotencyKey: 'ai-request-1',
  }
  const runner = createMutationRequestRunner(() => context)
  const accessToken = 'SECRET_AI_ACCESS_TOKEN'
  const query = 'SECRET_PLAIN_LANGUAGE_QUERY'
  const fingerprint = await createMutationFingerprint(
    accessToken,
    JSON.stringify({ locale: 'en', query, task: 'search' }),
  )
  const observedHeaders: ReturnType<typeof createMutationHeaders>[] = []

  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(fingerprint).not.toContain(accessToken)
  expect(fingerprint).not.toContain(query)

  await expect(runner.run(
    'ai-assistance:generate',
    fingerprint,
    async (requestContext) => {
      observedHeaders.push(createMutationHeaders(requestContext))
      throw new DOMException('Cancelled by operator', 'AbortError')
    },
  )).rejects.toMatchObject({ name: 'AbortError' })

  await runner.run('ai-assistance:generate', fingerprint, async (requestContext) => {
    observedHeaders.push(createMutationHeaders(requestContext))
  })

  expect(observedHeaders).toHaveLength(2)
  expect(observedHeaders[1]).toEqual(observedHeaders[0])
})
