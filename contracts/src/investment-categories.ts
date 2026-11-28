import {
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
} from './time-tracking'

/**
 * Built-in investment categories, in display order (ADR 0116): new development, enhancement, and
 * maintenance are development (Capex); operations and management are Opex.
 */
export const INVESTMENT_CATEGORIES = [
  'new-development',
  'enhancement',
  'maintenance',
  'operations',
  'management',
] as const

/** Key of a built-in investment category. */
export type BuiltInInvestmentCategory = typeof INVESTMENT_CATEGORIES[number]

/** Accounting group of an investment category: development (Capex) or operations (Opex). */
export type InvestmentGroup = 'capex' | 'opex'

/** Accounting groups in display order. */
export const INVESTMENT_GROUPS: readonly InvestmentGroup[] = ['capex', 'opex']

/** Report group key for time whose Work Item and Project have no investment category. */
export const UNCLASSIFIED_INVESTMENT_GROUP_KEY = 'unclassified' as const

/** Most investment categories a Workspace may define, active and retired together. */
export const MAX_WORKSPACE_INVESTMENT_CATEGORIES = 30

/** Longest display name of an investment category, in characters. */
export const MAX_INVESTMENT_CATEGORY_LABEL_LENGTH = 60

/** Longest investment category key, in characters. */
export const MAX_INVESTMENT_CATEGORY_KEY_LENGTH = 40

/** Working hours that make one person-month when a Workspace has not chosen its own. */
export const DEFAULT_PERSON_MONTH_HOURS = 160

/** Fewest and most working hours a Workspace may count as one person-month. */
export const PERSON_MONTH_HOURS_RANGE = { min: 1, max: 744 } as const

/** Most Projects one Team may give a default investment category. */
export const MAX_TEAM_PROJECT_INVESTMENT_CATEGORIES = 200

/** Most Work Items one Team may give their own investment category. */
export const MAX_TEAM_WORK_ITEM_INVESTMENT_CATEGORIES = 800

/** One investment category a Workspace offers. */
export type InvestmentCategoryDefinition = {
  /**
   * Stable key stored on Project and Work Item assignments: lowercase letters, digits, and hyphens,
   * starting with a letter. Built-in categories use the keys in {@link INVESTMENT_CATEGORIES}.
   */
  key: string
  /** Display name; required for a category the Workspace added, optional for a built-in one. */
  label?: string
  /** Accounting group the category's time counts toward. */
  group: InvestmentGroup
  /** Whether new assignments may use the category; a retired one stays listed for its name. */
  active: boolean
}

/** Investment categories of a Workspace and the hours that make a person-month. */
export type WorkspaceInvestmentCategorySettings = {
  /** Categories in display order; at least one is listed. */
  categories: InvestmentCategoryDefinition[]
  /** Working hours counted as one person-month in reports. */
  personMonthHours: number
}

/** Group of each built-in category. */
const BUILT_IN_GROUPS: Readonly<Record<BuiltInInvestmentCategory, InvestmentGroup>> = {
  'new-development': 'capex',
  enhancement: 'capex',
  maintenance: 'capex',
  operations: 'opex',
  management: 'opex',
}

/** Settings of a Workspace that has not chosen its own: the five built-in categories, 160 hours a month. */
export const DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS: WorkspaceInvestmentCategorySettings = {
  categories: INVESTMENT_CATEGORIES.map((key) => ({ key, group: BUILT_IN_GROUPS[key], active: true })),
  personMonthHours: DEFAULT_PERSON_MONTH_HOURS,
}

/** Investment categories a Team gave its Projects and Work Items. */
export type TeamInvestmentAssignments = {
  /** Default category of each Project, keyed by Project ID. */
  projects: Readonly<Record<string, string>>
  /** Category of each Work Item that overrides its Project's, keyed by Work Item ID. */
  workItems: Readonly<Record<string, string>>
}

/** A Team's saved assignments with their revision, as the assignment API returns them. */
export type TeamInvestmentAssignmentsRecord = TeamInvestmentAssignments & {
  /** Team identifier. */
  teamId: string
  /** Optimistic concurrency revision; 0 while the Team has saved none. */
  revision: number
  /** When the assignments were last saved; absent while the Team has saved none. */
  updatedAt?: string
}

/** Report group keys that a category key may not take. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  UNCLASSIFIED_INVESTMENT_GROUP_KEY,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
  ...INVESTMENT_GROUPS,
])

/** Shape of an investment category key. */
const KEY_PATTERN = /^[a-z][a-z0-9-]*$/u

/**
 * Shape of a Project or Work Item identifier in an assignment map: 1 to 128 visible characters, so
 * a full map stays well inside one stored record.
 */
const ASSIGNMENT_ID_PATTERN = /^[^\s\p{Cc}]{1,128}$/u

/** Identifiers that would change an object's prototype instead of naming an entry. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Reports whether a key is one of the built-in investment categories.
 *
 * @param key - Category key.
 * @returns True for a key in {@link INVESTMENT_CATEGORIES}.
 */
export function isBuiltInInvestmentCategory(key: string): key is BuiltInInvestmentCategory {
  return INVESTMENT_CATEGORIES.some((category) => category === key)
}

/**
 * Validates the shape of an investment category key, without checking that a Workspace defines it.
 *
 * @param value - Untrusted key.
 * @returns The key, or undefined when it is malformed, too long, or a reserved report group key.
 */
export function readInvestmentCategoryKey(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > MAX_INVESTMENT_CATEGORY_KEY_LENGTH ||
    !KEY_PATTERN.test(value) ||
    RESERVED_KEYS.has(value)
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
function readDefinition(value: unknown): InvestmentCategoryDefinition | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const key = readInvestmentCategoryKey(Reflect.get(value, 'key'))
  const group: unknown = Reflect.get(value, 'group')
  const active: unknown = Reflect.get(value, 'active')
  const rawLabel: unknown = Reflect.get(value, 'label')
  if (key === undefined || (group !== 'capex' && group !== 'opex') || typeof active !== 'boolean') return undefined
  if (rawLabel !== undefined && typeof rawLabel !== 'string') return undefined
  const label = rawLabel?.trim()
  if (label !== undefined && (label.length === 0 || label.length > MAX_INVESTMENT_CATEGORY_LABEL_LENGTH)) return undefined
  if (label === undefined && !isBuiltInInvestmentCategory(key)) return undefined
  return { key, ...(label === undefined ? {} : { label }), group, active }
}

/**
 * Validates Workspace investment category settings: unique keys, a name for every added category,
 * at least one active category, and whole person-month hours from 1 to 744.
 *
 * @param value - Untrusted settings.
 * @returns The settings, or undefined when any field is invalid.
 */
export function readWorkspaceInvestmentCategorySettings(value: unknown): WorkspaceInvestmentCategorySettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rawCategories: unknown = Reflect.get(value, 'categories')
  const personMonthHours: unknown = Reflect.get(value, 'personMonthHours')
  if (
    !Array.isArray(rawCategories) ||
    rawCategories.length === 0 ||
    rawCategories.length > MAX_WORKSPACE_INVESTMENT_CATEGORIES ||
    typeof personMonthHours !== 'number' ||
    !Number.isInteger(personMonthHours) ||
    personMonthHours < PERSON_MONTH_HOURS_RANGE.min ||
    personMonthHours > PERSON_MONTH_HOURS_RANGE.max
  ) {
    return undefined
  }
  const categories: InvestmentCategoryDefinition[] = []
  const seen = new Set<string>()
  for (const raw of rawCategories) {
    const category = readDefinition(raw)
    if (!category || seen.has(category.key)) return undefined
    seen.add(category.key)
    categories.push(category)
  }
  if (!categories.some((category) => category.active)) return undefined
  return { categories, personMonthHours }
}

/**
 * Lists the category keys a settings change would drop. Assignments keep the key they were saved
 * with, so a category is retired with `active: false` instead of removed.
 *
 * @param before - Settings in effect before the change.
 * @param after - Requested settings.
 * @returns Keys present before and missing after, in their earlier order.
 */
export function findRemovedInvestmentCategoryKeys(
  before: WorkspaceInvestmentCategorySettings,
  after: WorkspaceInvestmentCategorySettings,
): string[] {
  const kept = new Set(after.categories.map((category) => category.key))
  return before.categories.map((category) => category.key).filter((key) => !kept.has(key))
}

/**
 * Validates one assignment map.
 *
 * @param value - Untrusted map of identifier to category key.
 * @param limit - Most entries allowed.
 * @returns The map, or undefined when an identifier or key is malformed or the map is too large.
 */
function readAssignmentMap(value: unknown, limit: number): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > limit) return undefined
  const result: Record<string, string> = {}
  for (const [id, key] of entries) {
    if (typeof key !== 'string' || !ASSIGNMENT_ID_PATTERN.test(id) || PROTOTYPE_KEYS.has(id) || readInvestmentCategoryKey(key) === undefined) return undefined
    result[id] = key
  }
  return result
}

/**
 * Validates a Team's assignments. Only the shape is checked here; the API also checks that each
 * newly assigned key is an active category of the Workspace.
 *
 * @param value - Untrusted assignments.
 * @returns The assignments, or undefined when either map is invalid.
 */
export function readTeamInvestmentAssignments(value: unknown): TeamInvestmentAssignments | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const projects = readAssignmentMap(Reflect.get(value, 'projects'), MAX_TEAM_PROJECT_INVESTMENT_CATEGORIES)
  const workItems = readAssignmentMap(Reflect.get(value, 'workItems'), MAX_TEAM_WORK_ITEM_INVESTMENT_CATEGORIES)
  if (!projects || !workItems) return undefined
  return { projects, workItems }
}

/**
 * Resolves the investment category of a time entry: its Work Item's own category first, then its
 * Project's default.
 *
 * @param assignments - Team assignments.
 * @param entry - Work Item and Project of the entry.
 * @param entry.workItemId - Work Item of the entry, if any.
 * @param entry.projectId - Project of the entry, if any.
 * @returns The category key, or {@link UNCLASSIFIED_INVESTMENT_GROUP_KEY}.
 */
export function resolveInvestmentCategory(
  assignments: TeamInvestmentAssignments,
  entry: { workItemId?: string; projectId?: string },
): string {
  if (entry.workItemId !== undefined && Object.hasOwn(assignments.workItems, entry.workItemId)) {
    return assignments.workItems[entry.workItemId] ?? UNCLASSIFIED_INVESTMENT_GROUP_KEY
  }
  if (entry.projectId !== undefined && Object.hasOwn(assignments.projects, entry.projectId)) {
    return assignments.projects[entry.projectId] ?? UNCLASSIFIED_INVESTMENT_GROUP_KEY
  }
  return UNCLASSIFIED_INVESTMENT_GROUP_KEY
}

/**
 * Returns the accounting group of a category.
 *
 * @param settings - Workspace settings.
 * @param key - Category key.
 * @returns The group, or undefined for an unknown key or {@link UNCLASSIFIED_INVESTMENT_GROUP_KEY}.
 */
export function readInvestmentGroup(
  settings: WorkspaceInvestmentCategorySettings,
  key: string,
): InvestmentGroup | undefined {
  return settings.categories.find((category) => category.key === key)?.group
}
