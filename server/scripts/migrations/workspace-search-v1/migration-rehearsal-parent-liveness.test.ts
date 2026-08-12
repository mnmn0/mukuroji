import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  createWorkspaceSearchMigrationRehearsalParentLivenessMonitor,
} from './migration-rehearsal-parent-liveness'

/** Yields one event-loop turn without introducing a wall-clock delay. */
async function yieldParentLivenessEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('migration rehearsal parent liveness monitor', () => {
  test('reports silent EOF exactly once', async () => {
    const stream = new PassThrough()
    let lossCount = 0
    const monitor =
      createWorkspaceSearchMigrationRehearsalParentLivenessMonitor({
        stream,
        onLoss: (): void => {
          lossCount += 1
        },
      })

    stream.end()
    await monitor.waitForLoss()
    await yieldParentLivenessEventLoop()

    expect(lossCount).toBe(1)
  })

  test('rejects any payload on the intentionally silent descriptor', async () => {
    const stream = new PassThrough()
    let lossCount = 0
    const monitor =
      createWorkspaceSearchMigrationRehearsalParentLivenessMonitor({
        stream,
        onLoss: (): void => {
          lossCount += 1
        },
      })

    stream.write(new Uint8Array([1]))
    await monitor.waitForLoss()
    stream.end()
    await yieldParentLivenessEventLoop()

    expect(lossCount).toBe(1)
  })

  test('reports a stream failure without retaining its raw value', async () => {
    const stream = new PassThrough()
    let lossCount = 0
    const monitor =
      createWorkspaceSearchMigrationRehearsalParentLivenessMonitor({
        stream,
        onLoss: (): void => {
          lossCount += 1
        },
      })

    stream.destroy(new Error('sensitive raw transport failure'))
    await monitor.waitForLoss()

    expect(lossCount).toBe(1)
  })

  test('allows an ordinary child shutdown to stop monitoring', async () => {
    const stream = new PassThrough()
    let lossCount = 0
    const monitor =
      createWorkspaceSearchMigrationRehearsalParentLivenessMonitor({
        stream,
        onLoss: (): void => {
          lossCount += 1
        },
      })

    monitor.stop()
    monitor.stop()
    await yieldParentLivenessEventLoop()

    expect(lossCount).toBe(0)
  })
})
