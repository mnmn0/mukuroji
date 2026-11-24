import { createContext, useContext } from 'react'
import {
  DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS,
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
