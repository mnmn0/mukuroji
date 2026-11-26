import {
  PROJECT_EXPENSE_RECEIPTS_MAX,
  type DecideProjectExpenseRequest,
  type ProjectExpense,
  type ProjectExpenseInput,
} from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { formatMinorAmount, parseMajorAmount } from '../model/timeReport'
import { interpolate, timeEntryStatusBadgeClasses, timeEntryStatusKeys, type TimeTrackingTranslator } from './timeTrackingText'

/** Props of {@link ProjectExpensesPanel}. */
export type ProjectExpensesPanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Display locale, used for money. */
  locale: Locale
  /** Expenses of the Project, newest date first, once loaded. */
  expenses?: readonly ProjectExpense[]
  /** Member key of the viewer, who cannot decide expenses they submitted. */
  viewerMemberId?: string
  /** Currency the form starts with, usually the budget currency. */
  defaultCurrency: string
  /** Today's local date, the form's default date. */
  today: string
  /** Whether the list is loading. */
  isLoading?: boolean
  /** Whether the list read failed. */
  hasLoadError?: boolean
  /** Reloads the list. */
  onRetry: () => void
  /** Uploads the receipts and submits the expense. */
  onSubmit: (input: ProjectExpenseInput, receipts: readonly File[]) => Promise<unknown>
  /** Approves or rejects an expense. */
  onDecide: (expense: ProjectExpense, request: Omit<DecideProjectExpenseRequest, 'expectedRevision'>) => Promise<unknown>
  /** Deletes an expense that is not approved. */
  onDelete: (expense: ProjectExpense) => Promise<unknown>
}

/**
 * Expenses other than people's time (subcontracting, licenses, and the like) of one Project, with
 * a form to submit one with receipts and buttons to approve or reject. A submitted expense counts
 * toward the budget once another Project manager approves it (ADR 0104).
 *
 * @param props - Expenses and actions.
 * @returns The panel.
 */
export function ProjectExpensesPanel({
  defaultCurrency,
  expenses,
  hasLoadError = false,
  isLoading = false,
  locale,
  onDecide,
  onDelete,
  onRetry,
  onSubmit,
  t,
  today,
  viewerMemberId,
}: ProjectExpensesPanelProps) {
  const [busyId, setBusyId] = useState<string>()
  const [actionError, setActionError] = useState(false)
  const [rejecting, setRejecting] = useState<{ id: string; note: string }>()

  /**
   * Runs one row action, showing a failure until the next action.
   *
   * @param expense - Expense acted on.
   * @param action - Action to run.
   */
  const runRowAction = async (expense: ProjectExpense, action: () => Promise<unknown>) => {
    setBusyId(expense.id)
    setActionError(false)
    try {
      await action()
      setRejecting(undefined)
    } catch {
      setActionError(true)
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <section className="workbench-panel grid gap-4 px-5 py-4" data-testid="project-expenses">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.projectExpenses.title')}</h2>
        <p className="mt-1 text-sm text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.description')}</p>
      </div>
      <ExpenseForm defaultCurrency={defaultCurrency} onSubmit={onSubmit} t={t} today={today} />
      {actionError ? (
        <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('timeTracking.projectExpenses.actionError')}</p>
      ) : null}
      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 text-sm" role="alert">
          <span className="font-semibold text-fg-red-700">{t('timeTracking.projectExpenses.loadError')}</span>
          <button className="workbench-button-secondary inline-flex min-h-9 items-center px-3" type="button" onClick={onRetry}>{t('timeTracking.projectBudget.retry')}</button>
        </div>
      ) : isLoading || !expenses ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('timeTracking.projectExpenses.loading')}</p>
      ) : expenses.length === 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.empty')}</p>
      ) : (
        <ul className="grid gap-2" data-testid="project-expense-list">
          {expenses.map((expense) => {
            const own = expense.submittedByMemberId === viewerMemberId
            const busy = busyId === expense.id
            return (
              <li className="grid gap-2 rounded-md border border-[var(--workbench-border)] px-3 py-2 text-sm" data-testid="project-expense" key={expense.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-[var(--workbench-text)]">{expense.category}</span>
                    <span className="ml-2 text-xs text-[var(--workbench-muted)]">{expense.date}</span>
                  </div>
                  <div className="flex items-baseline gap-3">
                    <span className="font-semibold tabular-nums text-[var(--workbench-text)]">{formatMinorAmount(expense.amountMinor, expense.currency, locale)}</span>
                    <span className={timeEntryStatusBadgeClasses[expense.status]}>{t(timeEntryStatusKeys[expense.status])}</span>
                  </div>
                </div>
                {expense.description ? <p className="break-words text-[var(--workbench-muted)]">{expense.description}</p> : null}
                <p className="text-xs text-[var(--workbench-muted)]">
                  {expense.receiptFileIds.length === 0
                    ? t('timeTracking.projectExpenses.noReceipt')
                    : interpolate(t('timeTracking.projectExpenses.receipts'), { count: expense.receiptFileIds.length })}
                  {expense.decision?.note ? ` / ${expense.decision.note}` : ''}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {expense.status === 'submitted' && !own ? (
                    <>
                      <button
                        className="workbench-button-primary inline-flex min-h-9 items-center px-3"
                        disabled={busy}
                        type="button"
                        onClick={() => { void runRowAction(expense, () => onDecide(expense, { outcome: 'approved' })) }}
                      >
                        {t('timeTracking.projectExpenses.approve')}
                      </button>
                      <button
                        className="workbench-button-secondary inline-flex min-h-9 items-center px-3"
                        disabled={busy}
                        type="button"
                        onClick={() => setRejecting({ id: expense.id, note: '' })}
                      >
                        {t('timeTracking.projectExpenses.reject')}
                      </button>
                    </>
                  ) : null}
                  {expense.status === 'submitted' && own ? (
                    <span className="text-xs text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.waitingForOther')}</span>
                  ) : null}
                  {expense.status !== 'approved' ? (
                    <button
                      className="workbench-button-secondary inline-flex min-h-9 items-center px-3"
                      disabled={busy}
                      type="button"
                      onClick={() => { void runRowAction(expense, () => onDelete(expense)) }}
                    >
                      {t('timeTracking.projectExpenses.delete')}
                    </button>
                  ) : null}
                </div>
                {rejecting?.id === expense.id ? (
                  <div className="grid gap-2">
                    <label className="grid gap-1">
                      <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.rejectNote')}</span>
                      <textarea
                        className="workbench-input min-h-16 px-2 py-1"
                        maxLength={1000}
                        value={rejecting.note}
                        onChange={(event) => setRejecting({ id: expense.id, note: event.target.value })}
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        className="workbench-button-primary inline-flex min-h-9 items-center px-3"
                        disabled={busy}
                        type="button"
                        onClick={() => {
                          const note = rejecting.note.trim()
                          void runRowAction(expense, () => onDecide(expense, { outcome: 'rejected', ...(note ? { note } : {}) }))
                        }}
                      >
                        {t('timeTracking.projectExpenses.confirmReject')}
                      </button>
                      <button className="workbench-button-secondary inline-flex min-h-9 items-center px-3" type="button" onClick={() => setRejecting(undefined)}>
                        {t('timeTracking.projectExpenses.cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * Form that submits one expense with its receipts.
 *
 * @param props - Default currency and date, submit action, and translator.
 * @returns The form.
 */
function ExpenseForm({
  defaultCurrency,
  onSubmit,
  t,
  today,
}: Pick<ProjectExpensesPanelProps, 'defaultCurrency' | 'onSubmit' | 't' | 'today'>) {
  const id = useId()
  const [error, setError] = useState<MessageKey>()
  const [saving, setSaving] = useState(false)
  const [formKey, setFormKey] = useState(0)

  /**
   * Validates the form and submits the expense.
   *
   * @param event - Form submit event.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const read = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value.trim() : ''
    }
    const currency = read('currency').toUpperCase()
    const amountMinor = /^[A-Z]{3}$/u.test(currency) ? parseMajorAmount(read('amount'), currency) : undefined
    const receipts = data.getAll('receipts').filter((value): value is File => value instanceof File && value.size > 0)
    if (!read('date') || !read('category')) return setError('timeTracking.projectExpenses.required')
    if (amountMinor === undefined || amountMinor <= 0) return setError('timeTracking.projectExpenses.invalidAmount')
    if (receipts.length > PROJECT_EXPENSE_RECEIPTS_MAX) return setError('timeTracking.projectExpenses.tooManyReceipts')
    setError(undefined)
    setSaving(true)
    try {
      const description = read('description')
      await onSubmit({
        date: read('date'),
        category: read('category'),
        amountMinor,
        currency,
        ...(description ? { description } : {}),
      }, receipts)
      setFormKey((key) => key + 1)
    } catch {
      setError('timeTracking.projectExpenses.submitError')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      aria-label={t('timeTracking.projectExpenses.formLabel')}
      className="grid gap-3 text-sm min-[600px]:grid-cols-6"
      key={formKey}
      onSubmit={(event) => { void submit(event) }}
    >
      <label className="grid gap-1 min-[600px]:col-span-2" htmlFor={`${id}-date`}>
        <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.date')}</span>
        <input className="workbench-input min-h-9 px-2" defaultValue={today} id={`${id}-date`} name="date" required type="date" />
      </label>
      <label className="grid gap-1 min-[600px]:col-span-2" htmlFor={`${id}-category`}>
        <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.category')}</span>
        <input className="workbench-input min-h-9 px-2" id={`${id}-category`} maxLength={80} name="category" placeholder={t('timeTracking.projectExpenses.categoryPlaceholder')} required />
      </label>
      <label className="grid gap-1" htmlFor={`${id}-amount`}>
        <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.amount')}</span>
        <input className="workbench-input min-h-9 px-2" id={`${id}-amount`} inputMode="decimal" name="amount" required />
      </label>
      <label className="grid gap-1" htmlFor={`${id}-currency`}>
        <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.currency')}</span>
        <input className="workbench-input min-h-9 px-2 uppercase" defaultValue={defaultCurrency} id={`${id}-currency`} maxLength={3} name="currency" required />
      </label>
      <label className="grid gap-1 min-[600px]:col-span-4" htmlFor={`${id}-description`}>
        <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectExpenses.descriptionLabel')}</span>
        <input className="workbench-input min-h-9 px-2" id={`${id}-description`} maxLength={1000} name="description" />
      </label>
      <label className="grid gap-1 min-[600px]:col-span-2" htmlFor={`${id}-receipts`}>
        <span className="text-xs font-semibold text-[var(--workbench-muted)]">
          {interpolate(t('timeTracking.projectExpenses.receiptInput'), { max: PROJECT_EXPENSE_RECEIPTS_MAX })}
        </span>
        <input className="text-xs" id={`${id}-receipts`} multiple name="receipts" type="file" />
      </label>
      <div className="flex flex-wrap items-center gap-3 min-[600px]:col-span-6">
        <button className="workbench-button-primary inline-flex min-h-9 items-center px-3" disabled={saving} type="submit">
          {t(saving ? 'timeTracking.projectExpenses.submitting' : 'timeTracking.projectExpenses.submit')}
        </button>
        {error ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{t(error)}</p> : null}
      </div>
    </form>
  )
}
