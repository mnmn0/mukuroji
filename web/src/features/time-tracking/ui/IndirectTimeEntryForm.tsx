import type { TimeEntry } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import type { IndirectTimeEntryInput } from '../api/timeEntries'
import { selectSelectableTimeEntryCategories } from '../model/timeEntryCategories'
import { useTimeEntryCategories } from './timeEntryCategoryContext'
import { parseHoursInput, readIndirectMinutes, resolveBrowserTimeZone, toLocalDateKey } from '../model/timePeriod'
import { describeTimeEntryCategory, describeTimeTrackingFailure, type TimeTrackingTranslator } from './timeTrackingText'

/** A Project a member may record indirect work on. */
export type IndirectTimeEntryProjectOption = {
  /** Project identifier. */
  id: string
  /** Display name. */
  name: string
}

/** Where a member may record indirect work: Projects, and whether Team-level time without one is allowed. */
export type IndirectTimeEntryTargets = {
  /** Projects of the Team the member may record time on. */
  projects: readonly IndirectTimeEntryProjectOption[]
  /** Whether time without a Project may be recorded. */
  allowNoProject: boolean
}

/** Props of the indirect-work form. */
export type IndirectTimeEntryFormProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Entry being edited; omitted for new indirect work. */
  entry?: TimeEntry
  /** Projects offered, and whether no Project may be chosen. */
  targets: IndirectTimeEntryTargets
  /** Local date preselected for new work, as `YYYY-MM-DD`. */
  defaultDate: string
  /** Saves the work; a rejection is shown in the form. */
  onSave: (input: IndirectTimeEntryInput) => Promise<void>
  /** Closes the form without saving. */
  onCancel: () => void
}

/**
 * Formats minutes as the hours shown in the form.
 *
 * @param minutes - Recorded minutes.
 * @returns Hours with at most two decimals, such as `1.5`.
 */
function formatHoursInput(minutes: number): string {
  return String(Math.round(minutes / 60 * 100) / 100)
}

/**
 * Form that records or edits indirect work, such as a meeting, as a category, a date, and hours,
 * without a Work Item.
 *
 * @param props - Entry, targets, and actions.
 * @returns Form.
 */
export function IndirectTimeEntryForm({
  defaultDate,
  entry,
  onCancel,
  onSave,
  t,
  targets,
}: IndirectTimeEntryFormProps) {
  const id = useId()
  const categories = useTimeEntryCategories()
  const categoryOptions = selectSelectableTimeEntryCategories(categories, entry?.category)
  const defaultCategory = entry?.category ?? (categoryOptions.includes('meeting') ? 'meeting' : categoryOptions[0] ?? '')
  const [error, setError] = useState<string>()
  const [isSaving, setIsSaving] = useState(false)
  const currentProjectId = entry?.projectId
  const hasCurrentProject = currentProjectId === undefined || targets.projects.some((project) => project.id === currentProjectId)
  const defaultProjectId = entry ? currentProjectId ?? '' : targets.allowNoProject ? '' : targets.projects[0]?.id ?? ''
  const defaultDateText = entry ? toLocalDateKey(entry.startAt) : defaultDate
  const defaultHoursText = entry ? formatHoursInput(entry.durationMinutes) : '1'

  /**
   * Validates the inputs and saves the work.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSaving) return
    const data = new FormData(event.currentTarget)
    /**
     * Reads one text field of the submitted form.
     *
     * @param name - Field name.
     * @returns The field text, or an empty string when it is missing or not text.
     */
    const readText = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
    }
    const category = readText('category')
    const date = readText('date')
    const hours = readText('hours')
    // A timed entry keeps its start and end unless the member changes its date or hours.
    const keepRecordedInterval = entry !== undefined && entry.durationOnly !== true
      && date === defaultDateText && (hours === defaultHoursText || parseHoursInput(hours) === entry.durationMinutes)
    const minutes = keepRecordedInterval ? entry.durationMinutes : readIndirectMinutes(hours)
    const projectId = readText('projectId')
    if (!categoryOptions.includes(category) || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      setError(t('timeTracking.form.invalidTime'))
      return
    }
    if (minutes === undefined) {
      setError(t('timeTracking.indirect.invalidHours'))
      return
    }
    setError(undefined)
    setIsSaving(true)
    try {
      await onSave({
        category,
        ...(projectId ? { projectId } : {}),
        date,
        minutes,
        timeZone: resolveBrowserTimeZone(),
        description: readText('description'),
        billable: data.get('billable') === 'on',
        ...(keepRecordedInterval ? { keepRecordedInterval } : {}),
      })
    } catch (saveError) {
      setError(describeTimeTrackingFailure(t, saveError))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form
      aria-label={entry ? t('timeTracking.indirect.editTitle') : t('timeTracking.indirect.createTitle')}
      className="grid min-w-0 gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3"
      data-testid="indirect-time-entry-form"
      noValidate
      onSubmit={(event) => { void submit(event) }}
    >
      {entry ? null : <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.indirect.hint')}</p>}
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-category`}>
          {t('timeTracking.indirect.category')}
          <select
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={defaultCategory}
            id={`${id}-category`}
            name="category"
          >
            {categoryOptions.map((category) => (
              <option key={category} value={category}>{describeTimeEntryCategory(t, category, categories)}</option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-project`}>
          {t('timeTracking.indirect.project')}
          <select
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={defaultProjectId}
            id={`${id}-project`}
            name="projectId"
          >
            {targets.allowNoProject || (entry && currentProjectId === undefined)
              ? <option value="">{t('timeTracking.indirect.noProject')}</option>
              : null}
            {currentProjectId !== undefined && !hasCurrentProject ? <option value={currentProjectId}>{currentProjectId}</option> : null}
            {targets.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-date`}>
          {t('timeTracking.form.date')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={defaultDateText}
            id={`${id}-date`}
            name="date"
            required
            type="date"
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-hours`}>
          {t('timeTracking.indirect.hours')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={defaultHoursText}
            id={`${id}-hours`}
            inputMode="decimal"
            name="hours"
            required
            type="text"
          />
        </label>
      </div>
      <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-description`}>
        {t('timeTracking.form.description')}
        <textarea
          className="workbench-input min-h-16 w-full min-w-0 px-3 py-2"
          defaultValue={entry?.description ?? ''}
          id={`${id}-description`}
          maxLength={4000}
          name="description"
        />
      </label>
      <label className="flex items-center gap-2 text-sm font-medium text-[var(--workbench-text)]">
        <input defaultChecked={entry?.billable ?? false} name="billable" type="checkbox" />
        {t('timeTracking.form.billable')}
      </label>
      {error ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="workbench-button-primary min-h-9 px-4" disabled={isSaving} type="submit">
          {entry ? t('timeTracking.form.saveChanges') : t('timeTracking.form.create')}
        </button>
        <button className="workbench-button-secondary min-h-9 px-4" disabled={isSaving} onClick={onCancel} type="button">
          {t('timeTracking.form.cancel')}
        </button>
      </div>
    </form>
  )
}
