import { AsyncLocalStorage } from 'node:async_hooks'
import {
  readWorkspaceSearchWriterFenceGuardMaterial,
  type WorkspaceSearchWriterFenceGuardMaterial,
} from './workspace-search-writer-fence'
import type { WorkspaceSearchWriterFenceGuardSource } from './workspace-search-writer-fence-aws'

/**
 * Invocation-local cache of immutable application writer-fence acquisitions.
 */
type WorkspaceSearchWriterFenceInvocationStore = {
  /** First acquisition promise shared by every provider in this invocation. */
  acquisition?: Promise<WorkspaceSearchWriterFenceGuardMaterial>
}

/**
 * Invocation-scoped access to one exact application writer-fence token.
 */
export interface WorkspaceSearchWriterFenceGuardProvider {
  /**
   * Returns the first writer-fence acquisition attempted in this invocation.
   *
   * Both fulfillment and rejection are retained, so one invocation can never
   * refresh its token after the durable fence changes.
   *
   * @returns Immutable open-row guard material.
   */
  get(): Promise<WorkspaceSearchWriterFenceGuardMaterial>
}

/**
 * Stable failure raised when a writer runs outside an invocation scope.
 */
export class WorkspaceSearchWriterFenceInvocationScopeError extends Error {
  /** Machine-readable raw-value-free failure code. */
  readonly code = 'WORKSPACE_SEARCH_WRITER_FENCE_INVOCATION_SCOPE_REQUIRED'

  /**
   * Creates one invocation-scope failure.
   */
  constructor() {
    super('WORKSPACE_SEARCH_WRITER_FENCE_INVOCATION_SCOPE_REQUIRED')
    this.name = 'WorkspaceSearchWriterFenceInvocationScopeError'
  }
}

/**
 * Concrete provider retaining one source result per invocation.
 */
class InvocationWorkspaceSearchWriterFenceGuardProvider
implements WorkspaceSearchWriterFenceGuardProvider {
  /** Captured guard acquisition detached from later source mutation. */
  private readonly acquireGuard:
    () => Promise<WorkspaceSearchWriterFenceGuardMaterial>

  /**
   * Creates one invocation-scoped provider.
   *
   * @param source - Uncached measured AWS guard source.
   */
  constructor(source: WorkspaceSearchWriterFenceGuardSource) {
    this.acquireGuard = source.acquire.bind(source)
  }

  /**
   * Returns the first acquisition promise for the active invocation.
   *
   * @returns Fulfilled or rejected first acquisition promise.
   */
  get(): Promise<WorkspaceSearchWriterFenceGuardMaterial> {
    const store = writerFenceInvocationStorage.getStore()
    if (!store) {
      return Promise.reject(
        new WorkspaceSearchWriterFenceInvocationScopeError(),
      )
    }
    const existing = store.acquisition
    if (existing) {
      return existing
    }
    const acquisition = Promise.resolve()
      .then(this.acquireGuard)
      .then(freezeWorkspaceSearchWriterFenceGuardMaterial)
    store.acquisition = acquisition
    return acquisition
  }
}

/** Async context separating concurrently handled application invocations. */
const writerFenceInvocationStorage =
  new AsyncLocalStorage<WorkspaceSearchWriterFenceInvocationStore>()

/**
 * Creates an invocation-scoped provider over one uncached measured source.
 *
 * @param source - Source that independently measures and reads the live fence.
 * @returns Provider requiring an active invocation scope.
 */
export function createWorkspaceSearchWriterFenceGuardProvider(
  source: WorkspaceSearchWriterFenceGuardSource,
): WorkspaceSearchWriterFenceGuardProvider {
  return new InvocationWorkspaceSearchWriterFenceGuardProvider(source)
}

/**
 * Runs one application invocation with an initially empty writer-fence cache.
 *
 * Nested calls retain the existing scope so a helper cannot refresh material
 * inside the same logical invocation. Independently delivered events enter
 * this boundary without an active scope and therefore acquire separately.
 *
 * @param operation - Complete HTTP, event, schedule, or CLI invocation.
 * @returns Operation result.
 */
export function runWithWorkspaceSearchWriterFenceInvocation<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  if (writerFenceInvocationStorage.getStore()) {
    return operation()
  }
  return writerFenceInvocationStorage.run(
    {},
    operation,
  )
}

/**
 * Revalidates, detaches, and recursively freezes one acquired guard.
 *
 * @param material - Candidate source result.
 * @returns Runtime-immutable strict material.
 */
function freezeWorkspaceSearchWriterFenceGuardMaterial(
  material: WorkspaceSearchWriterFenceGuardMaterial,
): WorkspaceSearchWriterFenceGuardMaterial {
  const strict = readWorkspaceSearchWriterFenceGuardMaterial(material)
  freezeWorkspaceSearchWriterFenceValue(strict)
  return strict
}

/**
 * Recursively freezes plain guard arrays and records.
 *
 * @param value - Detached strict guard value.
 */
function freezeWorkspaceSearchWriterFenceValue(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  for (const nested of Object.values(value)) {
    freezeWorkspaceSearchWriterFenceValue(nested)
  }
  Object.freeze(value)
}
