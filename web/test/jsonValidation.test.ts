import { describe, expect, test } from 'bun:test'
import { isRecord, readRecord } from '../src/shared/api/jsonValidation'

describe('JSON record guards', () => {
  test('isRecord accepts plain objects and rejects null, arrays, and primitives', () => {
    expect(isRecord({ code: 'Conflict' })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord(['a'])).toBe(false)
    expect(isRecord('text')).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })

  test('readRecord returns the same object for records and an empty record otherwise', () => {
    const payload = { message: 'Saved.' }

    expect(readRecord(payload)).toBe(payload)
    expect(readRecord(null)).toEqual({})
    expect(readRecord(['message'])).toEqual({})
    expect(readRecord(42)).toEqual({})
  })
})
