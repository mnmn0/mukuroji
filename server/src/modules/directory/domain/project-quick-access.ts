import {
  PROJECT_QUICK_ACCESS_IDENTIFIER_MAX_LENGTH,
  PROJECT_QUICK_ACCESS_MAX_ITEMS,
  type ProjectQuickAccessItem,
} from '@mukuroji/contracts'

/**
 * Validates an identifier retained in a Project quick-access preference.
 *
 * @param value - Candidate Team or Project identifier.
 * @returns Whether the identifier satisfies the persisted preference boundary.
 */
export function isProjectQuickAccessIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROJECT_QUICK_ACCESS_IDENTIFIER_MAX_LENGTH &&
    value.trim() === value &&
    !value.includes('/')
}

/**
 * Validates a complete ordered Project quick-access collection.
 *
 * @param value - Candidate preference item collection.
 * @returns Whether every item is canonical, bounded, and unique by Team/Project identity.
 */
export function isProjectQuickAccessItems(
  value: unknown,
): value is ProjectQuickAccessItem[] {
  if (!Array.isArray(value) || value.length > PROJECT_QUICK_ACCESS_MAX_ITEMS) {
    return false
  }

  const identities = new Set<string>()
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isProjectQuickAccessIdentifier(item.teamId) ||
      !isProjectQuickAccessIdentifier(item.projectId)
    ) {
      return false
    }
    const identity = createProjectQuickAccessIdentity({
      projectId: item.projectId,
      teamId: item.teamId,
    })
    if (identities.has(identity)) {
      return false
    }
    identities.add(identity)
  }
  return true
}

/**
 * Creates the canonical identity for one Team-owned Project shortcut.
 *
 * @param item - Valid Team and Project reference.
 * @returns A collision-safe identity that preserves both identifiers.
 */
export function createProjectQuickAccessIdentity(
  item: ProjectQuickAccessItem,
): string {
  return JSON.stringify([item.teamId, item.projectId])
}

/**
 * Narrows an unknown value to a non-array object.
 *
 * @param value - Candidate object value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
