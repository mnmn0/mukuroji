import {
  MAX_WORKSPACE_WORK_PHASES,
  NO_WORK_PHASE_GROUP_KEY,
  isBuiltInWorkPhase,
  readWorkspaceWorkPhaseSettings,
  type BuiltInWorkPhase,
  type WorkPhaseDefinition,
  type WorkspaceWorkPhaseSettings,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Translated name of each built-in work phase. */
const builtInPhaseLabelKeys = {
  requirements: 'workspace.workPhase.requirements',
  design: 'workspace.workPhase.design',
  implementation: 'workspace.workPhase.implementation',
  review: 'workspace.workPhase.review',
  evaluation: 'workspace.workPhase.evaluation',
} as const satisfies Record<BuiltInWorkPhase, MessageKey>

/**
 * Returns the display name of a work phase (ADR 0115).
 *
 * @param key - Phase key, or `no-phase`.
 * @param settings - Workspace phases, when loaded.
 * @param t - Translator.
 * @returns The Workspace name, the translated built-in name, or the key.
 */
export function readWorkPhaseDisplayName(
  key: string,
  settings: WorkspaceWorkPhaseSettings | undefined,
  t: (key: MessageKey) => string,
): string {
  if (key === NO_WORK_PHASE_GROUP_KEY) return t('workspace.workPhase.none')
  const label = settings?.phases.find((phase) => phase.key === key)?.label
  if (label) return label
  return isBuiltInWorkPhase(key) ? t(builtInPhaseLabelKeys[key]) : key
}

/**
 * Reports whether edited work phases would be refused by the server.
 *
 * @param settings - Edited settings.
 * @returns True when the settings cannot be saved.
 */
export function hasWorkPhaseProblem(settings: WorkspaceWorkPhaseSettings): boolean {
  return readWorkspaceWorkPhaseSettings(settings) === undefined
}

/**
 * Appends a Workspace-defined phase with a generated key, since names may be in any script while
 * keys are limited to ASCII.
 *
 * @param settings - Edited settings.
 * @param label - Name of the new phase.
 * @param createKeySuffix - Returns a random suffix; injectable for tests.
 * @returns The settings with the new active phase last, or unchanged when the name is blank or the
 *   Workspace already has the most phases allowed.
 */
export function addWorkPhase(
  settings: WorkspaceWorkPhaseSettings,
  label: string,
  createKeySuffix: () => string = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12),
): WorkspaceWorkPhaseSettings {
  const name = label.trim()
  if (name.length === 0 || settings.phases.length >= MAX_WORKSPACE_WORK_PHASES) return settings
  const phase: WorkPhaseDefinition = { key: `custom-${createKeySuffix()}`, label: name, active: true }
  return { ...settings, phases: [...settings.phases, phase] }
}

/**
 * Sets or clears the phase a work category counts toward.
 *
 * @param settings - Edited settings.
 * @param category - Work category key.
 * @param phaseKey - Phase key, or an empty string for no phase.
 * @returns The edited settings.
 */
export function setWorkCategoryPhase(
  settings: WorkspaceWorkPhaseSettings,
  category: string,
  phaseKey: string,
): WorkspaceWorkPhaseSettings {
  const categoryPhases = Object.fromEntries(Object.entries(settings.categoryPhases).filter(([key]) => key !== category))
  return { ...settings, categoryPhases: phaseKey === '' ? categoryPhases : { ...categoryPhases, [category]: phaseKey } }
}
