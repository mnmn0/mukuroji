import { describe, expect, test } from 'bun:test'
import type { ComponentType } from 'react'
import { loadPageWithReload, type PageReloadEnvironment } from '../src/app/staleChunkReload'

/** Page component returned by successful loads. */
const Page: ComponentType = () => null

/**
 * Builds an in-memory environment that counts reloads.
 *
 * @returns The environment, its stored values, and a reload counter.
 */
function createEnvironment() {
  const values = new Map<string, string>()
  const state = { reloads: 0 }
  const environment: PageReloadEnvironment = {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => { values.delete(key) },
      setItem: (key, value) => { values.set(key, value) },
    },
    reload: () => { state.reloads += 1 },
  }
  return { environment, state, values }
}

/**
 * Waits for pending promise callbacks so a load that is not going to settle has had its chance.
 *
 * @returns Resolves after the next macrotask.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('loadPageWithReload', () => {
  test('reloads once when a page fails to load, and leaves the next failure to the route', async () => {
    const { environment, state } = createEnvironment()
    const failure = new Error('Failed to fetch dynamically imported module')
    let settled = false
    void loadPageWithReload(() => Promise.reject(failure), environment).finally(() => { settled = true })
    await flush()
    expect(state.reloads).toBe(1)
    // The page stays pending while the browser reloads.
    expect(settled).toBe(false)

    // After the reload the same load fails again, however long it took.
    await expect(loadPageWithReload(() => Promise.reject(failure), environment)).rejects.toBe(failure)
    expect(state.reloads).toBe(1)
  })

  test('clears the attempt once a page loads, so a later deploy can recover again', async () => {
    const { environment, state, values } = createEnvironment()
    void loadPageWithReload(() => Promise.reject(new Error('stale')), environment)
    await flush()
    expect(await loadPageWithReload(() => Promise.resolve(Page), environment)).toBe(Page)
    expect(values.size).toBe(0)

    void loadPageWithReload(() => Promise.reject(new Error('stale again')), environment)
    await flush()
    expect(state.reloads).toBe(2)
  })

  test('does not reload without session storage, since nothing would stop a loop', async () => {
    const { environment, state } = createEnvironment()
    const failure = new Error('stale')
    const blocked: PageReloadEnvironment = {
      ...environment,
      storage: {
        ...environment.storage,
        getItem: () => { throw new Error('SecurityError') },
      },
    }
    await expect(loadPageWithReload(() => Promise.reject(failure), blocked)).rejects.toBe(failure)
    expect(state.reloads).toBe(0)
  })
})
