import type { MessageKey } from '../../shared/i18n/i18n'
import type { WorkItemTemplate } from '../model/workItemDuplicate'

/** Props accepted by the Work Item template picker of the create panels. */
export type WorkItemTemplatePickerProps = {
  /** Enabled Work Item templates of the destination Team. */
  templates: readonly WorkItemTemplate[]
  /** Template the current draft starts from; absent without one. */
  selectedTemplateId?: string
  /** Whether the list could not be loaded. */
  hasLoadError?: boolean
  /** Loads the list again after a failed load; no retry button without it. */
  onRetry?: () => void
  /** Whether the picker is disabled, such as while the form is saving. */
  disabled?: boolean
  /** Starts the draft from the picked template, or from an empty form when undefined. */
  onSelect: (template: WorkItemTemplate | undefined) => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** Test ID of the select element. */
  testId: string
}

/**
 * Lets a member start a new Work Item from a Work Item template.
 *
 * The picker renders nothing when there is no template to offer and the list loaded.
 *
 * @param props - Templates, the current selection, and the selection callback.
 * @returns The template select, a load error, or nothing.
 */
export function WorkItemTemplatePicker({
  disabled = false,
  hasLoadError = false,
  onRetry,
  onSelect,
  selectedTemplateId,
  t,
  templates,
  testId,
}: WorkItemTemplatePickerProps) {
  if (hasLoadError) {
    return (
      <div className="flex flex-wrap items-center gap-2" role="status">
        <p className="text-xs font-semibold text-fg-amber-700">{t('issues.template.loadError')}</p>
        {onRetry ? (
          <button className="workbench-button-secondary min-h-8 px-3 text-xs" onClick={onRetry} type="button">
            {t('issues.template.retry')}
          </button>
        ) : null}
      </div>
    )
  }
  if (templates.length === 0) return null
  return (
    <label className="grid min-w-0 max-w-[420px] gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {t('issues.template.label')}
      <select
        className="workbench-input h-10 w-full min-w-0 px-3"
        data-testid={testId}
        disabled={disabled}
        onChange={(event) => {
          const templateId = event.target.value
          onSelect(templates.find((template) => template.id === templateId))
        }}
        value={selectedTemplateId ?? ''}
      >
        <option value="">{t('issues.template.none')}</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
      <span className="text-xs font-medium text-[var(--workbench-muted)]">{t('issues.template.help')}</span>
    </label>
  )
}
