import {
  DEFAULT_WORK_ITEM_PROGRESS_MODE,
  WORK_ITEM_PROGRESS_MODES,
  isWorkItemProgressMode,
  type WorkItemConfiguration,
  type WorkItemProgressMode,
} from '@mukuroji/contracts'
import { useId } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'

/** Option label of each progress mode. */
const progressModeLabelKeys = {
  'status-category': 'workItems.configuration.progressMode.status-category',
  'remaining-effort': 'workItems.configuration.progressMode.remaining-effort',
  manual: 'workItems.configuration.progressMode.manual',
} as const satisfies Record<WorkItemProgressMode, MessageKey>

/** Props accepted by the progress mode configuration section. */
export type ProgressModeConfigurationSectionProps = {
  /** Configuration being edited. */
  configuration: WorkItemConfiguration
  /** Display locale. */
  locale: Locale
  /** Replaces the configuration draft. */
  onChange: (configuration: WorkItemConfiguration) => void
}

/**
 * Chooses how the Team derives Work Item progress.
 *
 * Saving the configuration records the change in the configuration audit like any other
 * configuration change.
 *
 * @param props - Draft configuration and the change callback.
 * @returns The progress mode section.
 */
export function ProgressModeConfigurationSection({
  configuration,
  locale,
  onChange,
}: ProgressModeConfigurationSectionProps) {
  const t = createTranslator(locale)
  const id = useId()
  const mode = configuration.progressMode ?? DEFAULT_WORK_ITEM_PROGRESS_MODE

  return (
    <section className="workbench-panel grid gap-2 px-5 py-4" data-testid="work-item-configuration-progress-mode">
      <label className="grid min-w-0 max-w-md gap-2 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-mode`}>
        {t('workItems.configuration.progressMode.label')}
        <select
          aria-describedby={`${id}-help`}
          className="workbench-input min-h-10 w-full min-w-0 px-3"
          id={`${id}-mode`}
          onChange={(event) => {
            const next = event.currentTarget.value
            if (isWorkItemProgressMode(next)) onChange({ ...configuration, progressMode: next })
          }}
          value={mode}
        >
          {WORK_ITEM_PROGRESS_MODES.map((option) => (
            <option key={option} value={option}>{t(progressModeLabelKeys[option])}</option>
          ))}
        </select>
      </label>
      <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]" id={`${id}-help`}>
        {t('workItems.configuration.progressMode.help')}
      </p>
    </section>
  )
}
