import { expect, test } from 'bun:test'
import { COLLECTION_ITEM_LIMIT } from '@mukuroji/contracts'
import { isStoredCollection, parseCreateCollectionInput, parseExpectedRevisionQuery, parseUpdateCollectionInput } from './collections'

test('trims input, allows multi-line descriptions, and rejects control characters in names', () => {
  expect(parseCreateCollectionInput({ name: '  Launch ', description: ' Line 1\nLine 2 ' })).toEqual({ name: 'Launch', description: 'Line 1\nLine 2' })
  expect(parseCreateCollectionInput({ name: 'Launch', description: '  ' })).toEqual({ name: 'Launch' })
  for (const value of [{ name: 'A\nB' }, { name: '' }, { name: 'x'.repeat(121) }, { name: 'A', description: 'bell\u0007' }, { name: 'A', owner: 'x' }, []]) {
    expect(() => parseCreateCollectionInput(value)).toThrow()
  }
})

test('requires an observed revision and at least one change', () => {
  expect(parseUpdateCollectionInput({ expectedRevision: 2, description: '' })).toEqual({ expectedRevision: 2, description: '' })
  expect(() => parseUpdateCollectionInput({ expectedRevision: 2 })).toThrow()
  expect(() => parseUpdateCollectionInput({ expectedRevision: 0, name: 'A' })).toThrow()
  expect(parseExpectedRevisionQuery('3')).toBe(3)
  for (const value of [undefined, '0', '-1', '1.5', 'abc']) expect(() => parseExpectedRevisionQuery(value)).toThrow()
})

test('rejects stored Collections with more references than the item limit', () => {
  const item = (index: number) => ({ teamId: 't', issueId: `i${index}`, addedAt: '2026-10-16T00:00:00.000Z', addedBy: 'reader' })
  const stored = {
    collectionId: 'c1',
    name: 'Launch',
    createdBy: 'reader',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    revision: 1,
    createFingerprint: 'f'.repeat(64),
    items: Array.from({ length: COLLECTION_ITEM_LIMIT }, (_, index) => item(index)),
  }
  expect(isStoredCollection(stored)).toBe(true)
  expect(isStoredCollection({ ...stored, items: [...stored.items, item(COLLECTION_ITEM_LIMIT)] })).toBe(false)
  // Persisted names follow the input invariant, so blank or control-character names are corrupt.
  expect(isStoredCollection({ ...stored, name: '   ' })).toBe(false)
  expect(isStoredCollection({ ...stored, name: ' padded' })).toBe(false)
  expect(isStoredCollection({ ...stored, name: 'bad\u0007name' })).toBe(false)
  expect(isStoredCollection({ ...stored, description: 'Line one\nLine two' })).toBe(true)
  expect(isStoredCollection({ ...stored, description: ' padded' })).toBe(false)
  expect(isStoredCollection({ ...stored, description: '' })).toBe(false)
  expect(isStoredCollection({ ...stored, description: 'bad\u0007text' })).toBe(false)
  // Timestamps must be canonical ISO instants, as the contract promises.
  expect(isStoredCollection({ ...stored, createdAt: 'invalid' })).toBe(false)
  expect(isStoredCollection({ ...stored, updatedAt: '2026-10-16' })).toBe(false)
  expect(isStoredCollection({ ...stored, items: [{ ...stored.items[0], addedAt: 'yesterday' }] })).toBe(false)
  expect(isStoredCollection({ ...stored, createFingerprint: '' })).toBe(false)
  expect(isStoredCollection({ ...stored, createFingerprint: 'F'.repeat(64) })).toBe(false)
  expect(isStoredCollection({ ...stored, createFingerprint: 'f'.repeat(63) })).toBe(false)
  // Re-adding is a no-op, so a repeated (teamId, issueId) is corrupt state.
  expect(isStoredCollection({ ...stored, items: [item(1), item(2), item(1)] })).toBe(false)
})
