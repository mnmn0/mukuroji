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
 * Workspace templates, which the server accepts unless they create Work in another Team.
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
    template.ownerTeamId === undefined || template.ownerTeamId === ownerTeamId
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
