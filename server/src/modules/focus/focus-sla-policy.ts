import type { FocusSlaAnchor } from '@mukuroji/contracts'

/** Supported moments from which the SLA window can be measured. */
const FOCUS_SLA_ANCHORS: readonly FocusSlaAnchor[] = ['created', 'planned-start', 'started']

/** Maximum number of Work Item Types one policy layer can target with the SLA signal. */
const FOCUS_SLA_WORK_ITEM_TYPE_LIMIT = 50

/** Maximum length of one Work Item Type ID in a Focus SLA policy. */
const FOCUS_SLA_WORK_ITEM_TYPE_ID_MAX_LENGTH = 128

/**
 * Checks whether a value is a supported Focus SLA anchor.
 *
 * @param value - Candidate anchor.
 * @returns True for `created`, `planned-start`, or `started`.
 */
export function isFocusSlaAnchor(value: unknown): value is FocusSlaAnchor {
  return FOCUS_SLA_ANCHORS.some((anchor) => anchor === value)
}

/**
 * Validates and canonicalizes the Work Item Types targeted by the SLA signal.
 *
 * @param value - Candidate Type ID list from a policy layer or request body.
 * @returns Sorted, deduplicated Type IDs.
 * @throws RangeError when the list is too long or contains an invalid ID.
 */
export function normalizeFocusSlaWorkItemTypeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > FOCUS_SLA_WORK_ITEM_TYPE_LIMIT) {
    throw new RangeError(
      `Focus SLA Work Item Types must be a list of at most ${FOCUS_SLA_WORK_ITEM_TYPE_LIMIT} IDs.`,
    )
  }
  const typeIds: string[] = []
  for (const typeId of value) {
    if (
      typeof typeId !== 'string' ||
      typeId.length === 0 ||
      typeId.length > FOCUS_SLA_WORK_ITEM_TYPE_ID_MAX_LENGTH ||
      typeId.trim() !== typeId
    ) {
      throw new RangeError('Focus SLA Work Item Type IDs must be trimmed nonempty identifiers.')
    }
    typeIds.push(typeId)
  }
  return [...new Set(typeIds)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )
}
