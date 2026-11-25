import {
  WORKFLOW_STATUS_REQUIRED_FIELDS,
  WORKFLOW_TRANSITION_ACTOR_ROLES,
  type WorkflowDefinition,
  type WorkflowStatusRequiredField,
  type WorkflowTransitionActorRole,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'

/**
 * Turns one transition actor role on or off, keeping roles in display order.
 *
 * An empty role list is removed so the transition stays open to everyone, as before.
 *
 * @param workflow - Workflow being edited.
 * @param fromStatusId - Transition source status.
 * @param toStatusId - Transition target status.
 * @param role - Role to change.
 * @param enabled - Whether the role may run the transition.
 * @returns The workflow with the transition's roles changed.
 */
export function setWorkflowTransitionActorRole(
  workflow: WorkflowDefinition,
  fromStatusId: string,
  toStatusId: string,
  role: WorkflowTransitionActorRole,
  enabled: boolean,
): WorkflowDefinition {
  return {
    ...workflow,
    transitions: workflow.transitions.map((transition) => {
      if (transition.fromStatusId !== fromStatusId || transition.toStatusId !== toStatusId) return transition
      const current = new Set(transition.allowedActorRoles ?? [])
      if (enabled) current.add(role)
      else current.delete(role)
      const allowedActorRoles = WORKFLOW_TRANSITION_ACTOR_ROLES.filter((candidate) => current.has(candidate))
      const rest = { ...transition }
      delete rest.allowedActorRoles
      return allowedActorRoles.length === 0 ? rest : { ...rest, allowedActorRoles }
    }),
  }
}

/**
 * Turns one built-in required field of a status on or off.
 *
 * @param workflow - Workflow being edited.
 * @param statusId - Status whose requirements change.
 * @param field - Built-in field to change.
 * @param enabled - Whether the status requires the field.
 * @returns The workflow with the status requirements changed.
 */
export function setWorkflowStatusRequiredField(
  workflow: WorkflowDefinition,
  statusId: string,
  field: WorkflowStatusRequiredField,
  enabled: boolean,
): WorkflowDefinition {
  return {
    ...workflow,
    statuses: workflow.statuses.map((status) => {
      if (status.id !== statusId) return status
      const current = new Set(status.requiredFields ?? [])
      if (enabled) current.add(field)
      else current.delete(field)
      const requiredFields = WORKFLOW_STATUS_REQUIRED_FIELDS.filter((candidate) => current.has(candidate))
      const rest = { ...status }
      delete rest.requiredFields
      return requiredFields.length === 0 ? rest : { ...rest, requiredFields }
    }),
  }
}

/**
 * Turns one required custom field of a status on or off.
 *
 * @param workflow - Workflow being edited.
 * @param statusId - Status whose requirements change.
 * @param customFieldId - Custom field to change.
 * @param enabled - Whether the status requires the field.
 * @returns The workflow with the status requirements changed.
 */
export function setWorkflowStatusRequiredCustomField(
  workflow: WorkflowDefinition,
  statusId: string,
  customFieldId: string,
  enabled: boolean,
): WorkflowDefinition {
  return {
    ...workflow,
    statuses: workflow.statuses.map((status) => {
      if (status.id !== statusId) return status
      const others = (status.requiredCustomFieldIds ?? []).filter((fieldId) => fieldId !== customFieldId)
      const requiredCustomFieldIds = enabled ? [...others, customFieldId] : others
      const rest = { ...status }
      delete rest.requiredCustomFieldIds
      return requiredCustomFieldIds.length === 0 ? rest : { ...rest, requiredCustomFieldIds }
    }),
  }
}

/**
 * Removes status requirements on custom fields that are gone or became formulas.
 *
 * The server rejects a status that requires such a field, so the draft drops them with the field.
 *
 * @param configuration - Configuration whose custom fields changed.
 * @returns The configuration with only usable required custom fields left on statuses.
 */
export function pruneWorkflowStatusRequiredCustomFields(
  configuration: WorkItemConfiguration,
): WorkItemConfiguration {
  const usableFieldIds = new Set(configuration.customFields
    .filter((field) => field.type !== 'formula')
    .map((field) => field.id))
  /** Drops unusable required custom fields from one workflow. */
  const prune = (workflow: WorkflowDefinition): WorkflowDefinition => ({
    ...workflow,
    statuses: workflow.statuses.map((status) => {
      if (!status.requiredCustomFieldIds) return status
      const requiredCustomFieldIds = status.requiredCustomFieldIds.filter((fieldId) => usableFieldIds.has(fieldId))
      if (requiredCustomFieldIds.length === status.requiredCustomFieldIds.length) return status
      const rest = { ...status }
      delete rest.requiredCustomFieldIds
      return requiredCustomFieldIds.length === 0 ? rest : { ...rest, requiredCustomFieldIds }
    }),
  })
  return {
    ...configuration,
    workflow: prune(configuration.workflow),
    ...(configuration.workflows ? { workflows: configuration.workflows.map(prune) } : {}),
  }
}
