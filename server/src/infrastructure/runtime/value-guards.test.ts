import { describe, expect, test } from 'bun:test'
import { isRecord } from './value-guards'

describe('isRecord', () => {
  test('accepts non-array objects', () => {
    expect(isRecord({ version: 1 })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
  })

  test('rejects null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord([1])).toBe(false)
    expect(isRecord('{}')).toBe(false)
    expect(isRecord(1)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})
