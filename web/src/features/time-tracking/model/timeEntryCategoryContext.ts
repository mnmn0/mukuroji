import { createContext, useContext } from 'react'
import {
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
  type TimeEntryCategory,
  type WorkspaceTimeEntryCategorySettings,
} from '@mukuroji/contracts'

/**
 * Workspace work categories shown by the time tracking views. Views outside a provider, and views
 * whose read has not landed, see the built-in categories.
 */
export const TimeEntryCategoryContext = createContext<WorkspaceTimeEntryCategorySettings>(
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
)

/**
 * Reads the Workspace work categories from the nearest provider.
 *
 * @returns Work categories, active and retired.
 */
export function useTimeEntryCategories(): WorkspaceTimeEntryCategorySettings {
  return useContext(TimeEntryCategoryContext)
}

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
