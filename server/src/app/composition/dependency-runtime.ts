import { AsyncLocalStorage } from 'node:async_hooks'
import type { Hono } from 'hono'

/**
 * Immutable dependency sets を app instance と async request context に束縛する runtime を作ります。
 */
export function createDependencyRuntime<Dependencies extends object>() {
  const storage = new AsyncLocalStorage<Readonly<Dependencies>>()
  const immutableDependenciesBySource = new WeakMap<
    Dependencies,
    Readonly<Dependencies>
  >()

  function getImmutableDependencies(
    dependencies: Dependencies,
  ): Readonly<Dependencies> {
    const cached = immutableDependenciesBySource.get(dependencies)
    if (cached) return cached
    const immutableDependencies = Object.freeze({ ...dependencies })
    immutableDependenciesBySource.set(dependencies, immutableDependencies)
    return immutableDependencies
  }

  function requireDependencies(): Readonly<Dependencies> {
    const dependencies = storage.getStore()
    if (!dependencies) {
      throw new Error('API app dependency context is not initialized.')
    }
    return dependencies
  }

  return {
    requireDependencies,
    createProxy<Key extends keyof Dependencies>(key: Key): Dependencies[Key] {
      return new Proxy({} as Dependencies[Key] & object, {
        get(_target, property) {
          const dependency = requireDependencies()[key]
          const value = Reflect.get(dependency as object, property)
          return typeof value === 'function' ? value.bind(dependency) : value
        },
      })
    },
    bindApp(app: Hono, dependencies: Dependencies): Hono {
      const immutableDependencies = getImmutableDependencies(dependencies)
      return new Proxy(app, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property === 'fetch' || property === 'request') {
            return (...args: unknown[]) => storage.run(
              immutableDependencies,
              () => Reflect.apply(value, target, args),
            )
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    runWith<Result>(
      dependencies: Dependencies,
      operation: () => Result,
    ): Result {
      return storage.run(getImmutableDependencies(dependencies), operation)
    },
  }
}
