import {
  MAX_WORKSPACE_TIME_ENTRY_CATEGORIES,
  readWorkspaceTimeEntryCategorySettings,
  type TimeEntryCategoryDefinition,
  type WorkspaceTimeEntryCategorySettings,
} from '@mukuroji/contracts'

/**
 * Reports whether edited work categories would be refused by the server: a new category without a
 * name, a name that is too long, or no active category.
 *
 * @param settings - Edited settings.
 * @returns True when the settings cannot be saved.
 */
export function hasTimeEntryCategoryProblem(settings: WorkspaceTimeEntryCategorySettings): boolean {
  return readWorkspaceTimeEntryCategorySettings(settings) === undefined
}

/**
 * Appends a Workspace-defined category with a generated key, since names may be in any script
 * while keys are limited to ASCII.
 *
 * @param settings - Edited settings.
 * @param label - Name of the new category.
 * @param createKeySuffix - Returns a random suffix; injectable for tests.
 * @returns The settings with the new active category last, or unchanged when the name is blank
 *   or the Workspace already has the most categories allowed.
 */
export function addTimeEntryCategory(
  settings: WorkspaceTimeEntryCategorySettings,
  label: string,
  createKeySuffix: () => string = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12),
): WorkspaceTimeEntryCategorySettings {
  const name = label.trim()
  if (name.length === 0 || settings.categories.length >= MAX_WORKSPACE_TIME_ENTRY_CATEGORIES) return settings
  const category: TimeEntryCategoryDefinition = { key: `custom-${createKeySuffix()}`, label: name, active: true }
  return { categories: [...settings.categories, category] }
}

/**
 * Moves one category up or down in the display order.
 *
 * @param settings - Edited settings.
 * @param index - Position of the category to move.
 * @param offset - `-1` to move up, `1` to move down.
 * @returns The reordered settings, or unchanged when the move would leave the list.
 */
export function moveTimeEntryCategory(
  settings: WorkspaceTimeEntryCategorySettings,
  index: number,
  offset: -1 | 1,
): WorkspaceTimeEntryCategorySettings {
  const target = index + offset
  const moving = settings.categories[index]
  const other = settings.categories[target]
  if (moving === undefined || other === undefined) return settings
  const categories = [...settings.categories]
  categories[index] = other
  categories[target] = moving
  return { categories }
}
