import { useId, useRef, useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'

/** One place a quick-created Work Item can be put. */
export type MyTasksQuickCreateDestination = {
  /** Stable option value. */
  key: string
  /** Label shown in the destination select. */
  label: string
  /** Team that owns the new Work Item. */
  teamId: string
  /** Project the Work Item is assigned to; the Team alone when omitted. */
  projectId?: string
}

/** Values submitted by the quick create form. */
export type MyTasksQuickCreateInput = {
  /** Trimmed title. */
  title: string
  /** Chosen destination. */
  destination: MyTasksQuickCreateDestination
  /** Due date in `YYYY-MM-DD` form; unscheduled when omitted. */
  dueDate?: string
}

/** Props for the My Tasks quick create form. */
export type MyTasksQuickCreateProps = {
  /** Teams and Projects the person may create Work Items in. */
  destinations: readonly MyTasksQuickCreateDestination[]
  /** Creates the Work Item, assigned to the person; rejects when it was not created. */
  onCreate: (input: MyTasksQuickCreateInput) => Promise<void>
  /** Translator used for labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders a one-line form that adds a Work Item assigned to the current person.
 *
 * The title stays focused after each addition, so several Work Items can be added in a row with
 * the keyboard. Fields a Team requires beyond these are filled on the Team screen instead.
 *
 * @param props - Destinations, create callback, and translator.
 * @returns The quick create form, or nothing when no destination is writable.
 */
export function MyTasksQuickCreate({ destinations, onCreate, t }: MyTasksQuickCreateProps) {
  const [title, setTitle] = useState('')
  const [destinationKey, setDestinationKey] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; message: string }>()
  const titleRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const destinationId = useId()
  const dueDateId = useId()
  if (destinations.length === 0) return null
  const destination = destinations.find((candidate) => candidate.key === destinationKey) ?? destinations[0]

  /**
   * Creates the Work Item and keeps the form ready for the next one.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle || !destination || isSubmitting) return
    setIsSubmitting(true)
    setFeedback(undefined)
    try {
      await onCreate({
        destination,
        title: trimmedTitle,
        ...(dueDate ? { dueDate } : {}),
      })
      setTitle('')
      setFeedback({
        kind: 'success',
        message: t('workspace.myTasks.quickCreate.created').replace('{title}', trimmedTitle),
      })
    } catch {
      setFeedback({ kind: 'error', message: t('workspace.myTasks.quickCreate.error') })
    } finally {
      setIsSubmitting(false)
      titleRef.current?.focus()
    }
  }

  return (
    <form
      aria-label={t('workspace.myTasks.quickCreate.label')}
      className="workbench-panel grid gap-2 p-3"
      data-testid="my-tasks-quick-create"
      onSubmit={(event) => void submit(event)}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-[2_1_16rem] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={titleId}>
          {t('workspace.myTasks.quickCreate.title')}
          <input
            className="workbench-input h-10 min-w-0 px-3 text-sm"
            // Read-only rather than disabled while saving, so focus can return to the title.
            id={titleId}
            readOnly={isSubmitting}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('workspace.myTasks.quickCreate.placeholder')}
            ref={titleRef}
            required
            value={title}
          />
        </label>
        <label className="grid min-w-0 flex-[1_1_12rem] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={destinationId}>
          {t('workspace.myTasks.quickCreate.destination')}
          <select
            className="workbench-input h-10 min-w-0 px-3 text-sm"
            disabled={isSubmitting}
            id={destinationId}
            onChange={(event) => setDestinationKey(event.target.value)}
            value={destination?.key ?? ''}
          >
            {destinations.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>{candidate.label}</option>
            ))}
          </select>
        </label>
        <label className="grid flex-[0_1_10rem] gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={dueDateId}>
          {t('tasks.column.dueDate')}
          <input
            className="workbench-input h-10 min-w-0 px-3 text-sm"
            disabled={isSubmitting}
            id={dueDateId}
            onChange={(event) => setDueDate(event.target.value)}
            type="date"
            value={dueDate}
          />
        </label>
        <button
          className="workbench-button-primary h-10 px-4 max-[640px]:w-full"
          data-testid="my-tasks-quick-create-submit"
          disabled={isSubmitting || title.trim() === ''}
          type="submit"
        >
          {isSubmitting ? t('workspace.myTasks.quickCreate.submitting') : t('workspace.myTasks.quickCreate.submit')}
        </button>
      </div>
      <p
        className={feedback?.kind === 'error'
          ? 'text-sm font-semibold text-fg-red-700'
          : 'text-sm font-medium text-[var(--workbench-muted)]'}
        data-testid="my-tasks-quick-create-feedback"
        role={feedback?.kind === 'error' ? 'alert' : 'status'}
      >
        {feedback?.message ?? ''}
      </p>
    </form>
  )
}
