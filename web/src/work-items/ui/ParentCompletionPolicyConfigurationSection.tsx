import {
  DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY,
  WORK_ITEM_PARENT_COMPLETION_POLICIES,
  isWorkItemParentCompletionPolicy,
  type WorkItemConfiguration,
  type WorkItemParentCompletionPolicy,
} from '@mukuroji/contracts'
import { useId } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'

/** Option label of each parent completion policy. */
const parentCompletionLabelKeys = {
  warn: 'workItems.configuration.parentCompletion.warn',
  reject: 'workItems.configuration.parentCompletion.reject',
} as const satisfies Record<WorkItemParentCompletionPolicy, MessageKey>

/** Props accepted by the parent completion policy configuration section. */
export type ParentCompletionPolicyConfigurationSectionProps = {
  /** Configuration being edited. */
  configuration: WorkItemConfiguration
  /** Display locale. */
  locale: Locale
  /** Replaces the configuration draft. */
  onChange: (configuration: WorkItemConfiguration) => void
}

/**
 * Chooses whether completing a parent with open children only warns or is rejected.
 *
 * @param props - Draft configuration and the change callback.
 * @returns The parent completion policy section.
 */
export function ParentCompletionPolicyConfigurationSection({
  configuration,
  locale,
  onChange,
}: ParentCompletionPolicyConfigurationSectionProps) {
  const t = createTranslator(locale)
  const id = useId()
  const policy = configuration.parentCompletionPolicy ?? DEFAULT_WORK_ITEM_PARENT_COMPLETION_POLICY

  return (
    <section className="workbench-panel grid gap-2 px-5 py-4" data-testid="work-item-configuration-parent-completion">
      <label className="grid min-w-0 max-w-md gap-2 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-policy`}>
        {t('workItems.configuration.parentCompletion.label')}
        <select
          aria-describedby={`${id}-help`}
          className="workbench-input min-h-10 w-full min-w-0 px-3"
          id={`${id}-policy`}
          onChange={(event) => {
            const next = event.currentTarget.value
            if (isWorkItemParentCompletionPolicy(next)) onChange({ ...configuration, parentCompletionPolicy: next })
          }}
          value={policy}
        >
          {WORK_ITEM_PARENT_COMPLETION_POLICIES.map((option) => (
            <option key={option} value={option}>{t(parentCompletionLabelKeys[option])}</option>
          ))}
        </select>
      </label>
      <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]" id={`${id}-help`}>
        {t('workItems.configuration.parentCompletion.help')}
      </p>
    </section>
  )
}
