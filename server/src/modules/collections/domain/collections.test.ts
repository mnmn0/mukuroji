import { expect, test } from 'bun:test'
import { parseCreateCollectionInput, parseExpectedRevisionQuery, parseUpdateCollectionInput } from './collections'

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
