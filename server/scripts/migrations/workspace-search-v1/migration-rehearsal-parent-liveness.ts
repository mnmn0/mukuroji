import { createReadStream, fstatSync } from 'node:fs'
import { Readable } from 'node:stream'

/** Fixed child descriptor carrying the silent parent-liveness pipe. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_FD = 4

/** Fixed protocol bound into parent spawn and abandonment evidence. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_PROTOCOL =
  'silent-fd4-v1'

/** Active one-shot monitor for the silent parent-liveness channel. */
export type WorkspaceSearchMigrationRehearsalParentLivenessMonitor = {
  /** Resolves only after the parent channel is lost or violates silence. */
  readonly waitForLoss: () => Promise<void>
  /** Stops monitoring during an ordinary child shutdown. */
  readonly stop: () => void
}

/** Input for monitoring one already-open silent parent channel. */
export type CreateWorkspaceSearchMigrationRehearsalParentLivenessMonitorInput = {
  /** Readable child endpoint whose writer is owned only by the parent. */
  readonly stream: Readable
  /** Aborts the active child operation after an unexpected channel loss. */
  readonly onLoss: () => void
}

/**
 * Starts a one-shot monitor over one silent parent-owned pipe.
 *
 * EOF, stream failure, premature close, and any payload byte all mean that the
 * parent can no longer contain the child. Ordinary child completion must call
 * `stop` before closing its endpoint.
 *
 * @param input - Captured readable endpoint and fail-closed loss callback.
 * @returns Frozen monitor exposing a durable-in-process loss promise.
 */
export function createWorkspaceSearchMigrationRehearsalParentLivenessMonitor(
  input: CreateWorkspaceSearchMigrationRehearsalParentLivenessMonitorInput,
): WorkspaceSearchMigrationRehearsalParentLivenessMonitor {
  const stream = input.stream
  const onLoss = input.onLoss
  if (!(stream instanceof Readable) || typeof onLoss !== 'function') {
    throw new Error('INVALID_REHEARSAL_PARENT_LIVENESS_MONITOR')
  }
  let stopped = false
  let lost = false
  let resolveLoss: (() => void) | undefined
  const loss = new Promise<void>((resolve) => {
    resolveLoss = resolve
  })

  /** Removes every listener installed by this monitor. */
  const removeListeners = (): void => {
    stream.off('data', handleData)
    stream.off('end', handleEnd)
    stream.off('error', handleError)
    stream.off('close', handleClose)
  }

  /** Records an unexpected parent-channel loss exactly once. */
  const recordLoss = (): void => {
    if (stopped || lost) return
    lost = true
    removeListeners()
    const resolve = resolveLoss
    resolveLoss = undefined
    resolve?.()
    try {
      onLoss()
    } catch {
      // The loss promise remains authoritative if cancellation itself fails.
    }
    if (!stream.destroyed) stream.destroy()
  }

  /** Rejects any byte because the liveness descriptor is intentionally silent. */
  function handleData(): void {
    recordLoss()
  }

  /** Treats writer EOF as definitive parent disappearance. */
  function handleEnd(): void {
    recordLoss()
  }

  /** Treats transport errors as indistinguishable from parent disappearance. */
  function handleError(): void {
    recordLoss()
  }

  /** Treats a close without an ordinary stop as parent disappearance. */
  function handleClose(): void {
    recordLoss()
  }

  stream.on('data', handleData)
  stream.once('end', handleEnd)
  stream.once('error', handleError)
  stream.once('close', handleClose)
  stream.resume()

  return Object.freeze({
    waitForLoss: () => loss,
    stop: (): void => {
      if (stopped) return
      stopped = true
      removeListeners()
      if (!stream.destroyed) stream.destroy()
    },
  })
}

/**
 * Opens and monitors the fixed inherited parent-liveness descriptor.
 *
 * @param onLoss - Aborts the active child operation after channel loss.
 * @returns Frozen monitor for the inherited descriptor.
 */
export function createDefaultWorkspaceSearchMigrationRehearsalParentLivenessMonitor(
  onLoss: () => void,
): WorkspaceSearchMigrationRehearsalParentLivenessMonitor {
  let stream: Readable
  try {
    const metadata = fstatSync(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_FD,
    )
    if (!metadata.isFIFO() && !metadata.isSocket()) {
      throw new Error('INVALID_REHEARSAL_PARENT_LIVENESS_DESCRIPTOR')
    }
    stream = createReadStream('/dev/null', {
      fd: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PARENT_LIVENESS_FD,
      autoClose: true,
    })
  } catch {
    try {
      onLoss()
    } catch {
      // The resolved loss promise remains authoritative.
    }
    const loss = Promise.resolve()
    return Object.freeze({
      waitForLoss: () => loss,
      stop: (): void => {},
    })
  }
  return createWorkspaceSearchMigrationRehearsalParentLivenessMonitor({
    stream,
    onLoss,
  })
}
