/** Display languages a member can save as a preference. */
export const MEMBER_PREFERENCE_LOCALES = ['ja', 'en'] as const

/** Color themes a member can save as a preference. */
export const MEMBER_PREFERENCE_THEMES = ['light', 'dark', 'system'] as const

/** Font sizes a member can save as a preference. */
export const MEMBER_PREFERENCE_FONT_SIZES = ['compact', 'standard', 'comfortable'] as const

/** Longest IANA time zone name accepted in a member preference. */
export const MEMBER_PREFERENCE_TIME_ZONE_MAX_LENGTH = 64

/** Largest revision that may be retained in a member preference. */
export const MEMBER_PREFERENCES_MAX_REVISION = Number.MAX_SAFE_INTEGER - 1

/** Display language saved for a member. */
export type MemberPreferenceLocale = (typeof MEMBER_PREFERENCE_LOCALES)[number]

/** Color theme saved for a member. */
export type MemberPreferenceTheme = (typeof MEMBER_PREFERENCE_THEMES)[number]

/** Font size saved for a member. */
export type MemberPreferenceFontSize = (typeof MEMBER_PREFERENCE_FONT_SIZES)[number]

/**
 * Display preferences a member saves on the server so that every device starts with them.
 *
 * Each field is absent until the member chooses a value; clients then keep their own default.
 */
export type MemberPreferenceValues = {
  /** Display language. */
  locale?: MemberPreferenceLocale
  /** IANA time zone name, such as `Asia/Tokyo`. */
  timeZone?: string
  /** Color theme. */
  theme?: MemberPreferenceTheme
  /** Font size. */
  fontSize?: MemberPreferenceFontSize
}

/** Versioned display preferences returned to the authenticated member. */
export type MemberPreferences = MemberPreferenceValues & {
  /** Compare-and-swap revision; 0 means nothing has been saved yet. */
  revision: number
}

/** Input that replaces the authenticated member's complete display preferences. */
export type UpdateMemberPreferencesInput = MemberPreferenceValues & {
  /** Revision read before constructing this update. */
  revision: number
}
