import type { ImportRowError } from '@mukuroji/contracts'

/** Workspace member as the import matches people written in a source file. */
export type WorkItemImportMember = {
  /** Member key, which is also the user ID a Work Item stores. */
  memberKey: string
  /** Display name, if the member set one. */
  name?: string
}

/** Owner and contributors of one mapped import row. */
export type WorkItemImportPeople = {
  /** Accountable owner as written. */
  assigneeUserId: string
  /** Contributors as written. */
  contributorAssignments?: ReadonlyArray<{ memberUserId?: string }>
}

/** Field and person that could not be matched to one member. */
export type WorkItemImportMemberMismatch = {
  /** Import field that names the person. */
  field: 'assigneeUserId' | 'contributors'
  /** Value as written. */
  value: string
  /** Whether more than one member has that display name. */
  ambiguous: boolean
}

/**
 * Reports whether a row names a person by display name rather than by user ID.
 *
 * A user ID is the member's e-mail address, so a value without `@` is a display name.
 *
 * @param people - Owner and contributors of the row.
 * @returns Whether reading the Workspace members is needed to match the row.
 */
export function namesImportMemberByDisplayName(people: WorkItemImportPeople) {
  return [people.assigneeUserId, ...(people.contributorAssignments ?? []).map((entry) => entry.memberUserId)]
    .some((value) => value !== undefined && !value.includes('@'))
}

/**
 * Creates the matcher that turns a written person into a member's user ID.
 *
 * An e-mail address is the user ID in lower case. Any other value is a display name, compared
 * without case, surrounding spaces, or width differences; it matches only when exactly one active
 * member has that name.
 *
 * @param members - Active Workspace members; left out when no row names a person by display name.
 * @returns The matcher, which returns the user ID or the reason it found none.
 */
export function createWorkItemImportMemberMatcher(members: readonly WorkItemImportMember[] = []) {
  const keysByName = new Map<string, string[]>()
  for (const member of members) {
    if (!member.name) continue
    const name = normalizeDisplayName(member.name)
    keysByName.set(name, [...(keysByName.get(name) ?? []), member.memberKey])
  }
  return (value: string): { userId: string } | { ambiguous: boolean } => {
    const written = value.trim()
    if (written.includes('@')) return { userId: written.toLowerCase() }
    const keys = keysByName.get(normalizeDisplayName(written)) ?? []
    return keys.length === 1 ? { userId: keys[0]! } : { ambiguous: keys.length > 1 }
  }
}

/**
 * Replaces the people of a row with the user IDs they match.
 *
 * @param people - Owner and contributors as written.
 * @param match - Matcher from {@link createWorkItemImportMemberMatcher}.
 * @returns The row with user IDs, or the people that matched no single member.
 */
export function matchWorkItemImportPeople<T extends WorkItemImportPeople>(
  people: T,
  match: ReturnType<typeof createWorkItemImportMemberMatcher>,
): { people: T } | { mismatches: WorkItemImportMemberMismatch[] } {
  const mismatches: WorkItemImportMemberMismatch[] = []
  /** Matches one written person and records a mismatch. */
  const read = (field: WorkItemImportMemberMismatch['field'], value: string) => {
    const result = match(value)
    if ('userId' in result) return result.userId
    mismatches.push({ field, value, ambiguous: result.ambiguous })
    return value
  }
  const assigneeUserId = read('assigneeUserId', people.assigneeUserId)
  const contributorAssignments = people.contributorAssignments?.map((entry) =>
    entry.memberUserId === undefined ? entry : { ...entry, memberUserId: read('contributors', entry.memberUserId) })
  if (mismatches.length > 0) return { mismatches }
  return {
    people: {
      ...people,
      assigneeUserId,
      ...(contributorAssignments === undefined ? {} : { contributorAssignments }),
    },
  }
}

/**
 * Builds the row error for a person that matched no single member.
 *
 * @param row - One-based data row number.
 * @param mismatch - Unmatched person.
 * @returns The row error.
 */
export function toWorkItemImportMemberError(row: number, mismatch: WorkItemImportMemberMismatch): ImportRowError {
  return {
    row,
    field: mismatch.field,
    code: mismatch.ambiguous ? 'ImportMemberAmbiguous' : 'ImportMemberUnknown',
    message: mismatch.ambiguous
      ? `More than one Workspace member is named "${mismatch.value}"; write their e-mail address instead.`
      : `No active Workspace member has the e-mail address or name "${mismatch.value}".`,
  }
}

/**
 * Normalizes a display name for comparison.
 *
 * @param value - Display name.
 * @returns Name without surrounding spaces, width differences, case, or repeated spaces.
 */
function normalizeDisplayName(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
}
