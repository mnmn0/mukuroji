import {
  deriveWorkItemScheduleVariance,
  type CanonicalWorkItem,
  type WorkItemPatch,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  formatTaskScheduleVariance,
  resolveTaskScheduleVarianceTone,
  taskScheduleVarianceToneClasses,
} from '../model/taskActualDates'

/** Props for the plan-versus-actual section of the task detail pane. */
export type TaskActualDatesPanelProps = {
  /** Work Item whose plan and actual dates are shown. */
  task: CanonicalWorkItem
  /** Whether the viewer may correct the recorded actual dates. */
  canCorrect: boolean
  /** Disables the correction form while another mutation is pending or the view is read-only. */
  disabled: boolean
  /** Saves a correction patch containing only the changed actual dates. */
  onCorrect: (patch: Pick<WorkItemPatch, 'actualStartDate' | 'actualEndDate'>) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Shows the planned dates beside the recorded actual dates and the resulting delays.
 *
 * Team and Project managers also get a small form to correct the recorded dates.
 *
 * @param props - Work Item, permissions, and the correction callback.
 * @returns The plan-versus-actual section.
 */
export function TaskActualDatesPanel({
  task,
  canCorrect,
  disabled,
  onCorrect,
  t,
}: TaskActualDatesPanelProps) {
  const variance = deriveWorkItemScheduleVariance(task)
  const planned = [variance.plannedStartDate, variance.plannedEndDate]
    .filter((date, index, dates): date is string => date !== undefined && dates.indexOf(date) === index)
    .join(' – ')
  const notRecorded = t('tasks.detail.actualNotRecorded')
  const formId = `task-actual-dates-${task.teamId}-${task.id}`
  const isCompleted = task.statusCategory === 'completed'
  return (
    <section
      aria-label={t('tasks.detail.actualDates')}
      className="workbench-panel-muted grid min-w-0 gap-3 p-3"
      data-testid="task-detail-actual-dates"
    >
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('tasks.detail.actualDates')}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-[var(--workbench-muted)]">{t('tasks.detail.plannedDates')}</dt>
        <dd className="min-w-0 text-[var(--workbench-text)]">{planned || '—'}</dd>
        <dt className="text-[var(--workbench-muted)]">{t('tasks.column.actualStartDate')}</dt>
        <dd className="min-w-0 text-[var(--workbench-text)]" data-testid="task-detail-actual-start">
          {task.actualStartDate ?? notRecorded}
        </dd>
        <dt className="text-[var(--workbench-muted)]">{t('tasks.column.actualEndDate')}</dt>
        <dd className="min-w-0 text-[var(--workbench-text)]" data-testid="task-detail-actual-end">
          {task.actualEndDate ?? notRecorded}
        </dd>
        <VarianceRow days={variance.startDelayDays} label={t('tasks.column.startDelayDays')} t={t} />
        <VarianceRow
          days={variance.completionDelayDays}
          label={t('tasks.column.completionDelayDays')}
          t={t}
          testId="task-detail-completion-delay"
        />
      </dl>
      <p className="text-xs font-medium text-[var(--workbench-muted)]">{t('tasks.detail.actualDatesHint')}</p>
      {canCorrect ? (
        <form
          aria-label={t('tasks.detail.actualDatesSave')}
          className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
          id={formId}
          key={`${task.revision}:${task.actualStartDate ?? ''}:${task.actualEndDate ?? ''}`}
          onSubmit={(event) => {
            event.preventDefault()
            const formData = new FormData(event.currentTarget)
            const patch = createActualDateCorrection(task, formData, isCompleted)
            if (Object.keys(patch).length > 0) onCorrect(patch)
          }}
        >
          <ActualDateInput
            defaultValue={task.actualStartDate}
            disabled={disabled}
            label={t('tasks.column.actualStartDate')}
            name="actualStartDate"
          />
          <ActualDateInput
            defaultValue={task.actualEndDate}
            disabled={disabled || !isCompleted}
            label={t('tasks.column.actualEndDate')}
            name="actualEndDate"
          />
          <button
            className="workbench-button-secondary min-h-[44px] px-3 sm:col-span-2 disabled:border-slate-300 disabled:bg-slate-300"
            disabled={disabled}
            type="submit"
          >
            {t('tasks.detail.actualDatesSave')}
          </button>
        </form>
      ) : null}
    </section>
  )
}

/** Props for one delay row of the plan-versus-actual list. */
type VarianceRowProps = {
  /** Signed delay in calendar days, or undefined when unknown. */
  days: number | undefined
  /** Row label. */
  label: string
  /** Translator for the delay label. */
  t: (key: MessageKey) => string
  /** Optional test identifier for the value. */
  testId?: string
}

/**
 * Renders one delay row with its tone.
 *
 * @param props - Delay, label, and translator.
 * @returns The term and description pair.
 */
function VarianceRow({ days, label, t, testId }: VarianceRowProps) {
  const tone = resolveTaskScheduleVarianceTone(days)
  return (
    <>
      <dt className="text-[var(--workbench-muted)]">{label}</dt>
      <dd
        className={`min-w-0 ${tone ? taskScheduleVarianceToneClasses[tone] : 'text-[var(--workbench-muted)]'}`}
        data-testid={testId}
      >
        {formatTaskScheduleVariance(days, t)}
      </dd>
    </>
  )
}

/** Props for one optional actual date input. */
type ActualDateInputProps = {
  /** Recorded date, if any. */
  defaultValue: string | undefined
  /** Whether the input is disabled. */
  disabled: boolean
  /** Visible and accessible label. */
  label: string
  /** Form field name. */
  name: 'actualStartDate' | 'actualEndDate'
}

/**
 * Renders one optional native date input; an empty value removes the date.
 *
 * @param props - Current value, label, and form name.
 * @returns A labeled date input.
 */
function ActualDateInput({ defaultValue, disabled, label, name }: ActualDateInputProps) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input
        className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
        defaultValue={defaultValue ?? ''}
        disabled={disabled}
        name={name}
        type="date"
      />
    </label>
  )
}

/**
 * Builds a correction patch containing only the dates the manager changed.
 *
 * @param task - Work Item before the correction.
 * @param formData - Submitted correction form.
 * @param isCompleted - Whether the Work Item may carry an actual end date.
 * @returns The changed actual dates, with null for a removed date.
 */
function createActualDateCorrection(
  task: CanonicalWorkItem,
  formData: FormData,
  isCompleted: boolean,
): Pick<WorkItemPatch, 'actualStartDate' | 'actualEndDate'> {
  const patch: Pick<WorkItemPatch, 'actualStartDate' | 'actualEndDate'> = {}
  const start = readFormDate(formData, 'actualStartDate')
  if (start !== (task.actualStartDate ?? null)) patch.actualStartDate = start
  if (isCompleted) {
    const end = readFormDate(formData, 'actualEndDate')
    if (end !== (task.actualEndDate ?? null)) patch.actualEndDate = end
  }
  return patch
}

/**
 * Reads one optional date field from a form.
 *
 * @param formData - Submitted form.
 * @param name - Field name.
 * @returns The trimmed date, or null when empty.
 */
function readFormDate(formData: FormData, name: string): string | null {
  const value = formData.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
