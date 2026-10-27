import { describe, expect, test } from 'bun:test'
import { STALE_CHUNK_RELOAD_INTERVAL_MS, shouldReloadForFailedChunk } from '../src/app/staleChunkReload'

describe('shouldReloadForFailedChunk', () => {
  test('reloads when no recent reload is stored', () => {
    expect(shouldReloadForFailedChunk(null, 1_000_000)).toBe(true)
    expect(shouldReloadForFailedChunk('not-a-time', 1_000_000)).toBe(true)
    expect(shouldReloadForFailedChunk(String(1_000_000 - STALE_CHUNK_RELOAD_INTERVAL_MS), 1_000_000)).toBe(true)
  })

  test('leaves a repeated failure to the route instead of reloading in a loop', () => {
    expect(shouldReloadForFailedChunk(String(1_000_000 - 1), 1_000_000)).toBe(false)
  })

  test('reloads when the stored time is in the future, such as after a clock change', () => {
    expect(shouldReloadForFailedChunk(String(2_000_000), 1_000_000)).toBe(true)
  })
})
