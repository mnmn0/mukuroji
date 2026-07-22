import type { AutomationValue } from '@mukuroji/contracts'

/**
 * Tests whether an untrusted value is safe for Automation JSON payloads.
 *
 * @param value - Value to validate.
 * @param depth - Current recursive depth.
 * @returns Whether the value is a bounded JSON-compatible Automation value.
 */
export function isAutomationValue(value: unknown, depth = 0): value is AutomationValue {
  if (depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    return value.length <= 1_000 &&
      value.every((entry) => isAutomationValue(entry, depth + 1))
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    return entries.length <= 1_000 && entries.every(([key, entry]) =>
      key.length > 0 && key.length <= 256 && isAutomationValue(entry, depth + 1)
    )
  }
  return false
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
