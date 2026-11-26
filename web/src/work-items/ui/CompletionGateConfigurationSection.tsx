import {
  WORK_ITEM_COMPLETION_GATE_CONDITIONS,
  WORK_ITEM_COMPLETION_GATE_REQUIREMENTS,
  getWorkItemCompletionGateRequirement,
  isWorkItemCompletionGateRequirement,
  type WorkItemCompletionGateConditionId,
  type WorkItemCompletionGatePolicy,
  type WorkItemCompletionGateRequirement,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import { useId } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'

/** Label of each completion Gate condition. */
const conditionLabelKeys = {
  'acceptance-criteria': 'workItems.configuration.completionGate.condition.acceptance-criteria',
  'no-pending-approvals': 'workItems.configuration.completionGate.condition.no-pending-approvals',
  'human-approval': 'workItems.configuration.completionGate.condition.human-approval',
} as const satisfies Record<WorkItemCompletionGateConditionId, MessageKey>

/** Option label of each completion Gate requirement. */
const requirementLabelKeys = {
  off: 'workItems.configuration.completionGate.requirement.off',
  warn: 'workItems.configuration.completionGate.requirement.warn',
  required: 'workItems.configuration.completionGate.requirement.required',
} as const satisfies Record<WorkItemCompletionGateRequirement, MessageKey>

/** Policy property that stores each condition's requirement. */
const policyKeys = {
  'acceptance-criteria': 'acceptanceCriteria',
  'no-pending-approvals': 'noPendingApprovals',
  'human-approval': 'humanApproval',
} as const satisfies Record<WorkItemCompletionGateConditionId, keyof WorkItemCompletionGatePolicy>

/** Props accepted by the completion Gate configuration section. */
export type CompletionGateConfigurationSectionProps = {
  /** Configuration being edited. */
  configuration: WorkItemConfiguration
  /** Display locale. */
  locale: Locale
  /** Replaces the configuration draft. */
  onChange: (configuration: WorkItemConfiguration) => void
}

/**
 * Chooses, for each completion Gate condition, whether it is off, only warns, or blocks completion.
 *
 * @param props - Draft configuration and the change callback.
 * @returns The completion Gate section.
 */
export function CompletionGateConfigurationSection({
  configuration,
  locale,
  onChange,
}: CompletionGateConfigurationSectionProps) {
  const t = createTranslator(locale)
  const id = useId()

  /**
   * Stores one condition's requirement in the draft, leaving the other conditions as they are.
   *
   * @param condition - Condition being changed.
   * @param requirement - Requirement chosen for it.
   */
  const setRequirement = (
    condition: WorkItemCompletionGateConditionId,
    requirement: WorkItemCompletionGateRequirement,
  ) => {
    onChange({
      ...configuration,
      completionGate: { ...configuration.completionGate, [policyKeys[condition]]: requirement },
    })
  }

  return (
    <section
      aria-describedby={`${id}-help`}
      aria-labelledby={`${id}-title`}
      className="workbench-panel grid gap-3 px-5 py-4"
      data-testid="work-item-configuration-completion-gate"
    >
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>
        {t('workItems.configuration.completionGate.title')}
      </h3>
      <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]" id={`${id}-help`}>
        {t('workItems.configuration.completionGate.help')}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {WORK_ITEM_COMPLETION_GATE_CONDITIONS.map((condition) => (
          <label
            className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]"
            htmlFor={`${id}-${condition}`}
            key={condition}
          >
            {t(conditionLabelKeys[condition])}
            <select
              className="workbench-input min-h-10 w-full min-w-0 px-3"
              id={`${id}-${condition}`}
              onChange={(event) => {
                const next = event.currentTarget.value
                if (isWorkItemCompletionGateRequirement(next)) setRequirement(condition, next)
              }}
              value={getWorkItemCompletionGateRequirement(configuration.completionGate, condition)}
            >
              {WORK_ITEM_COMPLETION_GATE_REQUIREMENTS.map((option) => (
                <option key={option} value={option}>{t(requirementLabelKeys[option])}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  )
}
