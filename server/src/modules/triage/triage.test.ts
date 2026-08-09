import { describe, expect, test } from 'bun:test'
import { createTriageBulkTargetIdempotencyKey } from './triage'

describe('Triage application helpers', () => {
  test('derives a fixed-length bulk target key from maximum transport inputs', () => {
    const key = createTriageBulkTargetIdempotencyKey('k'.repeat(160), 'e'.repeat(200))

    expect(key).toMatch(/^bulk:[a-f0-9]{64}$/u)
    expect(key).toHaveLength(69)
  })

  test('binds a bulk target key to both the request and entry', () => {
    const original = createTriageBulkTargetIdempotencyKey('request-1', 'entry-1')

    expect(createTriageBulkTargetIdempotencyKey('request-2', 'entry-1')).not.toBe(original)
    expect(createTriageBulkTargetIdempotencyKey('request-1', 'entry-2')).not.toBe(original)
  })
})
