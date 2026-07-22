import { AsyncLocalStorage } from 'node:async_hooks'
import type { Hono } from 'hono'

/**
 * Creates a runtime that binds immutable dependencies to an asynchronous request context.
 *
 * @param createImmutableDependencies - Creates the immutable snapshot stored for each source graph.
 * @returns Operations for reading, binding, and explicitly running with a dependency set.
 */
export function createDependencyRuntime<Dependencies extends object>(
  createImmutableDependencies: (
    dependencies: Dependencies,
  ) => Readonly<Dependencies> = (dependencies) =>
    Object.freeze({ ...dependencies }),
) {
  const storage = new AsyncLocalStorage<Readonly<Dependencies>>()
  const immutableDependenciesBySource = new WeakMap<
    Dependencies,
    Readonly<Dependencies>
  >()

  /**
   * Freezes a shallow copy of a dependency graph once per source object.
   *
   * @param dependencies - Mutable source dependency graph.
   * @returns The cached immutable dependency graph.
   */
  function getImmutableDependencies(
    dependencies: Dependencies,
  ): Readonly<Dependencies> {
    const cached = immutableDependenciesBySource.get(dependencies)
    if (cached) return cached
    const immutableDependencies = createImmutableDependencies(dependencies)
    immutableDependenciesBySource.set(dependencies, immutableDependencies)
    return immutableDependencies
  }

  /**
   * Reads dependencies from the active asynchronous request context.
   *
   * @returns The dependency graph bound to the current operation.
   */
  function requireDependencies(): Readonly<Dependencies> {
    const dependencies = storage.getStore()
    if (!dependencies) {
      throw new Error('API app dependency context is not initialized.')
    }
    return dependencies
  }

  return {
    requireDependencies,
    /**
     * Binds a Hono application to one immutable dependency graph.
     *
     * @param app - Hono application to bind.
     * @param dependencies - Dependencies owned by the application instance.
     * @returns A request-bound application facade.
     */
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
    /**
     * Runs an operation with an explicit immutable dependency graph.
     *
     * @param dependencies - Dependencies to bind for the operation.
     * @param operation - Operation executed inside the dependency context.
     * @returns The operation result.
     */
    runWith<Result>(
      dependencies: Dependencies,
      operation: () => Result,
    ): Result {
      return storage.run(getImmutableDependencies(dependencies), operation)
    },
  }
}
