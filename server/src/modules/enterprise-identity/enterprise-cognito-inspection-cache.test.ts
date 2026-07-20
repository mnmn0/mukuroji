import { expect, test } from 'bun:test'
import { createEnterpriseCognitoInspectionCache } from './enterprise-cognito-inspection-cache'

test('shares concurrent Cognito inspection reads and reuses successful raw bindings for 30 seconds', async () => {
  let currentTime = 1_000
  let loads = 0
  let resolveLoad: ((value: { revision: number }) => void) | undefined
  const cache = createEnterpriseCognitoInspectionCache<{ revision: number }>({
    now: () => currentTime,
  })
  const load = () => {
    loads += 1
    return new Promise<{ revision: number }>((resolve) => {
      resolveLoad = resolve
    })
  }

  const first = cache.read('pool-1\0provider-1', load)
  const second = cache.read('pool-1\0provider-1', load)
  await Promise.resolve()
  expect(loads).toBe(1)
  resolveLoad?.({ revision: 1 })
  expect(await Promise.all([first, second])).toEqual([
    { revision: 1 },
    { revision: 1 },
  ])

  currentTime += 29_999
  expect(await cache.read('pool-1\0provider-1', async () => {
    loads += 1
    return { revision: 2 }
  })).toEqual({ revision: 1 })
  expect(loads).toBe(1)

  currentTime += 1
  expect(await cache.read('pool-1\0provider-1', async () => {
    loads += 1
    return { revision: 2 }
  })).toEqual({ revision: 2 })
  expect(loads).toBe(2)
})

test('keeps a slow pending inspection single-flight and starts TTL when it resolves', async () => {
  let currentTime = 0
  let loads = 0
  let resolveLoad: ((value: string) => void) | undefined
  const cache = createEnterpriseCognitoInspectionCache<string>({
    now: () => currentTime,
  })
  const load = () => {
    loads += 1
    return new Promise<string>((resolve) => {
      resolveLoad = resolve
    })
  }

  const first = cache.read('provider', load)
  await Promise.resolve()
  currentTime = 30_000
  const second = cache.read('provider', load)
  await Promise.resolve()
  expect(loads).toBe(1)

  resolveLoad?.('binding')
  expect(await Promise.all([first, second])).toEqual(['binding', 'binding'])
  currentTime = 59_999
  expect(await cache.read('provider', async () => {
    loads += 1
    return 'replacement'
  })).toBe('binding')
  currentTime = 60_000
  expect(await cache.read('provider', async () => {
    loads += 1
    return 'replacement'
  })).toBe('replacement')
  expect(loads).toBe(2)
})

test('does not serve stale Cognito bindings or retain failed refreshes', async () => {
  let currentTime = 0
  let loads = 0
  const cache = createEnterpriseCognitoInspectionCache<string>({
    now: () => currentTime,
  })

  expect(await cache.read('provider', async () => {
    loads += 1
    return 'initial-binding'
  })).toBe('initial-binding')

  currentTime = 30_000
  await expect(cache.read('provider', async () => {
    loads += 1
    throw new Error('Cognito unavailable')
  })).rejects.toThrow('Cognito unavailable')
  expect(loads).toBe(2)

  expect(await cache.read('provider', async () => {
    loads += 1
    return 'recovered-binding'
  })).toBe('recovered-binding')
  expect(loads).toBe(3)
})

test('forces a live Cognito inspection and replaces an existing cached binding', async () => {
  let loads = 0
  const cache = createEnterpriseCognitoInspectionCache<string>({
    now: () => 0,
  })
  const load = async () => {
    loads += 1
    return `binding-${loads}`
  }

  expect(await cache.read('provider', load)).toBe('binding-1')
  expect(await cache.read('provider', load)).toBe('binding-1')
  expect(await cache.refresh('provider', load)).toBe('binding-2')
  expect(await cache.read('provider', load)).toBe('binding-2')
  cache.clear()
  expect(await cache.read('provider', load)).toBe('binding-3')
  expect(loads).toBe(3)
})

test('bounds Cognito inspection entries and keeps recently used keys', async () => {
  let loads = 0
  const cache = createEnterpriseCognitoInspectionCache<string>({
    maxEntries: 2,
    now: () => 0,
  })
  const read = (key: string) => cache.read(key, async () => {
    loads += 1
    return `${key}-${loads}`
  })

  expect(await read('provider-a')).toBe('provider-a-1')
  expect(await read('provider-b')).toBe('provider-b-2')
  expect(await read('provider-a')).toBe('provider-a-1')
  expect(await read('provider-c')).toBe('provider-c-3')
  expect(await read('provider-b')).toBe('provider-b-4')
  expect(loads).toBe(4)
})

test('keeps tracked pending loads bounded and does not evict their single-flight entries', async () => {
  let loads = 0
  const resolvers: Array<(value: string) => void> = []
  const cache = createEnterpriseCognitoInspectionCache<string>({
    maxEntries: 2,
    now: () => 0,
  })
  const read = (key: string) => cache.read(key, () => {
    loads += 1
    return new Promise<string>((resolve) => {
      resolvers.push(resolve)
    })
  })

  const firstA = read('provider-a')
  const firstB = read('provider-b')
  await Promise.resolve()
  expect(loads).toBe(2)

  const secondA = read('provider-a')
  const firstC = read('provider-c')
  const secondC = read('provider-c')
  await Promise.resolve()
  expect(loads).toBe(4)

  resolvers.forEach((resolve, index) => resolve(`binding-${index}`))
  expect(await Promise.all([firstA, secondA])).toEqual([
    'binding-0',
    'binding-0',
  ])
  expect(await firstB).toBe('binding-1')
  expect(await Promise.all([firstC, secondC])).toEqual([
    'binding-2',
    'binding-3',
  ])
})
