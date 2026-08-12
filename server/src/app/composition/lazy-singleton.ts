/**
 * Creates a deferred synchronous composition value that is cached after the
 * first successful construction.
 *
 * A factory failure is not cached, allowing a later invocation to retry
 * dependency construction.
 *
 * @param factory - Synchronous constructor invoked until one call succeeds.
 * @returns Function that returns the single successfully constructed value.
 */
export function createLazySingleton<Value>(
  factory: () => Value,
): () => Value {
  let state:
    | { readonly initialized: false }
    | { readonly initialized: true; readonly value: Value } = {
      initialized: false,
    }
  return () => {
    if (state.initialized) return state.value
    const value = factory()
    state = { initialized: true, value }
    return value
  }
}
