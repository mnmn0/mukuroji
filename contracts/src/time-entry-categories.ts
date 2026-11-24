import {
  type BuiltInTimeEntryCategory,
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
  TIME_ENTRY_CATEGORIES,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
  type TimeEntryCategory,
} from './time-tracking'

/** Most work categories a Workspace may define, active and retired together. */
export const MAX_WORKSPACE_TIME_ENTRY_CATEGORIES = 50

/** Longest display name of a work category, in characters. */
export const MAX_TIME_ENTRY_CATEGORY_LABEL_LENGTH = 60

/** Longest work category key, in characters. */
export const MAX_TIME_ENTRY_CATEGORY_KEY_LENGTH = 40

/** One work category a Workspace offers for time entries. */
export type TimeEntryCategoryDefinition = {
  /**
   * Stable key stored on time entries: lowercase letters, digits, and hyphens, starting with a
   * letter. Built-in categories use the keys in {@link TIME_ENTRY_CATEGORIES}.
   */
  key: TimeEntryCategory
  /**
   * Display name. Required for a category the Workspace added; optional for a built-in one, whose
   * name is otherwise translated by the client.
   */
  label?: string
  /**
   * Whether new entries may use the category. A retired category stays listed so the entries and
   * weekly reports that already use it keep their name.
   */
  active: boolean
}

/** Work categories a Workspace offers, in display order. */
export type WorkspaceTimeEntryCategorySettings = {
  /** Categories in display order; at least one is active. */
  categories: TimeEntryCategoryDefinition[]
}

/** Categories of a Workspace that has not chosen its own: every built-in category, active. */
export const DEFAULT_WORKSPACE_TIME_ENTRY_CATEGORY_SETTINGS: WorkspaceTimeEntryCategorySettings = {
  categories: TIME_ENTRY_CATEGORIES.map((key) => ({ key, active: true })),
}

/** Report group keys that a category key may not take. */
const RESERVED_TIME_ENTRY_CATEGORY_KEYS: ReadonlySet<string> = new Set([
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
])

/** Shape of a work category key. */
const TIME_ENTRY_CATEGORY_KEY_PATTERN = /^[a-z][a-z0-9-]*$/u

/**
 * Reports whether a key is one of the built-in work categories.
 *
 * @param key - Category key.
 * @returns True for a key in {@link TIME_ENTRY_CATEGORIES}.
 */
export function isBuiltInTimeEntryCategory(key: string): key is BuiltInTimeEntryCategory {
  return TIME_ENTRY_CATEGORIES.some((category) => category === key)
}

/**
 * Validates the shape of a work category key, without checking that a Workspace defines it.
 *
 * @param value - Untrusted key.
 * @returns The key, or undefined when it is not a string of lowercase letters, digits, and
 *   hyphens starting with a letter, is too long, or is a reserved report group key.
 */
export function readTimeEntryCategoryKey(value: unknown): TimeEntryCategory | undefined {
  if (
    typeof value !== 'string' ||
    value.length > MAX_TIME_ENTRY_CATEGORY_KEY_LENGTH ||
    !TIME_ENTRY_CATEGORY_KEY_PATTERN.test(value) ||
    RESERVED_TIME_ENTRY_CATEGORY_KEYS.has(value)
  ) {
    return undefined
  }
  return value
}

/**
 * Validates one category definition.
 *
 * @param value - Untrusted definition.
 * @returns The definition with its label trimmed, or undefined when it is invalid.
 */
function readTimeEntryCategoryDefinition(value: unknown): TimeEntryCategoryDefinition | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const key = readTimeEntryCategoryKey(Reflect.get(value, 'key'))
  const active: unknown = Reflect.get(value, 'active')
  const rawLabel: unknown = Reflect.get(value, 'label')
  if (key === undefined || typeof active !== 'boolean') return undefined
  if (rawLabel !== undefined && typeof rawLabel !== 'string') return undefined
  const label = rawLabel?.trim()
  if (label !== undefined && (label.length === 0 || label.length > MAX_TIME_ENTRY_CATEGORY_LABEL_LENGTH)) {
    return undefined
  }
  if (label === undefined && !isBuiltInTimeEntryCategory(key)) return undefined
  return { key, ...(label === undefined ? {} : { label }), active }
}

/**
 * Validates Workspace work category settings.
 *
 * Keys must be unique, a category the Workspace added needs a name, and at least one category
 * must stay active.
 *
 * @param value - Untrusted settings.
 * @returns The settings, or undefined when any field is invalid.
 */
export function readWorkspaceTimeEntryCategorySettings(
  value: unknown,
): WorkspaceTimeEntryCategorySettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rawCategories: unknown = Reflect.get(value, 'categories')
  if (
    !Array.isArray(rawCategories) ||
    rawCategories.length === 0 ||
    rawCategories.length > MAX_WORKSPACE_TIME_ENTRY_CATEGORIES
  ) {
    return undefined
  }
  const categories: TimeEntryCategoryDefinition[] = []
  const seen = new Set<string>()
  for (const rawCategory of rawCategories) {
    const category = readTimeEntryCategoryDefinition(rawCategory)
    if (!category || seen.has(category.key)) return undefined
    seen.add(category.key)
    categories.push(category)
  }
  if (!categories.some((category) => category.active)) return undefined
  return { categories }
}

/**
 * Lists the keys a settings change would drop. Entries and weekly reports keep the keys they were
 * saved with, so a category is retired with `active: false` instead of removed.
 *
 * @param before - Settings in effect before the change.
 * @param after - Requested settings.
 * @returns Keys present before and missing after, in their earlier order.
 */
export function findRemovedTimeEntryCategoryKeys(
  before: WorkspaceTimeEntryCategorySettings,
  after: WorkspaceTimeEntryCategorySettings,
): TimeEntryCategory[] {
  const kept = new Set(after.categories.map((category) => category.key))
  return before.categories
    .map((category) => category.key)
    .filter((key) => !kept.has(key))
}

/**
 * Reports whether new entries may use a category.
 *
 * @param settings - Workspace work category settings.
 * @param key - Category key.
 * @returns True when the Workspace defines the key and it is active.
 */
export function isActiveTimeEntryCategory(
  settings: WorkspaceTimeEntryCategorySettings,
  key: string,
): boolean {
  return settings.categories.some((category) => category.key === key && category.active)
}
