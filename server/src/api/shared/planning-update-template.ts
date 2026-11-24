import {
  DEFAULT_PLANNING_UPDATE_TEMPLATE_SETTINGS,
  listMissingPlanningUpdateFields,
  type PlanningUpdateTemplateSettings,
} from '@mukuroji/contracts'
import { PlanningError } from '../../modules/planning'
import { workspaceDependencies } from './app-dependencies'

/**
 * Reads a Workspace's health update required fields and template.
 *
 * A Workspace that has not saved them gets the defaults, which require nothing extra; any other
 * read failure propagates so a stored rule is never silently skipped.
 *
 * @param directoryId - Workspace directory to read.
 * @returns The stored settings, or the defaults.
 */
export async function readPlanningUpdateTemplateSettingsOf(
  directoryId: string,
): Promise<PlanningUpdateTemplateSettings> {
  const profile = await workspaceDependencies.tenantAdministration.getProfile(directoryId)
  return profile?.planningUpdateTemplate ?? DEFAULT_PLANNING_UPDATE_TEMPLATE_SETTINGS
}

/**
 * Rejects an update that leaves a Workspace-required field empty.
 *
 * Fields with the wrong type count as empty here; the Planning use case still rejects their type.
 *
 * @param settings - Workspace template settings.
 * @param input - Untrusted publish request body.
 * @throws PlanningError when a required field is empty.
 */
export function requirePlanningUpdateRequiredFields(
  settings: PlanningUpdateTemplateSettings,
  input: Readonly<Record<string, unknown>>,
) {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const missing = listMissingPlanningUpdateFields(settings, {
    riskSummary: text(input.riskSummary),
    decisionSummary: text(input.decisionSummary),
    helpNeeded: text(input.helpNeeded),
    nextAction: text(input.nextAction),
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
  })
  if (missing.length > 0) {
    throw new PlanningError(
      400,
      'PlanningUpdateRequiredFieldsMissing',
      `This Workspace requires these update fields: ${missing.join(', ')}.`,
    )
  }
}
