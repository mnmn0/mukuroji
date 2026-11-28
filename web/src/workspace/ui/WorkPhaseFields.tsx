import {
  MAX_WORK_PHASE_LABEL_LENGTH,
  MAX_WORKSPACE_WORK_PHASES,
  isBuiltInWorkPhase,
  type WorkPhaseDefinition,
  type WorkspaceTimeEntryCategorySettings,
  type WorkspaceWorkPhaseSettings,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { addWorkPhase, hasWorkPhaseProblem, readWorkPhaseDisplayName, setWorkCategoryPhase } from '../model/workPhases'

/** Props of the work phase editor. */
export type WorkPhaseFieldsProps = {
  /** Phase settings being edited. */
  settings: WorkspaceWorkPhaseSettings
  /** Work categories whose phase the editor sets. */
  categories: WorkspaceTimeEntryCategorySettings
  /** Translated name of a work category. */
  categoryName: (key: string) => string
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: WorkspaceWorkPhaseSettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Edits the Workspace work phases (ADR 0115): their names, whether they are in use, and the phase
 * each work category counts toward. A phase is retired rather than removed, so statuses and reports
 * that use it keep its name.
 *
 * @param props - Settings draft, categories, lock state, change callback, and translator.
 * @returns The phase list, the field that adds a phase, and the category mapping.
 */
export function WorkPhaseFields({ settings, categories, categoryName, disabled, onChange, t }: WorkPhaseFieldsProps) {
  const [newLabel, setNewLabel] = useState('')
  const problem = hasWorkPhaseProblem(settings)
  const isFull = settings.phases.length >= MAX_WORKSPACE_WORK_PHASES

  /**
   * Replaces one phase in the draft.
   *
   * @param index - Position of the phase.
   * @param phase - Edited phase.
   */
  const update = (index: number, phase: WorkPhaseDefinition) => {
    onChange({ ...settings, phases: settings.phases.map((current, position) => position === index ? phase : current) })
  }

  /**
   * Changes a phase name. A built-in phase with no name goes back to its translated name.
   *
   * @param index - Position of the phase.
   * @param phase - Phase being renamed.
   * @param label - Typed name.
   */
  const rename = (index: number, phase: WorkPhaseDefinition, label: string) => {
    const rest: WorkPhaseDefinition = { key: phase.key, active: phase.active }
    update(index, label.trim() === '' && isBuiltInWorkPhase(phase.key) ? rest : { ...rest, label })
  }

  /** Adds the typed phase and clears the field. */
  const add = () => {
    const next = addWorkPhase(settings, newLabel)
    if (next === settings) return
    onChange(next)
    setNewLabel('')
  }

  return (
    <fieldset className="mt-5 grid gap-3" data-testid="tenant-work-phases">
      <legend className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.workPhases.title')}
      </legend>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('workspace.tenantAdministration.workPhases.hint')}
      </p>
      <ol className="grid gap-2">
        {settings.phases.map((phase, index) => {
          const builtInLabel = isBuiltInWorkPhase(phase.key) ? readWorkPhaseDisplayName(phase.key, undefined, t) : undefined
          const name = phase.label || builtInLabel || phase.key
          return (
            <li className="flex min-w-0 flex-wrap items-center gap-2" data-testid="tenant-work-phase" key={phase.key}>
              <input
                aria-label={`${t('workspace.tenantAdministration.workPhases.name')} ${name}`}
                className="workbench-input h-9 min-w-0 flex-1 basis-40 px-3"
                disabled={disabled}
                maxLength={MAX_WORK_PHASE_LABEL_LENGTH}
                onChange={(event) => rename(index, phase, event.target.value)}
                placeholder={builtInLabel}
                value={phase.label ?? ''}
              />
              <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]">
                <input
                  checked={phase.active}
                  disabled={disabled}
                  onChange={(event) => update(index, { ...phase, active: event.target.checked })}
                  type="checkbox"
                />
                {t('workspace.tenantAdministration.workPhases.active')}
              </label>
            </li>
          )
        })}
      </ol>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          aria-label={t('workspace.tenantAdministration.workPhases.newName')}
          className="workbench-input h-9 min-w-0 flex-1 basis-40 px-3"
          disabled={disabled || isFull}
          maxLength={MAX_WORK_PHASE_LABEL_LENGTH}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an IME conversion does not add the phase.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              add()
            }
          }}
          placeholder={t('workspace.tenantAdministration.workPhases.newName')}
          value={newLabel}
        />
        <button
          className="workbench-button-secondary min-h-9 px-3"
          disabled={disabled || isFull || newLabel.trim() === ''}
          onClick={add}
          type="button"
        >
          {t('workspace.tenantAdministration.workPhases.add')}
        </button>
      </div>
      <p className="text-xs font-semibold text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.workPhases.categoryMapping')}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {categories.categories.map((category) => (
          <li className="flex min-w-0 items-center gap-2" key={category.key}>
            <span className="min-w-0 flex-1 truncate text-sm text-[var(--workbench-text)]">{categoryName(category.key)}</span>
            <select
              aria-label={`${t('workspace.tenantAdministration.workPhases.categoryMapping')} ${categoryName(category.key)}`}
              className="workbench-input h-9 min-w-0 basis-40 px-2"
              disabled={disabled}
              onChange={(event) => onChange(setWorkCategoryPhase(settings, category.key, event.target.value))}
              value={settings.categoryPhases[category.key] ?? ''}
            >
              <option value="">{t('workspace.tenantAdministration.workPhases.none')}</option>
              {settings.phases
                .filter((phase) => phase.active || settings.categoryPhases[category.key] === phase.key)
                .map((phase) => (
                  <option key={phase.key} value={phase.key}>{readWorkPhaseDisplayName(phase.key, settings, t)}</option>
                ))}
            </select>
          </li>
        ))}
      </ul>
      {problem ? (
        <p className="text-xs text-fg-red-700" role="alert">
          {t('workspace.tenantAdministration.workPhases.invalid')}
        </p>
      ) : null}
    </fieldset>
  )
}
