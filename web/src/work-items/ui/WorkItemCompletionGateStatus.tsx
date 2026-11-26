import {
  describeWorkItemCompletionGate,
  type ApprovalSummary,
  type WorkItemAcceptanceCriterion,
  type WorkItemCompletionGateConditionId,
  type WorkItemCompletionGateConditionState,
  type WorkItemCompletionGatePolicy,
  type WorkItemCompletionGateRequirement,
} from '@mukuroji/contracts'
import { useId } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'

/** Label of each completion Gate condition. */
const conditionLabelKeys = {
  'acceptance-criteria': 'workItems.configuration.completionGate.condition.acceptance-criteria',
  'no-pending-approvals': 'workItems.configuration.completionGate.condition.no-pending-approvals',
  'human-approval': 'workItems.configuration.completionGate.condition.human-approval',
} as const satisfies Record<WorkItemCompletionGateConditionId, MessageKey>

/** Label of each evaluated requirement. */
const requirementLabelKeys = {
  warn: 'workItems.configuration.completionGate.requirement.warn',
  required: 'workItems.configuration.completionGate.requirement.required',
} as const satisfies Record<Exclude<WorkItemCompletionGateRequirement, 'off'>, MessageKey>

/** Label of each condition state. */
const stateLabelKeys = {
  met: 'workItems.completionGate.state.met',
  unmet: 'workItems.completionGate.state.unmet',
  unavailable: 'workItems.completionGate.state.unavailable',
} as const satisfies Record<WorkItemCompletionGateConditionState, MessageKey>

/** Props accepted by the completion Gate checklist. */
export type WorkItemCompletionGateStatusProps = {
  /** Team completion Gate, if any. */
  policy: WorkItemCompletionGatePolicy | undefined
  /** Acceptance criteria stored on the Work Item. */
  acceptanceCriteria: readonly WorkItemAcceptanceCriterion[] | undefined
  /**
   * Approval counts of the Work Item. The API leaves the summary out when the Work Item has no
   * approvals, so an absent summary counts as none.
   */
  approvalSummary: ApprovalSummary | undefined
  /** Display locale. */
  locale: Locale
}

/**
 * Shows the Team's completion Gate as a checklist of the conditions it evaluates and whether the
 * saved Work Item meets each one. The server evaluates the Gate again when the Work Item is completed.
 *
 * @param props - Gate policy and the Work Item state it is evaluated against.
 * @returns The checklist, or nothing when the Team evaluates no condition.
 */
export function WorkItemCompletionGateStatus({
  acceptanceCriteria,
  approvalSummary,
  locale,
  policy,
}: WorkItemCompletionGateStatusProps) {
  const t = createTranslator(locale)
  const headingId = useId()
  const statuses = describeWorkItemCompletionGate(policy, {
    acceptanceCriteria: acceptanceCriteria ?? [],
    approvalSummary: approvalSummary ?? { pendingCount: 0, approvedCount: 0, changesRequestedCount: 0 },
  })
  if (statuses.length === 0) return null
  const met = statuses.filter((status) => status.state === 'met').length

  return (
    <section
      aria-labelledby={headingId}
      className="workbench-panel-muted grid min-w-0 gap-3 p-3"
      data-testid="work-item-completion-gate"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={headingId}>
          {t('workItems.completionGate.title')}
        </h3>
        <span className="text-xs text-[var(--workbench-muted)]">
          {t('workItems.completionGate.summary')
            .replace('{met}', String(met))
            .replace('{total}', String(statuses.length))}
        </span>
      </div>
      <p className="text-xs text-[var(--workbench-muted)]">{t('workItems.completionGate.help')}</p>
      <ul className="grid gap-1.5">
        {statuses.map((status) => (
          <li
            className="flex min-w-0 flex-wrap items-start gap-2 text-sm text-[var(--workbench-text)]"
            data-state={status.state}
            key={status.condition}
          >
            <span
              aria-hidden="true"
              className={status.state === 'met' ? 'text-[var(--workbench-success)]' : 'text-[var(--workbench-muted)]'}
            >
              {status.state === 'met' ? '☑' : '☐'}
            </span>
            <span className="min-w-0 flex-1 break-words">
              <span className="sr-only">{t(stateLabelKeys[status.state])}{': '}</span>
              {t(conditionLabelKeys[status.condition])}
            </span>
            <span className="text-xs text-[var(--workbench-muted)]">
              {t(requirementLabelKeys[status.requirement])}
              {status.state === 'met' ? null : ` · ${t(stateLabelKeys[status.state])}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
