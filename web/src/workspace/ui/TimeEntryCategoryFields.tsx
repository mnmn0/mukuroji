import {
  MAX_TIME_ENTRY_CATEGORY_LABEL_LENGTH,
  MAX_WORKSPACE_TIME_ENTRY_CATEGORIES,
  isBuiltInTimeEntryCategory,
  type TimeEntryCategoryDefinition,
  type WorkspaceTimeEntryCategorySettings,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  addTimeEntryCategory,
  builtInCategoryLabelKeys,
  hasTimeEntryCategoryProblem,
  moveTimeEntryCategory,
} from '../model/timeEntryCategories'


/** Props of the work category editor. */
export type TimeEntryCategoryFieldsProps = {
  /** Settings being edited. */
  settings: WorkspaceTimeEntryCategorySettings
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: WorkspaceTimeEntryCategorySettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Edits the work categories members record time under: their names, whether new time may use
 * them, and their order. A category is retired rather than removed, so older entries keep its name.
 *
 * @param props - Settings draft, lock state, change callback, and translator.
 * @returns The category list and the field that adds a category.
 */
export function TimeEntryCategoryFields({ settings, disabled, onChange, t }: TimeEntryCategoryFieldsProps) {
  const [newLabel, setNewLabel] = useState('')
  const problem = hasTimeEntryCategoryProblem(settings)
  const isFull = settings.categories.length >= MAX_WORKSPACE_TIME_ENTRY_CATEGORIES

  /**
   * Replaces one category in the draft.
   *
   * @param index - Position of the category.
   * @param category - Edited category.
   */
  const update = (index: number, category: TimeEntryCategoryDefinition) => {
    onChange({ categories: settings.categories.map((current, position) => position === index ? category : current) })
  }

  /**
   * Changes a category name. A built-in category with no name goes back to its translated name.
   *
   * @param index - Position of the category.
   * @param category - Category being renamed.
   * @param label - Typed name.
   */
  const rename = (index: number, category: TimeEntryCategoryDefinition, label: string) => {
    const rest: TimeEntryCategoryDefinition = { key: category.key, active: category.active }
    update(index, label.trim() === '' && isBuiltInTimeEntryCategory(category.key) ? rest : { ...rest, label })
  }

  /** Adds the typed category and clears the field. */
  const add = () => {
    const next = addTimeEntryCategory(settings, newLabel)
    if (next === settings) return
    onChange(next)
    setNewLabel('')
  }

  return (
    <fieldset className="mt-5 grid gap-3" data-testid="tenant-time-entry-categories">
      <legend className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.timeEntryCategories.title')}
      </legend>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('workspace.tenantAdministration.timeEntryCategories.hint')}
      </p>
      <ol className="grid gap-2">
        {settings.categories.map((category, index) => {
          const builtInLabel = isBuiltInTimeEntryCategory(category.key) ? t(builtInCategoryLabelKeys[category.key]) : undefined
          const name = category.label || builtInLabel || category.key
          return (
            <li className="flex min-w-0 flex-wrap items-center gap-2" data-testid="tenant-time-entry-category" key={category.key}>
              <input
                aria-label={`${t('workspace.tenantAdministration.timeEntryCategories.name')} ${name}`}
                className="workbench-input h-9 min-w-0 flex-1 basis-40 px-3"
                disabled={disabled}
                maxLength={MAX_TIME_ENTRY_CATEGORY_LABEL_LENGTH}
                onChange={(event) => rename(index, category, event.target.value)}
                placeholder={builtInLabel}
                value={category.label ?? ''}
              />
              <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]">
                <input
                  checked={category.active}
                  disabled={disabled}
                  onChange={(event) => update(index, { ...category, active: event.target.checked })}
                  type="checkbox"
                />
                {t('workspace.tenantAdministration.timeEntryCategories.active')}
              </label>
              <button
                aria-label={`${t('workspace.tenantAdministration.timeEntryCategories.moveUp')} ${name}`}
                className="workbench-button-secondary min-h-8 px-2"
                disabled={disabled || index === 0}
                onClick={() => onChange(moveTimeEntryCategory(settings, index, -1))}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={`${t('workspace.tenantAdministration.timeEntryCategories.moveDown')} ${name}`}
                className="workbench-button-secondary min-h-8 px-2"
                disabled={disabled || index === settings.categories.length - 1}
                onClick={() => onChange(moveTimeEntryCategory(settings, index, 1))}
                type="button"
              >
                ↓
              </button>
            </li>
          )
        })}
      </ol>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          aria-label={t('workspace.tenantAdministration.timeEntryCategories.newName')}
          className="workbench-input h-9 min-w-0 flex-1 basis-40 px-3"
          data-testid="tenant-time-entry-category-new"
          disabled={disabled || isFull}
          maxLength={MAX_TIME_ENTRY_CATEGORY_LABEL_LENGTH}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an IME conversion does not add the category.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              add()
            }
          }}
          placeholder={t('workspace.tenantAdministration.timeEntryCategories.newName')}
          value={newLabel}
        />
        <button
          className="workbench-button-secondary min-h-9 px-3"
          disabled={disabled || isFull || newLabel.trim() === ''}
          onClick={add}
          type="button"
        >
          {t('workspace.tenantAdministration.timeEntryCategories.add')}
        </button>
      </div>
      {problem ? (
        <p className="text-xs text-fg-red-700" role="alert">
          {t('workspace.tenantAdministration.timeEntryCategories.invalid')}
        </p>
      ) : null}
    </fieldset>
  )
}
