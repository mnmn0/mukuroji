import type { TimeEntry } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import type { TimeEntryDraftInput } from '../api/timeEntries'
import { maxTimeEntryMinutes } from '../model/timeEntryLifecycle'
import { toInstantFromLocal, toLocalDateKey, toLocalTimeInput } from '../model/timePeriod'
import { describeTimeTrackingFailure, type TimeTrackingTranslator } from './timeTrackingText'

/** A Work Item a member may record time on. */
export type TimeEntryWorkItemOption = {
  /** Work Item identifier. */
  id: string
  /** Display title. */
  title: string
}

/** Props of the manual time entry form. */
export type TimeEntryFormProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Entry being edited; omitted for a new entry. */
  entry?: TimeEntry
  /** Work Item recorded by the form; when omitted, `workItemOptions` provides a picker. */
  fixedWorkItemId?: string
  /** Work Items offered by the picker. */
  workItemOptions?: readonly TimeEntryWorkItemOption[]
  /** Local date preselected for a new entry, as `YYYY-MM-DD`. */
  defaultDate: string
  /** Saves the entry; a rejection is shown in the form. */
  onSave: (input: TimeEntryDraftInput) => Promise<void>
  /** Closes the form without saving. */
  onCancel: () => void
}

/**
 * Form that records or edits a manual time entry in local date and time.
 *
 * @param props - Entry, Work Item choice, and actions.
 * @returns Form.
 */
export function TimeEntryForm({
  defaultDate,
  entry,
  fixedWorkItemId,
  onCancel,
  onSave,
  t,
  workItemOptions = [],
}: TimeEntryFormProps) {
  const id = useId()
  const [error, setError] = useState<string>()
  const [isSaving, setIsSaving] = useState(false)
  const selectedWorkItemId = entry?.workItemId ?? fixedWorkItemId
  const hasSelectedOption = workItemOptions.some((option) => option.id === selectedWorkItemId)

  /**
   * Validates the local inputs and saves the entry.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSaving) return
    const data = new FormData(event.currentTarget)
    const readText = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
    }
    const workItemId = fixedWorkItemId ?? readText('workItemId')
    const date = readText('date')
    const startAt = toInstantFromLocal(date, readText('start'))
    const endAt = toInstantFromLocal(date, readText('end'))
    if (!workItemId) {
      setError(t('timeTracking.form.workItemRequired'))
      return
    }
    if (!startAt || !endAt) {
      setError(t('timeTracking.form.invalidTime'))
      return
    }
    const minutes = (Date.parse(endAt) - Date.parse(startAt)) / 60_000
    if (minutes <= 0 || minutes > maxTimeEntryMinutes) {
      setError(t('timeTracking.form.endBeforeStart'))
      return
    }
    setError(undefined)
    setIsSaving(true)
    try {
      await onSave({ workItemId, startAt, endAt, description: readText('description'), billable: data.get('billable') === 'on' })
    } catch (saveError) {
      setError(describeTimeTrackingFailure(t, saveError))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form
      aria-label={entry ? t('timeTracking.form.editTitle') : t('timeTracking.form.createTitle')}
      className="grid min-w-0 gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3"
      noValidate
      onSubmit={(event) => { void submit(event) }}
    >
      {fixedWorkItemId ? null : (
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-work-item`}>
          {t('timeTracking.form.workItem')}
          <select
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={selectedWorkItemId ?? ''}
            id={`${id}-work-item`}
            name="workItemId"
            required
          >
            <option value="">{t('timeTracking.form.workItemPlaceholder')}</option>
            {selectedWorkItemId && !hasSelectedOption ? <option value={selectedWorkItemId}>{selectedWorkItemId}</option> : null}
            {workItemOptions.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select>
        </label>
      )}
      <div className="grid min-w-0 grid-cols-3 gap-2 max-[520px]:grid-cols-1">
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-date`}>
          {t('timeTracking.form.date')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={entry ? toLocalDateKey(entry.startAt) : defaultDate}
            id={`${id}-date`}
            name="date"
            required
            type="date"
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-start`}>
          {t('timeTracking.form.start')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={entry ? toLocalTimeInput(entry.startAt) : '09:00'}
            id={`${id}-start`}
            name="start"
            required
            type="time"
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-end`}>
          {t('timeTracking.form.end')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={entry ? toLocalTimeInput(entry.endAt) : '10:00'}
            id={`${id}-end`}
            name="end"
            required
            type="time"
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
