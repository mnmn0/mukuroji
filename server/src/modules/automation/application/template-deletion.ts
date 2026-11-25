import { AutomationError } from '../domain/automation-error'
import type { AutomationRecurringSchedulePort } from './ports/recurring-schedule-port'
import type { AutomationRuleTemplatePort } from './ports/rule-template-port'

/** Ports the template deletion use case reads and writes. */
export type AutomationTemplateDeletionPorts = {
  /** Rules, templates, and the Workspace definition revision. */
  ruleTemplates: Pick<
    AutomationRuleTemplatePort,
    'deleteTemplate' | 'getAutomationDefinitionRevision' | 'getTemplate' | 'listRules'
  >
  /** Recurring Work definitions. */
  recurringSchedules: Pick<AutomationRecurringSchedulePort, 'listRecurringWorks'>
}

/** Most definition names an in-use error lists. */
const TEMPLATE_IN_USE_NAME_LIMIT = 5

/**
 * Deletes a template that no rule create action and no Recurring Work definition uses.
 *
 * The Workspace definition revision is read before the usage check and must still be current when
 * the template is deleted, so a definition saved after the check makes the delete fail instead of
 * leaving that definition pointing at a missing template.
 *
 * @param ports - Automation persistence.
 * @param workspaceId - Workspace that owns the template.
 * @param templateId - Template to delete.
 * @param expectedRevision - Template revision the caller read.
 * @returns A promise that resolves after the delete.
 * @throws AutomationError `AutomationTemplateNotFound` or `AutomationTemplateInUse`.
 */
export async function deleteUnusedAutomationTemplate(
  ports: AutomationTemplateDeletionPorts,
  workspaceId: string,
  templateId: string,
  expectedRevision: number,
): Promise<void> {
  const definitionRevision = await ports.ruleTemplates.getAutomationDefinitionRevision(workspaceId)
  if (!await ports.ruleTemplates.getTemplate(workspaceId, templateId)) {
    throw new AutomationError('not-found', 'AutomationTemplateNotFound', 'Automation template was not found.')
  }
  const [rules, recurringWorks] = await Promise.all([
    ports.ruleTemplates.listRules(workspaceId),
    ports.recurringSchedules.listRecurringWorks(workspaceId),
  ])
  const users = [
    ...rules
      .filter((rule) => rule.actions.some((action) =>
        action.type === 'create' && action.templateId === templateId))
      .map((rule) => rule.name),
    ...recurringWorks
      .filter((definition) => definition.templateId === templateId)
      .map((definition) => definition.name),
  ]
  if (users.length > 0) {
    throw new AutomationError(
      'conflict',
      'AutomationTemplateInUse',
      `Automation template is used by: ${users.slice(0, TEMPLATE_IN_USE_NAME_LIMIT).join(', ')}.`,
    )
  }
  await ports.ruleTemplates.deleteTemplate(workspaceId, templateId, expectedRevision, definitionRevision)
}
