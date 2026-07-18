import { describe, expect, test } from 'bun:test'
import { whiteboardRecordFixture } from '../src/documents/fixtures'
import {
  moveWhiteboardObjectWithinCanvas,
  resolveDocumentMoveErrorKey,
} from '../src/documents/ui'

describe('Document move feedback', () => {
  test('distinguishes permission denial from a general move failure', () => {
    expect(resolveDocumentMoveErrorKey({ status: 403 })).toBe(
      'documents.tree.moveDenied',
    )
    expect(resolveDocumentMoveErrorKey(new Error('offline'))).toBe(
      'documents.tree.moveError',
    )
  })
})

describe('Whiteboard keyboard movement', () => {
  test('moves an object by the requested step and clamps it to the canvas', () => {
    if (whiteboardRecordFixture.kind !== 'whiteboard') {
      throw new Error('Expected a whiteboard fixture.')
    }
    const source = whiteboardRecordFixture.whiteboard.objects[0]!
    const moved = moveWhiteboardObjectWithinCanvas(source, 10, -10_000)
    const clamped = moveWhiteboardObjectWithinCanvas(
      moved,
      10_000,
      10_000,
    )

    expect(moved.bounds.x).toBe(source.bounds.x + 10)
    expect(moved.bounds.y).toBe(0)
    expect(clamped.bounds.x).toBe(1400 - source.bounds.width)
    expect(clamped.bounds.y).toBe(900 - source.bounds.height)
  })
})
