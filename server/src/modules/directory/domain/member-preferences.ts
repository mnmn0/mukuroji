import {
  MEMBER_PREFERENCE_FONT_SIZES,
  MEMBER_PREFERENCE_LOCALES,
  MEMBER_PREFERENCE_THEMES,
  MEMBER_PREFERENCE_TIME_ZONE_MAX_LENGTH,
  MEMBER_PREFERENCES_MAX_REVISION,
  type MemberPreferenceFontSize,
  type MemberPreferenceLocale,
  type MemberPreferenceTheme,
  type MemberPreferenceValues,
  type UpdateMemberPreferencesInput,
} from '@mukuroji/contracts'

/** Characters an IANA time zone name may contain, such as `America/Argentina/Buenos_Aires`. */
const timeZonePattern = /^[A-Za-z][A-Za-z0-9_+\-/]*$/u

/**
 * Checks whether a value is a saved display language.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a supported locale.
 */
export function isMemberPreferenceLocale(value: unknown): value is MemberPreferenceLocale {
  return MEMBER_PREFERENCE_LOCALES.some((locale) => locale === value)
}

/**
 * Checks whether a value is a saved color theme.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a supported theme.
 */
export function isMemberPreferenceTheme(value: unknown): value is MemberPreferenceTheme {
  return MEMBER_PREFERENCE_THEMES.some((theme) => theme === value)
}

/**
 * Checks whether a value is a saved font size.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a supported font size.
 */
export function isMemberPreferenceFontSize(value: unknown): value is MemberPreferenceFontSize {
  return MEMBER_PREFERENCE_FONT_SIZES.some((fontSize) => fontSize === value)
}

/**
 * Checks whether a value is an IANA time zone name the runtime recognizes.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a bounded, known time zone name.
 */
export function isMemberPreferenceTimeZone(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MEMBER_PREFERENCE_TIME_ZONE_MAX_LENGTH ||
    !timeZonePattern.test(value)
  ) {
    return false
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Checks whether a value is a revision a stored or requested preference may carry.
 *
 * @param value - Candidate revision.
 * @returns Whether the value is a non-negative safe integer within the revision bound.
 */
export function isMemberPreferencesRevision(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MEMBER_PREFERENCES_MAX_REVISION
}

/**
 * Reads the optional preference fields from an untrusted record.
 *
 * Absent and `null` fields mean "not chosen"; any other invalid value rejects the whole input.
 *
 * @param value - Candidate record from a request body or a stored row.
 * @returns The validated values, or undefined when any present field is invalid.
 */
export function readMemberPreferenceValues(
  value: Readonly<Record<string, unknown>>,
): MemberPreferenceValues | undefined {
  const { fontSize, locale, theme, timeZone } = value
  if (
    (locale != null && !isMemberPreferenceLocale(locale)) ||
    (theme != null && !isMemberPreferenceTheme(theme)) ||
    (fontSize != null && !isMemberPreferenceFontSize(fontSize)) ||
    (timeZone != null && !isMemberPreferenceTimeZone(timeZone))
  ) {
    return undefined
  }
  return {
    ...(isMemberPreferenceLocale(locale) ? { locale } : {}),
    ...(isMemberPreferenceTimeZone(timeZone) ? { timeZone } : {}),
    ...(isMemberPreferenceTheme(theme) ? { theme } : {}),
    ...(isMemberPreferenceFontSize(fontSize) ? { fontSize } : {}),
  }
}

/**
 * Parses a complete preference replacement request.
 *
 * @param value - Unknown JSON request body.
 * @returns The validated replacement, or undefined when the body is invalid.
 */
export function readUpdateMemberPreferencesInput(
  value: unknown,
): UpdateMemberPreferencesInput | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const revision = value.revision
  if (!isMemberPreferencesRevision(revision) || revision >= MEMBER_PREFERENCES_MAX_REVISION) {
    return undefined
  }
  const values = readMemberPreferenceValues(value)
  return values ? { ...values, revision } : undefined
}

/**
 * Compares two sets of preference values.
 *
 * @param first - First values.
 * @param second - Second values.
 * @returns Whether every field holds the same value.
 */
export function memberPreferenceValuesEqual(
  first: MemberPreferenceValues,
  second: MemberPreferenceValues,
): boolean {
  return first.locale === second.locale &&
    first.timeZone === second.timeZone &&
    first.theme === second.theme &&
    first.fontSize === second.fontSize
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
