import type {
  WorkflowRuleUnmetCondition,
  WorkflowStatusRequiredField,
  WorkflowTransitionActorRole,
} from '@mukuroji/contracts'
import { TeamIssuesApiError } from '../api/errors'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Label of each transition actor role in a rejection message. */
const actorRoleLabelKeys = {
  'project-manager': 'workItems.configuration.rules.actor.project-manager',
  assignee: 'workItems.configuration.rules.actor.assignee',
} as const satisfies Record<WorkflowTransitionActorRole, MessageKey>

/** Label of each built-in required field in a rejection message. */
const requiredFieldLabelKeys = {
  'due-date': 'workItems.configuration.rules.field.due-date',
  'acceptance-criteria': 'workItems.configuration.rules.field.acceptance-criteria',
} as const satisfies Record<WorkflowStatusRequiredField, MessageKey>

/**
 * Finds the workflow rules a rejected status change did not meet, on the error or its cause.
 *
 * @param error - Unknown mutation failure.
 * @returns The unmet rules, or an empty list when the failure is not a workflow rule rejection.
 */
export function readWorkflowRuleRejection(error: unknown): readonly WorkflowRuleUnmetCondition[] {
  if (error instanceof TeamIssuesApiError) return error.workflowRuleConditions
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof TeamIssuesApiError ? cause.workflowRuleConditions : []
}

/**
 * Explains a workflow rule rejection in the person's language.
 *
 * @param error - Unknown mutation failure.
 * @param t - Translator.
 * @param customFieldNames - Display names of custom fields by ID; an unknown ID is shown as is.
 * @returns The explanation, or `undefined` when the failure is not a workflow rule rejection.
 */
export function describeWorkflowRuleRejection(
  error: unknown,
  t: (key: MessageKey) => string,
  customFieldNames: ReadonlyMap<string, string> = new Map(),
): string | undefined {
  const conditions = readWorkflowRuleRejection(error)
  if (conditions.length === 0) return undefined
  const actor = conditions.find((condition) => condition.rule === 'transition-actor')
  if (actor) {
    const roles = actor.allowedActorRoles.map((role) => t(actorRoleLabelKeys[role])).join(t('issues.error.workflowRule.or'))
    return t('issues.error.workflowRule.actor').replace('{roles}', roles)
  }
  const fields = conditions.flatMap((condition) => condition.rule === 'required-field'
    ? [t(requiredFieldLabelKeys[condition.field])]
    : condition.rule === 'required-custom-field'
      ? [customFieldNames.get(condition.customFieldId) ?? condition.customFieldId]
      : [])
  return t('issues.error.workflowRule.fields').replace('{fields}', fields.join(t('issues.error.workflowRule.separator')))
}
