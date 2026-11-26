import type { WorkItemAcceptanceCriterion } from './work-item-acceptance-criteria'

/**
 * How strictly a Team applies one completion Gate condition.
 *
 * - `off`: the condition is not evaluated.
 * - `warn`: the condition is reported but does not block completion.
 * - `required`: the server rejects a move into the `completed` category while the condition is unmet.
 */
export type WorkItemCompletionGateRequirement = 'off' | 'warn' | 'required'

/** Completion Gate requirements in the order settings screens present them. */
export const WORK_ITEM_COMPLETION_GATE_REQUIREMENTS: readonly WorkItemCompletionGateRequirement[] = [
  'off',
  'warn',
  'required',
]

/**
 * One condition a Work Item can be required to meet before it moves into the `completed` category.
 *
 * - `acceptance-criteria`: every acceptance criterion is satisfied. A Work Item without criteria meets it.
 * - `no-pending-approvals`: no approval on the Work Item is pending or has changes requested.
 * - `human-approval`: at least one approval on the Work Item has been approved.
 */
export type WorkItemCompletionGateConditionId =
  | 'acceptance-criteria'
  | 'no-pending-approvals'
  | 'human-approval'

/** Completion Gate conditions in evaluation and display order. */
export const WORK_ITEM_COMPLETION_GATE_CONDITIONS: readonly WorkItemCompletionGateConditionId[] = [
  'acceptance-criteria',
  'no-pending-approvals',
  'human-approval',
]

/**
 * Team completion Gate: which conditions a Work Item must meet before it is completed.
 *
 * An absent condition means `off`, and an absent policy leaves completion unchanged.
 */
export type WorkItemCompletionGatePolicy = {
  /** Requirement for every acceptance criterion being satisfied. */
  acceptanceCriteria?: WorkItemCompletionGateRequirement
  /** Requirement for no pending or changes-requested approval remaining. */
  noPendingApprovals?: WorkItemCompletionGateRequirement
  /** Requirement for at least one approved approval. */
  humanApproval?: WorkItemCompletionGateRequirement
}

/**
 * Why a completion Gate condition is not met.
 *
 * - `unmet`: the state was read and does not meet the condition.
 * - `unavailable`: the state needed to evaluate the condition could not be read, so the Gate fails closed.
 */
export type WorkItemCompletionGateFailureReason = 'unmet' | 'unavailable'

/** One completion Gate condition that is not met. */
export type WorkItemCompletionGateUnmetCondition = {
  /** Condition that is not met. */
  condition: WorkItemCompletionGateConditionId
  /** Requirement the Team set for the condition; `off` conditions are never reported. */
  requirement: Exclude<WorkItemCompletionGateRequirement, 'off'>
  /** Whether the condition was evaluated and failed or could not be evaluated. */
  reason: WorkItemCompletionGateFailureReason
  /** Short English explanation suitable for an agent or a log. */
  message: string
}

/**
 * Body returned by the Team Work Item API with `409 WorkItemCompletionGateNotSatisfied`.
 */
export type WorkItemCompletionGateErrorResponse = {
  /** Stable error code. */
  code: 'WorkItemCompletionGateNotSatisfied'
  /** Human-readable summary. */
  message: string
  /** Required conditions that blocked the completion, in display order. */
  unmetConditions: WorkItemCompletionGateUnmetCondition[]
}

/** Longest reason a manager can give when overriding the completion Gate. */
export const WORK_ITEM_COMPLETION_GATE_OVERRIDE_REASON_MAX_LENGTH = 1000

/**
 * Manager override sent with a Team Work Item update that completes the Work Item while a required
 * completion Gate condition is unmet.
 */
export type WorkItemCompletionGateOverrideRequest = {
  /** Why the Work Item is completed without meeting the Gate; required, trimmed, at most 1,000 characters. */
  reason: string
}

/** Manager override recorded on the Work Item update that it allowed. */
export type WorkItemCompletionGateOverrideRecord = {
  /** Reason the manager gave. */
  reason: string
  /** Required conditions that were unmet when the override completed the Work Item. */
  conditions: WorkItemCompletionGateConditionId[]
}

/** Approval counts a completion Gate reads; a subset of the Work Item approval summary. */
export type WorkItemCompletionGateApprovalCounts = {
  /** Approvals waiting for a decision. */
  pendingCount: number
  /** Approvals that have been approved. */
  approvedCount: number
  /** Approvals whose reviewers requested changes. */
  changesRequestedCount: number
}

/** State a completion Gate is evaluated against. */
export type WorkItemCompletionGateState = {
  /** Acceptance criteria the Work Item will hold after the change. */
  acceptanceCriteria: readonly WorkItemAcceptanceCriterion[]
  /** Approval counts for the Work Item, or `undefined` when they could not be read. */
  approvalSummary: WorkItemCompletionGateApprovalCounts | undefined
}

/** Maps each condition to the policy property that sets its requirement. */
const WORK_ITEM_COMPLETION_GATE_POLICY_KEYS: Readonly<
  Record<WorkItemCompletionGateConditionId, keyof WorkItemCompletionGatePolicy>
> = {
  'acceptance-criteria': 'acceptanceCriteria',
  'no-pending-approvals': 'noPendingApprovals',
  'human-approval': 'humanApproval',
}

/**
 * Returns whether a value is a supported completion Gate requirement.
 *
 * @param value - Candidate value.
 * @returns Whether it names one of {@link WORK_ITEM_COMPLETION_GATE_REQUIREMENTS}.
 */
export function isWorkItemCompletionGateRequirement(
  value: unknown,
): value is WorkItemCompletionGateRequirement {
  return value === 'off' || value === 'warn' || value === 'required'
}

/**
 * Reads the requirement a policy sets for one condition.
 *
 * @param policy - Team completion Gate, if any.
 * @param condition - Condition to look up.
 * @returns The requirement, `off` when the policy or the condition is absent.
 */
export function getWorkItemCompletionGateRequirement(
  policy: WorkItemCompletionGatePolicy | undefined,
  condition: WorkItemCompletionGateConditionId,
): WorkItemCompletionGateRequirement {
  return policy?.[WORK_ITEM_COMPLETION_GATE_POLICY_KEYS[condition]] ?? 'off'
}

/**
 * Tells whether a policy evaluates at least one condition, so a caller can skip reading state otherwise.
 *
 * @param policy - Team completion Gate, if any.
 * @returns Whether any condition is `warn` or `required`.
 */
export function hasWorkItemCompletionGateConditions(
  policy: WorkItemCompletionGatePolicy | undefined,
): boolean {
  return WORK_ITEM_COMPLETION_GATE_CONDITIONS.some((condition) =>
    getWorkItemCompletionGateRequirement(policy, condition) !== 'off')
}

/**
 * Tells whether a policy evaluates a condition that needs the Work Item's approval counts.
 *
 * @param policy - Team completion Gate, if any.
 * @returns Whether `no-pending-approvals` or `human-approval` is `warn` or `required`.
 */
export function needsWorkItemCompletionGateApprovals(
  policy: WorkItemCompletionGatePolicy | undefined,
): boolean {
  return getWorkItemCompletionGateRequirement(policy, 'no-pending-approvals') !== 'off' ||
    getWorkItemCompletionGateRequirement(policy, 'human-approval') !== 'off'
}

/**
 * Evaluates a completion Gate against a Work Item's state.
 *
 * @param policy - Team completion Gate, if any.
 * @param state - Acceptance criteria and approval counts after the change.
 * @returns Every `warn` or `required` condition that is not met, in display order.
 */
export function evaluateWorkItemCompletionGate(
  policy: WorkItemCompletionGatePolicy | undefined,
  state: WorkItemCompletionGateState,
): WorkItemCompletionGateUnmetCondition[] {
  const unmet: WorkItemCompletionGateUnmetCondition[] = []
  for (const condition of WORK_ITEM_COMPLETION_GATE_CONDITIONS) {
    const requirement = getWorkItemCompletionGateRequirement(policy, condition)
    if (requirement === 'off') continue
    const failure = evaluateWorkItemCompletionGateCondition(condition, state)
    if (failure) unmet.push({ condition, requirement, ...failure })
  }
  return unmet
}

/**
 * State of one completion Gate condition the Team evaluates.
 *
 * - `met`: the condition holds.
 * - `unmet`: the state was read and does not meet the condition.
 * - `unavailable`: the state could not be read, so the condition counts as unmet.
 */
export type WorkItemCompletionGateConditionState = 'met' | WorkItemCompletionGateFailureReason

/** One `warn` or `required` completion Gate condition with whether the Work Item meets it. */
export type WorkItemCompletionGateConditionStatus = {
  /** Condition the Team evaluates. */
  condition: WorkItemCompletionGateConditionId
  /** Requirement the Team set for the condition. */
  requirement: Exclude<WorkItemCompletionGateRequirement, 'off'>
  /** Whether the Work Item meets the condition. */
  state: WorkItemCompletionGateConditionState
  /** Short English explanation of an unmet or unavailable condition; absent when it is met. */
  message?: string
}

/**
 * Lists every condition a completion Gate evaluates with whether the Work Item meets it, for a
 * checklist that shows met conditions as well as unmet ones.
 *
 * @param policy - Team completion Gate, if any.
 * @param state - Acceptance criteria and approval counts of the Work Item.
 * @returns Every `warn` or `required` condition in display order; empty when the Gate is off.
 */
export function describeWorkItemCompletionGate(
  policy: WorkItemCompletionGatePolicy | undefined,
  state: WorkItemCompletionGateState,
): WorkItemCompletionGateConditionStatus[] {
  const statuses: WorkItemCompletionGateConditionStatus[] = []
  for (const condition of WORK_ITEM_COMPLETION_GATE_CONDITIONS) {
    const requirement = getWorkItemCompletionGateRequirement(policy, condition)
    if (requirement === 'off') continue
    const failure = evaluateWorkItemCompletionGateCondition(condition, state)
    statuses.push(failure
      ? { condition, requirement, state: failure.reason, message: failure.message }
      : { condition, requirement, state: 'met' })
  }
  return statuses
}

/**
 * Evaluates one completion Gate condition.
 *
 * @param condition - Condition to evaluate.
 * @param state - Acceptance criteria and approval counts after the change.
 * @returns The failure reason and message, or `undefined` when the condition is met.
 */
function evaluateWorkItemCompletionGateCondition(
  condition: WorkItemCompletionGateConditionId,
  state: WorkItemCompletionGateState,
): Pick<WorkItemCompletionGateUnmetCondition, 'reason' | 'message'> | undefined {
  if (condition === 'acceptance-criteria') {
    const open = state.acceptanceCriteria.filter((criterion) => !criterion.satisfied).length
    return open === 0
      ? undefined
      : { reason: 'unmet', message: `${open} of ${state.acceptanceCriteria.length} acceptance criteria are not satisfied.` }
  }
  const summary = state.approvalSummary
  if (!summary) {
    return { reason: 'unavailable', message: 'Approvals could not be read, so the Gate fails closed.' }
  }
  if (condition === 'no-pending-approvals') {
    const open = summary.pendingCount + summary.changesRequestedCount
    return open === 0
      ? undefined
      : { reason: 'unmet', message: `${open} approval(s) are pending or have changes requested.` }
  }
  return summary.approvedCount > 0
    ? undefined
    : { reason: 'unmet', message: 'No approval has been approved.' }
}
