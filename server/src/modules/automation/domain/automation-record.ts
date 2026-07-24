import type { AutomationValue } from '@mukuroji/contracts'
import { AutomationError } from './automation-error'
import { isAutomationValue } from './automation-value'

/**
 * Validates and clones an untrusted Automation JSON object.
 *
 * @param value - Untrusted object candidate.
 * @param label - Safe field label used in validation messages.
 * @returns A detached record containing bounded Automation values.
 */
export function requireAutomationRecord(
  value: unknown,
  label: string,
): Record<string, AutomationValue> {
  if (!isRecord(value)) {
    throw new AutomationError(
      'invalid-input',
      'InvalidAutomationInput',
      `${label} must be an object.`,
    )
  }
  if (!isAutomationRecord(value)) {
    throw new AutomationError(
      'invalid-input',
      'InvalidAutomationInput',
      `${label} is invalid.`,
    )
  }
  return structuredClone(value)
}

/** Tests whether a plain record contains only bounded Automation values. */
function isAutomationRecord(
  value: Record<string, unknown>,
): value is Record<string, AutomationValue> {
  return isAutomationValue(value)
}

/** Narrows an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
