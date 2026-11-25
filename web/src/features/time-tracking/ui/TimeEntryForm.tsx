import type { TimeEntry } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import type { TimeEntryDraftInput } from '../api/timeEntries'
import { maxTimeEntryMinutes } from '../model/timeEntryLifecycle'
import { countLocalDaysBetween, resolveLocalInstant, shiftLocalDate, toLocalDateKey, toLocalTimeInput } from '../model/timePeriod'
import { describeTimeTrackingFailure, type TimeTrackingTranslator } from './timeTrackingText'
import { useTimeEntryFormSessionDraft } from './useTimeEntryFormSessionDraft'

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
  /**
   * Identifies a new entry's form, so its input survives an ended session and comes back after
   * the same account signs in again. Without it nothing is kept.
   */
  sessionDraftKey?: string
}

/**
 * Form that records or edits a manual time entry in local date and time.
 *
 * The end has its own date so an interval that crosses midnight keeps its days. Moving the start
 * date moves the end date by the same number of days, which keeps the interval's length.
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
  sessionDraftKey,
  t,
  workItemOptions = [],
}: TimeEntryFormProps) {
  const id = useId()
  const [error, setError] = useState<string>()
  const [isSaving, setIsSaving] = useState(false)
  const [startDate, setStartDate] = useState(() => entry ? toLocalDateKey(entry.startAt) : defaultDate)
  const [endDate, setEndDate] = useState(() => entry ? toLocalDateKey(entry.endAt) : defaultDate)
  // Last complete start date, so a date typed in pieces still moves the end date once it is whole.
  const [anchorStartDate, setAnchorStartDate] = useState(startDate)
  // Held in state, so the chosen Work Item stays selected while the options load or change.
  const [selectedWorkItemId, setSelectedWorkItemId] = useState(() => entry?.workItemId ?? fixedWorkItemId ?? '')
  const sessionDraft = useTimeEntryFormSessionDraft(sessionDraftKey, (draft) => {
    if (draft.fields.workItemId !== undefined) setSelectedWorkItemId(draft.fields.workItemId)
    const restoredStartDate = draft.fields.date
    const restoredEndDate = draft.fields.endDate
    if (restoredStartDate !== undefined) {
      setStartDate(restoredStartDate)
      setAnchorStartDate(restoredStartDate)
    }
    if (restoredEndDate !== undefined) setEndDate(restoredEndDate)
  })
  const restoredFields = sessionDraft.restored?.fields
  const hasSelectedOption = workItemOptions.some((option) => option.id === selectedWorkItemId)

  /**
   * Moves the start date and carries the end date along by the same number of days.
   *
   * @param nextStartDate - Date typed into the start date field.
   */
  const changeStartDate = (nextStartDate: string) => {
    setStartDate(nextStartDate)
    const movedDays = countLocalDaysBetween(anchorStartDate, nextStartDate)
    if (movedDays === undefined) return
    setAnchorStartDate(nextStartDate)
    const nextEndDate = shiftLocalDate(endDate, movedDays)
    if (nextEndDate) setEndDate(nextEndDate)
  }

  /**
   * Validates the local inputs and saves the entry.
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
    const workItemId = fixedWorkItemId ?? readText('workItemId')
    const startAt = resolveLocalInstant(entry?.startAt, readText('date'), readText('start'))
    const endAt = resolveLocalInstant(entry?.endAt, readText('endDate'), readText('end'))
    if (!workItemId) {
      setError(t('timeTracking.form.workItemRequired'))
      return
    }
    if (!startAt || !endAt) {
      setError(t('timeTracking.form.invalidTime'))
      return
    }
    const minutes = (Date.parse(endAt) - Date.parse(startAt)) / 60_000
    if (minutes <= 0) {
      setError(t('timeTracking.form.endBeforeStart'))
      return
    }
    if (minutes > maxTimeEntryMinutes) {
      setError(t('timeTracking.form.tooLong'))
      return
    }
    setError(undefined)
    setIsSaving(true)
    try {
      await onSave({ workItemId, startAt, endAt, description: readText('description'), billable: data.get('billable') === 'on' })
      sessionDraft.forget()
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
      key={sessionDraft.formKey}
      noValidate
      onChange={sessionDraft.handleChange}
      onSubmit={(event) => { void submit(event) }}
    >
      {sessionDraft.restored ? (
        <p className="text-xs font-semibold text-fg-amber-900" role="status">{t('timeTracking.form.sessionDraftRestored')}</p>
      ) : null}
      {fixedWorkItemId ? null : (
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-work-item`}>
          {t('timeTracking.form.workItem')}
          <select
            className="workbench-input h-9 w-full min-w-0 px-3"
            id={`${id}-work-item`}
            name="workItemId"
            onChange={(event) => setSelectedWorkItemId(event.target.value)}
            required
            value={selectedWorkItemId}
          >
            <option value="">{t('timeTracking.form.workItemPlaceholder')}</option>
            {selectedWorkItemId && !hasSelectedOption ? <option value={selectedWorkItemId}>{selectedWorkItemId}</option> : null}
            {workItemOptions.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select>
        </label>
      )}
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-date`}>
          {t('timeTracking.form.date')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            id={`${id}-date`}
            name="date"
            onChange={(event) => changeStartDate(event.target.value)}
            required
            type="date"
            value={startDate}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-start`}>
          {t('timeTracking.form.start')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={entry ? toLocalTimeInput(entry.startAt) : restoredFields?.start ?? '09:00'}
            id={`${id}-start`}
            name="start"
            required
            type="time"
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-end-date`}>
          {t('timeTracking.form.endDate')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            id={`${id}-end-date`}
            name="endDate"
            onChange={(event) => setEndDate(event.target.value)}
            required
            type="date"
            value={endDate}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-end`}>
          {t('timeTracking.form.end')}
          <input
            className="workbench-input h-9 w-full min-w-0 px-3"
            defaultValue={entry ? toLocalTimeInput(entry.endAt) : restoredFields?.end ?? '10:00'}
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
          defaultValue={entry?.description ?? restoredFields?.description ?? ''}
          id={`${id}-description`}
          maxLength={4000}
          name="description"
        />
      </label>
      <label className="flex items-center gap-2 text-sm font-medium text-[var(--workbench-text)]">
        <input defaultChecked={entry?.billable ?? sessionDraft.restored?.billable ?? false} name="billable" type="checkbox" />
        {t('timeTracking.form.billable')}
      </label>
      {error ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="workbench-button-primary min-h-9 px-4" disabled={isSaving} type="submit">
          {entry ? t('timeTracking.form.saveChanges') : t('timeTracking.form.create')}
        </button>
        <button className="workbench-button-secondary min-h-9 px-4" disabled={isSaving} onClick={() => { sessionDraft.forget(); onCancel() }} type="button">
          {t('timeTracking.form.cancel')}
        </button>
      </div>
    </form>
  )
}
