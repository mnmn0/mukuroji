import type { AutomationTemplate } from '@mukuroji/contracts'
import type { AutomationManagementData } from '../managementData'

/**
 * Keeps only the definitions and runs owned by one Team.
 *
 * @param data - Workspace-wide management data.
 * @param ownerTeamId - Team whose definitions are shown.
 * @returns The Team's rules, templates, recurring Work, and runs; Webhooks stay with administrators.
 */
export function selectOwnedAutomationData(
  data: AutomationManagementData,
  ownerTeamId: string,
): AutomationManagementData {
  return {
    ...data,
    executions: data.executions.filter((execution) => execution.ownerTeamId === ownerTeamId),
    recurringWork: data.recurringWork.filter((definition) => definition.ownerTeamId === ownerTeamId),
    rules: data.rules.filter((rule) => rule.ownerTeamId === ownerTeamId),
    templates: data.templates.filter((template) => template.ownerTeamId === ownerTeamId),
    webhooks: [],
    workflowTargets: data.workflowTargets.filter((target) =>
      target.scopeType === 'team' && target.scopeId === ownerTeamId
    ),
  }
}

/**
 * Lists the templates a Team definition may use as input: the Team's own templates and
 * Workspace templates, leaving out Work Item templates fixed to another Team, which the server
 * rejects for the Team.
 *
 * @param templates - Workspace-wide template list.
 * @param ownerTeamId - Team that owns the definition being edited.
 * @returns Templates selectable in the Team's rule and recurring Work editors.
 */
export function selectTeamTemplateOptions(
  templates: readonly AutomationTemplate[],
  ownerTeamId: string,
): AutomationTemplate[] {
  return templates.filter((template) =>
    template.ownerTeamId === ownerTeamId ||
    template.ownerTeamId === undefined && !createsWorkInAnotherTeam(template, ownerTeamId)
  )
}

/**
 * Lists the templates a Workspace definition may use as input. Team templates are left out,
 * because the server only lets definitions of the same Team use them.
 *
 * @param templates - Workspace-wide template list.
 * @returns Templates selectable in the Workspace rule and recurring Work editors.
 */
export function selectWorkspaceTemplateOptions(
  templates: readonly AutomationTemplate[],
): AutomationTemplate[] {
  return templates.filter((template) => template.ownerTeamId === undefined)
}

/**
 * Tests whether a Work Item template is fixed to create Work in a Team other than the given one.
 *
 * @param template - Template to inspect.
 * @param teamId - Team the Work would be created for.
 * @returns Whether the template's payload names another Team.
 */
function createsWorkInAnotherTeam(template: AutomationTemplate, teamId: string): boolean {
  if (template.kind !== 'work-item') return false
  const payloadTeamId = template.payload.teamId
  return typeof payloadTeamId === 'string' && payloadTeamId !== '' && payloadTeamId !== teamId
}
