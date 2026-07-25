import { expect, test } from 'bun:test'
import { createLazySingleton } from './lazy-singleton'

test('constructs one value after the first successful request', () => {
  let calls = 0
  const getValue = createLazySingleton(() => {
    calls += 1
    return { calls }
  })

  const first = getValue()
  expect(getValue()).toBe(first)
  expect(calls).toBe(1)
})

test('retries construction after a synchronous factory failure', () => {
  let calls = 0
  const getValue = createLazySingleton(() => {
    calls += 1
    if (calls === 1) throw new Error('transient construction failure')
    return 'ready'
  })

  expect(() => getValue()).toThrow('transient construction failure')
  expect(getValue()).toBe('ready')
  expect(getValue()).toBe('ready')
  expect(calls).toBe(2)
})
