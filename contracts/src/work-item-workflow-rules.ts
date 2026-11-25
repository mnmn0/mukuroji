/** Transition fields the entry rule reads; structurally a `WorkflowTransition`. */
type WorkflowRuleTransition = {
  /** Source status ID. */
  fromStatusId: string
  /** Target status ID. */
  toStatusId: string
  /** Roles that may run the transition. */
  allowedActorRoles?: readonly WorkflowTransitionActorRole[]
}

/** Status fields the required-field rule reads; structurally a `WorkflowStatusDefinition`. */
type WorkflowRuleStatus = {
  /** Built-in fields required in the status. */
  requiredFields?: readonly WorkflowStatusRequiredField[]
  /** Custom fields required in the status. */
  requiredCustomFieldIds?: readonly string[]
}

/**
 * Who may run a restricted workflow transition.
 *
 * - `project-manager`: a manager of the Work Item's Project, or a Team manager when the Work Item has
 *   no Project.
 * - `assignee`: the Work Item's current assignee.
 */
export type WorkflowTransitionActorRole = 'project-manager' | 'assignee'

/** Transition actor roles in the order settings screens present them. */
export const WORKFLOW_TRANSITION_ACTOR_ROLES: readonly WorkflowTransitionActorRole[] = [
  'project-manager',
  'assignee',
]

/**
 * Built-in Work Item field a workflow status can require before a Work Item enters it.
 *
 * Every Work Item has an assignee, so the assignee is never a required field.
 *
 * - `due-date`: the schedule has a due date or end date.
 * - `acceptance-criteria`: at least one acceptance criterion exists.
 */
export type WorkflowStatusRequiredField = 'due-date' | 'acceptance-criteria'

/** Built-in status required fields in the order settings screens present them. */
export const WORKFLOW_STATUS_REQUIRED_FIELDS: readonly WorkflowStatusRequiredField[] = [
  'due-date',
  'acceptance-criteria',
]

/** Actor who is changing a Work Item status, as the workflow rules see it. */
export type WorkflowRuleActor = {
  /**
   * Whether a person is acting directly. Automations and developer credentials (Public API, MCP and
   * agents) are not, so they never satisfy a restricted transition.
   */
  interactive: boolean
  /** Whether the actor manages the Work Item's Project, or its Team when it has no Project. */
  projectManager: boolean
  /** Whether the actor is the Work Item's current assignee. */
  assignee: boolean
}

/** Work Item state after a change, which status required fields are checked against. */
export type WorkflowRuleWorkItemState = {
  /** Whether the schedule has a due date or end date. */
  hasDueDate: boolean
  /** Number of acceptance criteria. */
  acceptanceCriteriaCount: number
  /** Custom field IDs that hold a value. */
  filledCustomFieldIds: ReadonlySet<string>
}

/** One workflow rule a status change does not meet. */
export type WorkflowRuleUnmetCondition =
  | {
    /** The actor may not run the transition. */
    rule: 'transition-actor'
    /** Roles that may run the transition. */
    allowedActorRoles: WorkflowTransitionActorRole[]
    /** Short English explanation suitable for an agent or a log. */
    message: string
  }
  | {
    /** A built-in field the target status requires is empty. */
    rule: 'required-field'
    /** Empty field. */
    field: WorkflowStatusRequiredField
    /** Short English explanation suitable for an agent or a log. */
    message: string
  }
  | {
    /** A custom field the target status requires is empty. */
    rule: 'required-custom-field'
    /** Empty custom field ID. */
    customFieldId: string
    /** Short English explanation suitable for an agent or a log. */
    message: string
  }

/**
 * Error code of a status change the workflow rules reject.
 *
 * - `WorkflowTransitionActorDenied` (`403`): the actor may not run the transition.
 * - `WorkflowStatusRequirementsNotMet` (`409`): a field the target status requires is empty.
 */
export type WorkflowRuleErrorCode = 'WorkflowTransitionActorDenied' | 'WorkflowStatusRequirementsNotMet'

/** Body returned when the workflow rules reject a status change. */
export type WorkflowRuleErrorResponse = {
  /** Stable error code. */
  code: WorkflowRuleErrorCode
  /** Human-readable summary. */
  message: string
  /** Every rule the change does not meet, actor rules first. */
  unmetConditions: WorkflowRuleUnmetCondition[]
}

/**
 * Returns whether a value is a supported transition actor role.
 *
 * @param value - Candidate value.
 * @returns Whether it names one of {@link WORKFLOW_TRANSITION_ACTOR_ROLES}.
 */
export function isWorkflowTransitionActorRole(value: unknown): value is WorkflowTransitionActorRole {
  return value === 'project-manager' || value === 'assignee'
}

/**
 * Returns whether a value is a supported built-in status required field.
 *
 * @param value - Candidate value.
 * @returns Whether it names one of {@link WORKFLOW_STATUS_REQUIRED_FIELDS}.
 */
export function isWorkflowStatusRequiredField(value: unknown): value is WorkflowStatusRequiredField {
  return value === 'due-date' || value === 'acceptance-criteria'
}

/**
 * Finds the actor roles that restrict entering a status.
 *
 * A known transition uses its own roles. Entering a status without a transition (creating a Work Item
 * in it, or changing to a Type with another workflow) is allowed for the least restricted transition
 * into the status, so a status reachable without a restriction stays unrestricted.
 *
 * @param workflow - Workflow that owns the status.
 * @param fromStatusId - Status before the change, or `undefined` when there is no transition.
 * @param toStatusId - Status after the change.
 * @returns Roles that may enter the status, or an empty list when anyone may.
 */
export function findWorkflowEntryActorRoles(
  workflow: { readonly transitions: readonly WorkflowRuleTransition[] },
  fromStatusId: string | undefined,
  toStatusId: string,
): WorkflowTransitionActorRole[] {
  if (fromStatusId === toStatusId) return []
  if (fromStatusId !== undefined) {
    const transition = workflow.transitions.find((candidate) =>
      candidate.fromStatusId === fromStatusId && candidate.toStatusId === toStatusId)
    if (transition) return [...(transition.allowedActorRoles ?? [])]
  }
  const incoming = workflow.transitions.filter((candidate) => candidate.toStatusId === toStatusId)
  if (incoming.some((candidate) => (candidate.allowedActorRoles ?? []).length === 0)) return []
  return WORKFLOW_TRANSITION_ACTOR_ROLES.filter((role) =>
    incoming.some((candidate) => candidate.allowedActorRoles?.includes(role)))
}

/**
 * Evaluates the actor restriction of a status change.
 *
 * @param allowedActorRoles - Roles that may enter the status; empty means anyone.
 * @param actor - Actor making the change.
 * @returns The unmet actor rule, or `undefined` when the actor may make the change.
 */
export function evaluateWorkflowTransitionActor(
  allowedActorRoles: readonly WorkflowTransitionActorRole[],
  actor: WorkflowRuleActor,
): WorkflowRuleUnmetCondition | undefined {
  if (allowedActorRoles.length === 0) return undefined
  if (
    actor.interactive &&
    allowedActorRoles.some((role) => role === 'project-manager' ? actor.projectManager : actor.assignee)
  ) {
    return undefined
  }
  return {
    rule: 'transition-actor',
    allowedActorRoles: [...allowedActorRoles],
    message: actor.interactive
      ? `Only ${allowedActorRoles.join(' or ')} may make this transition.`
      : `Only a person acting as ${allowedActorRoles.join(' or ')} may make this transition; automations, API credentials, and agents may not.`,
  }
}

/**
 * Evaluates the fields a status requires against a Work Item's state after a change.
 *
 * @param status - Status the Work Item enters.
 * @param state - Work Item state after the change.
 * @returns Every empty required field, built-in fields first.
 */
export function evaluateWorkflowStatusRequirements(
  status: WorkflowRuleStatus,
  state: WorkflowRuleWorkItemState,
): WorkflowRuleUnmetCondition[] {
  const unmet: WorkflowRuleUnmetCondition[] = []
  for (const field of WORKFLOW_STATUS_REQUIRED_FIELDS) {
    if (!status.requiredFields?.includes(field)) continue
    const filled = field === 'due-date' ? state.hasDueDate : state.acceptanceCriteriaCount > 0
    if (!filled) unmet.push({ rule: 'required-field', field, message: `${field} is required in this status.` })
  }
  for (const customFieldId of status.requiredCustomFieldIds ?? []) {
    if (!state.filledCustomFieldIds.has(customFieldId)) {
      unmet.push({
        rule: 'required-custom-field',
        customFieldId,
        message: `Custom field "${customFieldId}" is required in this status.`,
      })
    }
  }
  return unmet
}
