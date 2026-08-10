import type { TriageOwnerRotation } from '../api/types'

/**
 * Creates a non-reusable stable identifier for a new Triage configuration item.
 *
 * @param prefix - Domain-specific identifier prefix.
 * @param existingIds - Identifiers already present in the editable configuration.
 * @param createSuffix - Collision-resistant suffix generator, injectable for tests.
 * @returns An identifier that does not collide with an existing item.
 */
export function createUniqueTriageConfigurationId(
  prefix: 'rotation' | 'rule' | 'sla',
  existingIds: readonly string[],
  createSuffix: () => string = () => globalThis.crypto.randomUUID(),
): string {
  const usedIds = new Set(existingIds)
  for (let attempt = 0; attempt <= existingIds.length; attempt += 1) {
    const candidate = `${prefix}-${createSuffix()}`
    if (!usedIds.has(candidate)) return candidate
  }
  throw new Error('Unable to allocate a Triage configuration identifier.')
}

/**
 * Replaces rotation members while keeping the next eligible member when possible.
 *
 * @param rotation - Current editable rotation and cursor.
 * @param memberUserIds - Deduplicated replacement member identifiers.
 * @returns A detached rotation whose cursor is valid for the replacement members.
 */
export function replaceTriageRotationMembers(
  rotation: TriageOwnerRotation,
  memberUserIds: readonly string[],
): TriageOwnerRotation {
  const nextMemberUserId = rotation.memberUserIds[rotation.nextIndex]
  const retainedNextIndex = nextMemberUserId
    ? memberUserIds.indexOf(nextMemberUserId)
    : -1
  const nextIndex = memberUserIds.length === 0
    ? 0
    : retainedNextIndex >= 0
      ? retainedNextIndex
      : rotation.nextIndex % memberUserIds.length

  return {
    ...rotation,
    memberUserIds: [...memberUserIds],
    nextIndex,
  }
}
