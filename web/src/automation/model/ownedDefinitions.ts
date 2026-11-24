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
