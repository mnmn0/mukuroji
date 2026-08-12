import type { FocusPolicyOverrides } from '@mukuroji/contracts'

/** Parsed optional policy form number. */
type ParsedPolicyNumber = {
  /** Whether a supplied value passed finite-number validation. */
  valid: boolean
  /** Parsed override, omitted when the field intentionally inherits. */
  value?: number
}

/** Parsed overrides and field-level validation failures from one policy form. */
export type FocusPolicyFormReadResult = {
  /** Names of controls whose supplied values failed bounds or integer validation. */
  invalidFieldNames: readonly string[]
  /** Valid sparse overrides retained even when another field is invalid. */
  overrides: FocusPolicyOverrides
}

/**
 * Parses a sparse Focus policy replacement from trusted form controls.
 *
 * @param formData - Form fields whose blanks intentionally retain inheritance.
 * @returns Valid sparse overrides plus the names of invalid supplied fields.
 */
export function readFocusPolicyOverrides(
  formData: FormData,
): FocusPolicyFormReadResult {
  const blocker = readOptionalPolicyNumber(formData, 'weight-blocker', 0, 10_000)
  const urgent = readOptionalPolicyNumber(formData, 'weight-urgent', 0, 10_000)
  const overdue = readOptionalPolicyNumber(formData, 'weight-overdue', 0, 10_000)
  const dueSoon = readOptionalPolicyNumber(formData, 'weight-dueSoon', 0, 10_000)
  const approval = readOptionalPolicyNumber(formData, 'weight-approval', 0, 10_000)
  const reviewRequest = readOptionalPolicyNumber(
    formData,
    'weight-reviewRequest',
    0,
    10_000,
  )
  const mention = readOptionalPolicyNumber(formData, 'weight-mention', 0, 10_000)
  const sla = readOptionalPolicyNumber(formData, 'weight-sla', 0, 10_000)
  const cycle = readOptionalPolicyNumber(formData, 'weight-cycle', 0, 10_000)
  const dueSoonDays = readOptionalPolicyNumber(formData, 'dueSoonDays', 0, 365, true)
  const cycleDueSoonDays = readOptionalPolicyNumber(
    formData,
    'cycleDueSoonDays',
    0,
    365,
    true,
  )
  const slaHours = readOptionalPolicyNumber(formData, 'slaHours', 1, 8_760, true)
  const nowScoreThreshold = readOptionalPolicyNumber(
    formData,
    'nowScoreThreshold',
    0,
    100_000,
  )
  const values: readonly [string, ParsedPolicyNumber][] = [
    ['weight-blocker', blocker],
    ['weight-urgent', urgent],
    ['weight-overdue', overdue],
    ['weight-dueSoon', dueSoon],
    ['weight-approval', approval],
    ['weight-reviewRequest', reviewRequest],
    ['weight-mention', mention],
    ['weight-sla', sla],
    ['weight-cycle', cycle],
    ['dueSoonDays', dueSoonDays],
    ['cycleDueSoonDays', cycleDueSoonDays],
    ['slaHours', slaHours],
    ['nowScoreThreshold', nowScoreThreshold],
  ]

  const weights = {
    ...(approval.value === undefined ? {} : { approval: approval.value }),
    ...(blocker.value === undefined ? {} : { blocker: blocker.value }),
    ...(cycle.value === undefined ? {} : { cycle: cycle.value }),
    ...(dueSoon.value === undefined ? {} : { dueSoon: dueSoon.value }),
    ...(mention.value === undefined ? {} : { mention: mention.value }),
    ...(overdue.value === undefined ? {} : { overdue: overdue.value }),
    ...(reviewRequest.value === undefined ? {} : { reviewRequest: reviewRequest.value }),
    ...(sla.value === undefined ? {} : { sla: sla.value }),
    ...(urgent.value === undefined ? {} : { urgent: urgent.value }),
  }
  return {
    invalidFieldNames: values.flatMap(([name, value]) => value.valid ? [] : [name]),
    overrides: {
      ...(Object.keys(weights).length === 0 ? {} : { weights }),
      ...(cycleDueSoonDays.value === undefined
        ? {}
        : { cycleDueSoonDays: cycleDueSoonDays.value }),
      ...(dueSoonDays.value === undefined ? {} : { dueSoonDays: dueSoonDays.value }),
      ...(nowScoreThreshold.value === undefined
        ? {}
        : { nowScoreThreshold: nowScoreThreshold.value }),
      ...(slaHours.value === undefined ? {} : { slaHours: slaHours.value }),
    },
  }
}

/** Reads one optional bounded finite number from a form field. */
function readOptionalPolicyNumber(
  formData: FormData,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
  integer = false,
): ParsedPolicyNumber {
  const value = formData.get(name)
  if (value === null) return { valid: true }
  if (typeof value !== 'string') return { valid: false }
  if (value.trim().length === 0) return { valid: true }
  const number = Number(value)
  return Number.isFinite(number) &&
    number >= minimum &&
    number <= maximum &&
    (!integer || Number.isSafeInteger(number))
    ? { valid: true, value: number }
    : { valid: false }
}
