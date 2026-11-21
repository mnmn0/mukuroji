import type { FocusPolicyOverrides, FocusSlaAnchor } from '@mukuroji/contracts'

/** SLA anchors accepted by the policy form, in display order. */
export const focusSlaAnchorOptions: readonly FocusSlaAnchor[] = ['planned-start', 'started', 'created']

/** Maximum number of Work Item Types one policy layer can target with the SLA signal. */
const focusSlaWorkItemTypeLimit = 50

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
  const slipped = readOptionalPolicyNumber(formData, 'weight-slipped', 0, 10_000)
  const dueSoonDays = readOptionalPolicyNumber(formData, 'dueSoonDays', 0, 365, true)
  const cycleDueSoonDays = readOptionalPolicyNumber(
    formData,
    'cycleDueSoonDays',
    0,
    365,
    true,
  )
  const slaHours = readOptionalPolicyNumber(formData, 'slaHours', 1, 8_760, true)
  const slippedThresholdDays = readOptionalPolicyNumber(
    formData,
    'slippedThresholdDays',
    1,
    365,
    true,
  )
  const nowScoreThreshold = readOptionalPolicyNumber(
    formData,
    'nowScoreThreshold',
    0,
    100_000,
  )
  const slaEnabled = readOptionalPolicyBoolean(formData, 'slaEnabled')
  const slaAnchor = readOptionalSlaAnchor(formData, 'slaAnchor')
  const slaWorkItemTypeIds = readOptionalTypeIds(
    formData,
    'slaWorkItemTypeMode',
    'slaWorkItemTypeIds',
  )
  const values: readonly [string, { valid: boolean }][] = [
    ['weight-blocker', blocker],
    ['weight-urgent', urgent],
    ['weight-overdue', overdue],
    ['weight-dueSoon', dueSoon],
    ['weight-approval', approval],
    ['weight-reviewRequest', reviewRequest],
    ['weight-mention', mention],
    ['weight-sla', sla],
    ['weight-cycle', cycle],
    ['weight-slipped', slipped],
    ['dueSoonDays', dueSoonDays],
    ['cycleDueSoonDays', cycleDueSoonDays],
    ['slaHours', slaHours],
    ['slippedThresholdDays', slippedThresholdDays],
    ['nowScoreThreshold', nowScoreThreshold],
    ['slaEnabled', slaEnabled],
    ['slaAnchor', slaAnchor],
    ['slaWorkItemTypeIds', slaWorkItemTypeIds],
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
    ...(slipped.value === undefined ? {} : { slipped: slipped.value }),
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
      ...(slippedThresholdDays.value === undefined
        ? {}
        : { slippedThresholdDays: slippedThresholdDays.value }),
      ...(slaEnabled.value === undefined ? {} : { slaEnabled: slaEnabled.value }),
      ...(slaAnchor.value === undefined ? {} : { slaAnchor: slaAnchor.value }),
      ...(slaWorkItemTypeIds.value === undefined
        ? {}
        : { slaWorkItemTypeIds: slaWorkItemTypeIds.value }),
    },
  }
}

/**
 * Reads an optional on/off select whose blank option inherits.
 *
 * @param formData - Submitted policy form.
 * @param name - Select name.
 * @returns The parsed flag, or no value when the field inherits.
 */
function readOptionalPolicyBoolean(
  formData: FormData,
  name: string,
): { valid: boolean, value?: boolean } {
  const value = formData.get(name)
  if (value === null || value === '') return { valid: true }
  if (value === 'true') return { valid: true, value: true }
  if (value === 'false') return { valid: true, value: false }
  return { valid: false }
}

/**
 * Reads an optional SLA anchor select whose blank option inherits.
 *
 * @param formData - Submitted policy form.
 * @param name - Select name.
 * @returns The parsed anchor, or no value when the field inherits.
 */
function readOptionalSlaAnchor(
  formData: FormData,
  name: string,
): { valid: boolean, value?: FocusSlaAnchor } {
  const value = formData.get(name)
  if (value === null || value === '') return { valid: true }
  const anchor = focusSlaAnchorOptions.find((option) => option === value)
  return anchor === undefined ? { valid: false } : { valid: true, value: anchor }
}

/**
 * Reads the SLA Work Item Type scope: inherit, every Type, or only the listed Type IDs.
 *
 * @param formData - Submitted policy form.
 * @param modeName - Select whose value is blank (inherit), `all`, or `listed`.
 * @param idsName - Comma-separated Type ID input used by the `listed` mode.
 * @returns No value to inherit, an empty list for every Type, or sorted deduplicated Type IDs.
 */
function readOptionalTypeIds(
  formData: FormData,
  modeName: string,
  idsName: string,
): { valid: boolean, value?: string[] } {
  const mode = formData.get(modeName)
  if (mode === null || mode === '') return { valid: true }
  if (mode === 'all') return { valid: true, value: [] }
  if (mode !== 'listed') return { valid: false }
  const value = formData.get(idsName)
  if (typeof value !== 'string') return { valid: false }
  const typeIds = [...new Set(value.split(',').map((typeId) => typeId.trim()).filter(Boolean))]
  if (
    typeIds.length === 0 ||
    typeIds.length > focusSlaWorkItemTypeLimit ||
    typeIds.some((typeId) => typeId.length > 128)
  ) return { valid: false }
  return { valid: true, value: typeIds.sort() }
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
