import {
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
} from './time-tracking'
import { readTimeEntryCategoryKey } from './time-entry-categories'

/**
 * Built-in work phases, in display order: requirements, design, implementation, review, and
 * evaluation. A Workspace starts with these and may retire them or add its own (ADR 0115).
 */
export const WORK_PHASES = [
  'requirements',
  'design',
  'implementation',
  'review',
  'evaluation',
] as const

/** Key of a built-in work phase. */
export type BuiltInWorkPhase = typeof WORK_PHASES[number]

/**
 * Key of a work phase, such as `implementation` or `review`: a built-in key from
 * {@link WORK_PHASES} or one the Workspace added.
 */
export type WorkPhaseKey = string

/** Report group key for time, runs, and status time that no phase covers. */
export const NO_WORK_PHASE_GROUP_KEY = 'no-phase' as const

/** Most work phases a Workspace may define, active and retired together. */
export const MAX_WORKSPACE_WORK_PHASES = 30

/** Longest display name of a work phase, in characters. */
export const MAX_WORK_PHASE_LABEL_LENGTH = 60

/** Longest work phase key, in characters. */
export const MAX_WORK_PHASE_KEY_LENGTH = 40

/** Most work categories one Workspace may map to phases; the same as the category limit. */
export const MAX_WORK_PHASE_CATEGORY_MAPPINGS = 50

/** One work phase a Workspace offers. */
export type WorkPhaseDefinition = {
  /**
   * Stable key stored on workflow statuses: lowercase letters, digits, and hyphens, starting with a
   * letter. Built-in phases use the keys in {@link WORK_PHASES}.
   */
  key: WorkPhaseKey
  /**
   * Display name. Required for a phase the Workspace added; optional for a built-in one, whose
   * name is otherwise translated by the client.
   */
  label?: string
  /**
   * Whether new mappings may use the phase. A retired phase stays listed so statuses and reports
   * that already use it keep their name.
   */
  active: boolean
}

/** Work phases of a Workspace and which work categories count toward each. */
export type WorkspaceWorkPhaseSettings = {
  /** Phases in display order; at least one is listed. */
  phases: WorkPhaseDefinition[]
  /**
   * Phase of each work category key (ADR 0047), so a time entry's category decides the phase its
   * time counts toward. A category without a phase counts as {@link NO_WORK_PHASE_GROUP_KEY}.
   */
  categoryPhases: Readonly<Record<string, WorkPhaseKey>>
}

/**
 * Phases of a Workspace that has not chosen its own: every built-in phase, active, with the
 * built-in design, implementation, and review categories mapped to the phases of the same name.
 */
export const DEFAULT_WORKSPACE_WORK_PHASE_SETTINGS: WorkspaceWorkPhaseSettings = {
  phases: WORK_PHASES.map((key) => ({ key, active: true })),
  categoryPhases: { design: 'design', implementation: 'implementation', review: 'review' },
}

/** Report group keys that a phase key may not take. */
const RESERVED_WORK_PHASE_KEYS: ReadonlySet<string> = new Set([
  NO_WORK_PHASE_GROUP_KEY,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
])

/** Shape of a work phase key. */
const WORK_PHASE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/u

/**
 * Reports whether a key is one of the built-in work phases.
 *
 * @param key - Phase key.
 * @returns True for a key in {@link WORK_PHASES}.
 */
export function isBuiltInWorkPhase(key: string): key is BuiltInWorkPhase {
  return WORK_PHASES.some((phase) => phase === key)
}

/**
 * Validates the shape of a work phase key, without checking that a Workspace defines it.
 *
 * @param value - Untrusted key.
 * @returns The key, or undefined when it is not a string of lowercase letters, digits, and
 *   hyphens starting with a letter, is too long, or is a reserved report group key.
 */
export function readWorkPhaseKey(value: unknown): WorkPhaseKey | undefined {
  if (
    typeof value !== 'string' ||
    value.length > MAX_WORK_PHASE_KEY_LENGTH ||
    !WORK_PHASE_KEY_PATTERN.test(value) ||
    RESERVED_WORK_PHASE_KEYS.has(value)
  ) {
    return undefined
  }
  return value
}

/**
 * Validates one phase definition.
 *
 * @param value - Untrusted definition.
 * @returns The definition with its label trimmed, or undefined when it is invalid.
 */
function readWorkPhaseDefinition(value: unknown): WorkPhaseDefinition | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const key = readWorkPhaseKey(Reflect.get(value, 'key'))
  const active: unknown = Reflect.get(value, 'active')
  const rawLabel: unknown = Reflect.get(value, 'label')
  if (key === undefined || typeof active !== 'boolean') return undefined
  if (rawLabel !== undefined && typeof rawLabel !== 'string') return undefined
  const label = rawLabel?.trim()
  if (label !== undefined && (label.length === 0 || label.length > MAX_WORK_PHASE_LABEL_LENGTH)) {
    return undefined
  }
  if (label === undefined && !isBuiltInWorkPhase(key)) return undefined
  return { key, ...(label === undefined ? {} : { label }), active }
}

/**
 * Validates the work category to phase map.
 *
 * @param value - Untrusted map.
 * @param phaseKeys - Keys of the phases in the same settings.
 * @returns The map, or undefined when a key is not a category key, a value is not a listed phase,
 *   or the map has too many entries.
 */
function readCategoryPhases(
  value: unknown,
  phaseKeys: ReadonlySet<string>,
): Record<string, WorkPhaseKey> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > MAX_WORK_PHASE_CATEGORY_MAPPINGS) return undefined
  const categoryPhases: Record<string, WorkPhaseKey> = {}
  for (const [category, phase] of entries) {
    if (readTimeEntryCategoryKey(category) === undefined) return undefined
    if (typeof phase !== 'string' || !phaseKeys.has(phase)) return undefined
    categoryPhases[category] = phase
  }
  return categoryPhases
}

/**
 * Validates Workspace work phase settings.
 *
 * Keys must be unique, a phase the Workspace added needs a name, and every category maps to a
 * listed phase. A category may map to a retired phase, so retiring a phase keeps the time already
 * mapped to it.
 *
 * @param value - Untrusted settings.
 * @returns The settings, or undefined when any field is invalid.
 */
export function readWorkspaceWorkPhaseSettings(value: unknown): WorkspaceWorkPhaseSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rawPhases: unknown = Reflect.get(value, 'phases')
  if (!Array.isArray(rawPhases) || rawPhases.length === 0 || rawPhases.length > MAX_WORKSPACE_WORK_PHASES) {
    return undefined
  }
  const phases: WorkPhaseDefinition[] = []
  const seen = new Set<string>()
  for (const rawPhase of rawPhases) {
    const phase = readWorkPhaseDefinition(rawPhase)
    if (!phase || seen.has(phase.key)) return undefined
    seen.add(phase.key)
    phases.push(phase)
  }
  const categoryPhases = readCategoryPhases(Reflect.get(value, 'categoryPhases') ?? {}, seen)
  if (!categoryPhases) return undefined
  return { phases, categoryPhases }
}

/**
 * Lists the phase keys a settings change would drop. Workflow statuses keep the phase key they were
 * saved with, so a phase is retired with `active: false` instead of removed.
 *
 * @param before - Settings in effect before the change.
 * @param after - Requested settings.
 * @returns Keys present before and missing after, in their earlier order.
 */
export function findRemovedWorkPhaseKeys(
  before: WorkspaceWorkPhaseSettings,
  after: WorkspaceWorkPhaseSettings,
): WorkPhaseKey[] {
  const kept = new Set(after.phases.map((phase) => phase.key))
  return before.phases.map((phase) => phase.key).filter((key) => !kept.has(key))
}

/**
 * Resolves the phase a work category counts toward.
 *
 * @param settings - Workspace work phase settings.
 * @param category - Work category key, or undefined for an uncategorized entry.
 * @returns The phase key, or {@link NO_WORK_PHASE_GROUP_KEY} when the category has none.
 */
export function resolveWorkCategoryPhase(
  settings: WorkspaceWorkPhaseSettings,
  category: string | undefined,
): WorkPhaseKey {
  if (category === undefined) return NO_WORK_PHASE_GROUP_KEY
  return Object.hasOwn(settings.categoryPhases, category)
    ? settings.categoryPhases[category] ?? NO_WORK_PHASE_GROUP_KEY
    : NO_WORK_PHASE_GROUP_KEY
}

/**
 * Returns the display label a Workspace gave a phase.
 *
 * @param settings - Workspace work phase settings.
 * @param key - Phase key.
 * @returns The Workspace label, or the key itself for a built-in phase without a label, an unknown
 *   key, or {@link NO_WORK_PHASE_GROUP_KEY}; clients translate the keys they know.
 */
export function readWorkPhaseLabel(settings: WorkspaceWorkPhaseSettings, key: string): string {
  return settings.phases.find((phase) => phase.key === key)?.label ?? key
}
