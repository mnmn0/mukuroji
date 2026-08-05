import {
  type AutomationValue,
  type WorkItemSchedule,
} from '@mukuroji/contracts'
import {
  normalizeWorkItemSchedule,
  WorkItemScheduleError,
} from '../../work-items'
import { AutomationError } from './automation-error'

/**
 * Validates an Automation-provided schedule with the canonical Work Item domain rules.
 *
 * @param value - Untrusted schedule candidate.
 * @param label - Human-readable input location used in validation errors.
 * @returns A detached canonical Work Item schedule.
 */
export function normalizeAutomationWorkItemSchedule(
  value: unknown,
  label: string,
): WorkItemSchedule {
  try {
    return normalizeWorkItemSchedule(value)
  } catch (error) {
    if (error instanceof WorkItemScheduleError) {
      throw new AutomationError(
        'invalid-input',
        'InvalidAutomationInput',
        `${label} is invalid: ${error.message}`,
      )
    }
    throw error
  }
}

/**
 * Replaces an optional schedule field with its validated canonical representation.
 *
 * @param fields - Validated Automation field record.
 * @param label - Human-readable input location used in validation errors.
 * @returns A detached field record with a canonical schedule when one was supplied.
 */
export function normalizeAutomationWorkItemScheduleField(
  fields: Record<string, AutomationValue>,
  label: string,
): Record<string, AutomationValue> {
  if (!Object.hasOwn(fields, 'schedule')) {
    return fields
  }
  return {
    ...fields,
    schedule: normalizeAutomationWorkItemSchedule(fields.schedule, label),
  }
}
