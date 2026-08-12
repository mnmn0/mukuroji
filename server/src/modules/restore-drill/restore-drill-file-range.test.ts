import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { FILE_UPLOAD_MAX_SIZE_BYTES } from '../file-upload-policy'
import {
  RESTORE_DRILL_FILE_MAXIMUM_BYTES,
  RESTORE_DRILL_FILE_RANGE_SIZE_BYTES,
  RestoreDrillFileRangeFailure,
  advanceRestoreDrillFileRangeCheckpoint,
  createRestoreDrillFileRangeCheckpoint,
  selectRestoreDrillFileRangeWindow,
  type RestoreDrillFileRangeBinding,
} from './restore-drill-file-range'

const DIGEST_KEY = new Uint8Array(32).fill(41)

/** Exact source/destination identity used by range checkpoint tests. */
const BINDING: RestoreDrillFileRangeBinding = {
  destinationBucketName: 'restore-drill-scratch',
  destinationObjectVersionId: 'destination-version-1',
  drillDigest: '0123456789abcdef',
  fileVersionId: 'file-version-1',
  objectKey: 'workspaces/workspace-1/files/file-1/version-1/archive.zip',
  sourceBucketName: 'mukuroji-files',
  sourceObjectVersionId: 'source-version-1',
  totalBytes: RESTORE_DRILL_FILE_MAXIMUM_BYTES,
}

/** Creates one deterministic fake range digest without allocating range bytes. */
function fakeRangeDigest(rangeIndex: number): string {
  return createHash('sha256').update(`range-${rangeIndex}`).digest('hex')
}

describe('restore drill File range checkpoint chain', () => {
  test('shares the production File upload ceiling', () => {
    expect(RESTORE_DRILL_FILE_MAXIMUM_BYTES).toBe(FILE_UPLOAD_MAX_SIZE_BYTES)
  })

  test('covers the exact 2 GiB production maximum through bounded checkpoints', () => {
    let checkpoint = createRestoreDrillFileRangeCheckpoint(BINDING, DIGEST_KEY)
    let complete = false
    let rangeIndex = 0
    while (!complete) {
      const window = selectRestoreDrillFileRangeWindow(BINDING, checkpoint, DIGEST_KEY)
      expect(window.length).toBeLessThanOrEqual(RESTORE_DRILL_FILE_RANGE_SIZE_BYTES)
      const digest = fakeRangeDigest(rangeIndex)
      const advanced = advanceRestoreDrillFileRangeCheckpoint({
        binding: BINDING,
        checkpoint,
        destinationRangeSha256: digest,
        digestKey: DIGEST_KEY,
        sourceRangeSha256: digest,
        window,
      })
      checkpoint = advanced.checkpoint
      complete = advanced.complete
      rangeIndex += 1
    }

    expect(rangeIndex).toBe(128)
    expect(checkpoint.nextOffset).toBe(RESTORE_DRILL_FILE_MAXIMUM_BYTES)
    expect(checkpoint.rangeCount).toBe(128)
    expect(JSON.stringify(checkpoint)).not.toContain(BINDING.objectKey)
    expect(() => selectRestoreDrillFileRangeWindow(BINDING, checkpoint, DIGEST_KEY)).toThrow(
      RestoreDrillFileRangeFailure,
    )
  })

  test('selects an exact short final range', () => {
    const binding = {
      ...BINDING,
      totalBytes: RESTORE_DRILL_FILE_RANGE_SIZE_BYTES + 7,
    }
    const initial = createRestoreDrillFileRangeCheckpoint(binding, DIGEST_KEY)
    const firstWindow = selectRestoreDrillFileRangeWindow(binding, initial, DIGEST_KEY)
    const digest = fakeRangeDigest(0)
    const first = advanceRestoreDrillFileRangeCheckpoint({
      binding,
      checkpoint: initial,
      destinationRangeSha256: digest,
      digestKey: DIGEST_KEY,
      sourceRangeSha256: digest,
      window: firstWindow,
    })
    const finalWindow = selectRestoreDrillFileRangeWindow(binding, first.checkpoint, DIGEST_KEY)

    expect(first.complete).toBe(false)
    expect(finalWindow).toEqual({
      end: RESTORE_DRILL_FILE_RANGE_SIZE_BYTES + 6,
      length: 7,
      rangeHeader:
        `bytes=${RESTORE_DRILL_FILE_RANGE_SIZE_BYTES}-${RESTORE_DRILL_FILE_RANGE_SIZE_BYTES + 6}`,
      start: RESTORE_DRILL_FILE_RANGE_SIZE_BYTES,
    })
  })

  test('rejects differing independently observed range digests', () => {
    const checkpoint = createRestoreDrillFileRangeCheckpoint(BINDING, DIGEST_KEY)
    const window = selectRestoreDrillFileRangeWindow(BINDING, checkpoint, DIGEST_KEY)

    expect(() => advanceRestoreDrillFileRangeCheckpoint({
      binding: BINDING,
      checkpoint,
      destinationRangeSha256: 'b'.repeat(64),
      digestKey: DIGEST_KEY,
      sourceRangeSha256: 'a'.repeat(64),
      window,
    })).toThrow(new RestoreDrillFileRangeFailure('RANGE_DIGEST_MISMATCH'))
  })

  test('rejects tampered progress and checkpoint substitution', () => {
    const checkpoint = createRestoreDrillFileRangeCheckpoint(BINDING, DIGEST_KEY)
    const tampered = { ...checkpoint, nextOffset: 1 }
    expect(() => selectRestoreDrillFileRangeWindow(BINDING, tampered, DIGEST_KEY)).toThrow(
      new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID'),
    )
    expect(() => selectRestoreDrillFileRangeWindow({
      ...BINDING,
      destinationObjectVersionId: 'substituted-version',
    }, checkpoint, DIGEST_KEY)).toThrow(
      new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID'),
    )
    expect(() => Reflect.apply(selectRestoreDrillFileRangeWindow, undefined, [
      BINDING,
      null,
      DIGEST_KEY,
    ])).toThrow(new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID'))
    expect(() => Reflect.apply(selectRestoreDrillFileRangeWindow, undefined, [
      BINDING,
      { ...checkpoint, rangeCount: 0n },
      DIGEST_KEY,
    ])).toThrow(new RestoreDrillFileRangeFailure('CHECKPOINT_INVALID'))
  })

  test('replays a lost range response to the same deterministic checkpoint', () => {
    const checkpoint = createRestoreDrillFileRangeCheckpoint(BINDING, DIGEST_KEY)
    const window = selectRestoreDrillFileRangeWindow(BINDING, checkpoint, DIGEST_KEY)
    const digest = fakeRangeDigest(0)
    const input = {
      binding: BINDING,
      checkpoint,
      destinationRangeSha256: digest,
      digestKey: DIGEST_KEY,
      sourceRangeSha256: digest,
      window,
    }

    const first = advanceRestoreDrillFileRangeCheckpoint(input)
    const replay = advanceRestoreDrillFileRangeCheckpoint(input)
    expect(replay).toEqual(first)
    expect(replay.checkpoint.nextOffset).toBe(RESTORE_DRILL_FILE_RANGE_SIZE_BYTES)
  })
})
