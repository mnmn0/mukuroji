/**
 * Picks the quiet hours time zone when quiet hours are turned on or off.
 *
 * Unsaved settings start at UTC, which is rarely the member's time zone, so turning quiet hours
 * on before anything is saved uses the member's display time zone instead. A saved UTC is kept,
 * since the member may have chosen it.
 *
 * @param current - Time zone in the draft.
 * @param enabled - Whether quiet hours are being turned on.
 * @param memberTimeZone - Member's display time zone, when known.
 * @param neverSaved - Whether the member has never saved notification settings.
 * @returns Time zone to keep in the draft.
 */
export function resolveQuietHoursTimeZone(
  current: string,
  enabled: boolean,
  memberTimeZone: string | undefined,
  neverSaved: boolean,
): string {
  return enabled && neverSaved && current === 'UTC' && memberTimeZone ? memberTimeZone : current
}
