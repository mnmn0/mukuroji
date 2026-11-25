import {
  WORKFLOW_STATUS_REQUIRED_FIELDS,
  WORKFLOW_TRANSITION_ACTOR_ROLES,
  type CustomFieldDefinition,
  type WorkflowDefinition,
  type WorkflowStatusRequiredField,
  type WorkflowTransitionActorRole,
} from '@mukuroji/contracts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { sortCustomFieldDefinitions } from '../model/customFields'
import {
  setWorkflowStatusRequiredCustomField,
  setWorkflowStatusRequiredField,
  setWorkflowTransitionActorRole,
} from '../model/workflowRules'

/** Label of each transition actor role. */
const actorRoleLabelKeys = {
  'project-manager': 'workItems.configuration.rules.actor.project-manager',
  assignee: 'workItems.configuration.rules.actor.assignee',
} as const satisfies Record<WorkflowTransitionActorRole, MessageKey>

/** Label of each built-in status required field. */
const requiredFieldLabelKeys = {
  'due-date': 'workItems.configuration.rules.field.due-date',
  'acceptance-criteria': 'workItems.configuration.rules.field.acceptance-criteria',
} as const satisfies Record<WorkflowStatusRequiredField, MessageKey>

/** Props accepted by the workflow rules configuration section. */
export type WorkflowRulesConfigurationSectionProps = {
  /** Workflow being edited, with statuses in display order. */
  workflow: WorkflowDefinition
  /** Custom fields of the configuration draft. */
  customFields: readonly CustomFieldDefinition[]
  /** Display locale. */
  locale: Locale
  /** Replaces the workflow in the configuration draft. */
  onChange: (workflow: WorkflowDefinition) => void
}

/**
 * Edits who may run each allowed transition and which fields each status requires.
 *
 * @param props - Workflow draft, its custom fields, and the change callback.
 * @returns The workflow rules section.
 */
export function WorkflowRulesConfigurationSection({
  customFields,
  locale,
  onChange,
  workflow,
}: WorkflowRulesConfigurationSectionProps) {
  const t = createTranslator(locale)
  const statusNames = new Map(workflow.statuses.map((status) => [status.id, status.name]))
  const statusOrder = new Map(workflow.statuses.map((status, index) => [status.id, index]))
  const transitions = [...workflow.transitions].sort((left, right) =>
    (statusOrder.get(left.fromStatusId) ?? 0) - (statusOrder.get(right.fromStatusId) ?? 0) ||
    (statusOrder.get(left.toStatusId) ?? 0) - (statusOrder.get(right.toStatusId) ?? 0))
  const requirableFields = sortCustomFieldDefinitions([...customFields]).filter((field) => field.type !== 'formula')

  return (
    <div
      className="grid grid-cols-2 gap-0 border-t border-[var(--workbench-border)] max-[1320px]:grid-cols-1"
      data-testid="workflow-rules"
    >
      <div className="min-w-0 border-r border-[var(--workbench-border)] p-5 max-[1320px]:border-b max-[1320px]:border-r-0">
        <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('workItems.configuration.rules.actorsTitle')}
        </h4>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('workItems.configuration.rules.actorsDescription')}
        </p>
        {transitions.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-6 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('workItems.configuration.rules.noTransitions')}
          </p>
        ) : (
          <ul className="mt-4 grid gap-2">
            {transitions.map((transition) => {
              const from = statusNames.get(transition.fromStatusId) ?? transition.fromStatusId
              const to = statusNames.get(transition.toStatusId) ?? transition.toStatusId
              const restricted = (transition.allowedActorRoles?.length ?? 0) > 0
              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-[var(--workbench-border)] bg-surface px-3 py-2"
                  data-testid={`workflow-transition-rule-${transition.fromStatusId}-${transition.toStatusId}`}
                  key={`${transition.fromStatusId}\0${transition.toStatusId}`}
                >
                  <span className="min-w-0 text-sm font-semibold text-[var(--workbench-text)]">
                    {from} → {to}
                    <span className="ml-2 text-xs font-medium text-[var(--workbench-muted)]">
                      {restricted ? t('workItems.configuration.rules.restricted') : t('workItems.configuration.rules.anyone')}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-3">
                    {WORKFLOW_TRANSITION_ACTOR_ROLES.map((role) => (
                      <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--workbench-text)]" key={role}>
                        <input
                          aria-label={t('workItems.configuration.rules.actorLabel')
                            .replace('{from}', from)
                            .replace('{to}', to)
                            .replace('{role}', t(actorRoleLabelKeys[role]))}
                          checked={transition.allowedActorRoles?.includes(role) ?? false}
                          className="h-4 w-4 accent-[var(--workbench-primary)]"
                          onChange={(event) => onChange(setWorkflowTransitionActorRole(
                            workflow,
                            transition.fromStatusId,
                            transition.toStatusId,
                            role,
                            event.currentTarget.checked,
                          ))}
                          type="checkbox"
                        />
                        {t(actorRoleLabelKeys[role])}
                      </label>
                    ))}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="min-w-0 p-5">
        <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('workItems.configuration.rules.fieldsTitle')}
        </h4>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('workItems.configuration.rules.fieldsDescription')}
        </p>
        <ul className="mt-4 grid gap-2">
          {workflow.statuses.map((status) => (
            <li
              className="grid gap-2 rounded-lg border border-[var(--workbench-border)] bg-surface px-3 py-2"
              data-testid={`workflow-status-rule-${status.id}`}
              key={status.id}
            >
              <span className="text-sm font-semibold text-[var(--workbench-text)]">{status.name}</span>
              <span className="flex flex-wrap gap-x-4 gap-y-1">
                {WORKFLOW_STATUS_REQUIRED_FIELDS.map((field) => (
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--workbench-text)]" key={field}>
                    <input
                      aria-label={t('workItems.configuration.rules.fieldLabel')
                        .replace('{status}', status.name)
                        .replace('{field}', t(requiredFieldLabelKeys[field]))}
                      checked={status.requiredFields?.includes(field) ?? false}
                      className="h-4 w-4 accent-[var(--workbench-primary)]"
                      onChange={(event) => onChange(setWorkflowStatusRequiredField(
                        workflow,
                        status.id,
                        field,
                        event.currentTarget.checked,
                      ))}
                      type="checkbox"
                    />
                    {t(requiredFieldLabelKeys[field])}
                  </label>
                ))}
                {requirableFields.map((field) => (
                  <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--workbench-text)]" key={field.id}>
                    <input
                      aria-label={t('workItems.configuration.rules.fieldLabel')
                        .replace('{status}', status.name)
                        .replace('{field}', field.name)}
                      checked={status.requiredCustomFieldIds?.includes(field.id) ?? false}
                      className="h-4 w-4 accent-[var(--workbench-primary)]"
                      onChange={(event) => onChange(setWorkflowStatusRequiredCustomField(
                        workflow,
                        status.id,
                        field.id,
                        event.currentTarget.checked,
                      ))}
                      type="checkbox"
                    />
                    {field.name}
                  </label>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
