import type { TriageOwnerRotation, TriageOwnerStrategy } from '../api/types'

/** Parses compact owner-strategy text without accepting malformed non-empty input.
 *
 * @param value Editable owner-strategy text.
 * @returns A supported owner strategy, or undefined when non-empty text is malformed.
 */
export function parseOwnerStrategy(value: string): TriageOwnerStrategy | undefined {
  const normalized = value.trim()
  if (!normalized || normalized === 'unowned') return { type: 'unowned' }
  const [type, ...rest] = normalized.split(':')
  const identifier = rest.join(':').trim()
  if (type === 'fixed' && identifier) return { ownerUserId: identifier, type: 'fixed' }
  if (type === 'rotation' && identifier) return { rotationId: identifier, type: 'rotation' }
  return undefined
}

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
