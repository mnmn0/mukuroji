import type { TimeEntryCategory, WorkspaceTimeEntryCategorySettings } from '@mukuroji/contracts'

/**
 * Lists the categories a form offers: every active one, plus the entry's current category when it
 * has been retired, so editing an older entry does not silently change its category.
 *
 * @param settings - Workspace work categories.
 * @param current - Category the edited entry already has, if any.
 * @returns Category keys in display order.
 */
export function selectSelectableTimeEntryCategories(
  settings: WorkspaceTimeEntryCategorySettings,
  current?: TimeEntryCategory,
): TimeEntryCategory[] {
  const keys = settings.categories
    .filter((category) => category.active || category.key === current)
    .map((category) => category.key)
  return current === undefined || keys.includes(current) ? keys : [...keys, current]
}
