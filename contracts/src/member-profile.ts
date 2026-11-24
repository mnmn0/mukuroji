/** Longest display name a Workspace member can set, after trimming. */
export const MEMBER_DISPLAY_NAME_MAX_LENGTH = 128

/** A signed-in member's own profile, as `GET /api/me/profile` returns it. */
export type MemberProfile = {
  /** Stable key of the member in the Workspace. */
  memberKey: string
  /** Email address of the member. */
  email: string
  /** Display name, or undefined when the member is shown by email. */
  name?: string
  /** Whether the display name can be changed here; a directory (SCIM) member's name comes from the directory. */
  nameEditable: boolean
  /** Member version that a name change must send as `expectedVersion`. */
  version: number
}

/** Response of `GET` and `PUT /api/me/profile`. */
export type MemberProfileResponse = {
  /** The signed-in member's profile. */
  profile: MemberProfile
}

/** Request body that changes a member's display name. */
export type UpdateMemberDisplayNameRequest = {
  /** New display name; an empty string or null removes it so the member is shown by email. */
  name: string | null
  /** Member version read before the change. */
  expectedVersion: number
}

/** Result of reading a display name from a request. */
export type MemberDisplayNameReadResult =
  | {
      /** The name is acceptable. */
      ok: true
      /** Trimmed name, or undefined to remove the name. */
      name: string | undefined
    }
  | {
      /** The name is rejected. */
      ok: false
    }

/**
 * Reads a display name from a request, trimming it.
 *
 * It accepts a string of at most {@link MEMBER_DISPLAY_NAME_MAX_LENGTH} characters without
 * control characters, which would break emails and the member CSV export. A blank string or
 * null removes the name.
 *
 * @param value - Raw `name` of the request body.
 * @returns The trimmed name, or a rejection.
 */
export function readMemberDisplayName(value: unknown): MemberDisplayNameReadResult {
  if (value === null) return { ok: true, name: undefined }
  if (typeof value !== 'string') return { ok: false }
  const name = value.trim()
  if (name.length === 0) return { ok: true, name: undefined }
  if (name.length > MEMBER_DISPLAY_NAME_MAX_LENGTH || /\p{Cc}/u.test(name)) return { ok: false }
  return { ok: true, name }
}
