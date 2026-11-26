import {
  TIME_BUDGET_ALERT_PERCENT_DEFAULT,
  TIME_BUDGET_ALERT_PERCENT_MAX,
  TIME_BUDGET_ALERT_PERCENT_MIN,
  isTimeBudgetAlertPercent,
  toWorkspaceLocalDate,
  type TimeBudget,
  type TimeTrackingSummary,
} from '@mukuroji/contracts'
import { useId, useMemo, useState, type FormEvent } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import type { SaveTimeBudgetInput, TimeReportBudgetScope } from '../api/timeReport'
import {
  compareTimeBudget,
  formatCostsByCurrency,
  formatMinorAmount,
  isTimeReportRangeOrdered,
  parseMajorAmount,
  toMajorAmountInput,
  type TimeReportRange,
} from '../model/timeReport'
import { formatMinutes } from '../model/timePeriod'
import { findTimeBudgetFiscalYear, listTimeBudgetFiscalYearOptions } from '../model/budgetFiscalYear'
import { TimeBudgetPeriodList } from './TimeBudgetPeriodList'
import { describeTimeTrackingFailure, interpolate, type TimeTrackingTranslator } from './timeTrackingText'

/** Project offered as a budget scope. */
export type TimeBudgetProjectOption = {
  /** Project ID. */
  id: string
  /** Project name. */
  name: string
}

/** Props of the budget panel. */
export type TimeBudgetPanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Display locale, used for money. */
  locale: Locale
  /** Projects of the Team, offered as budget scopes after the Team itself. */
  projects: readonly TimeBudgetProjectOption[]
  /** Budget shown. */
  scope: TimeReportBudgetScope
  /** Report of the period grouped by Project, carrying the budget of the scope. */
  summary?: TimeTrackingSummary
  /**
   * Inclusive local dates of the report period. A new budget per period starts with them, since
   * the summary carries its period as UTC instants.
   */
  reportRange: TimeReportRange
  /** Whether the budget is loading. */
  isLoading?: boolean
  /** Whether the read failed. */
  hasLoadError?: boolean
  /** Currency offered for a new budget. */
  defaultCurrency: string
  /** Changes the budget shown. */
  onChangeScope: (scope: TimeReportBudgetScope) => void
  /** Saves the budget of the scope shown. */
  onSave: (input: SaveTimeBudgetInput) => Promise<unknown>
  /** Deletes one of the scope's budgets per period. */
  onDeletePeriod: (budget: TimeBudget) => Promise<unknown>
  /** Shows the report for the budget's own period. */
  onUseBudgetPeriod: (range: TimeReportRange) => void
  /** Reloads the budget. */
  onRetry: () => void
  /**
   * First month of the Workspace fiscal year. The editor offers fiscal years as budget periods
   * once it is known.
   */
  fiscalYearStartMonth?: number
  /** Whether reading the Workspace fiscal year failed, so fiscal years cannot be offered. */
  hasFiscalYearError?: boolean
  /** Reads the Workspace fiscal year again. */
  onRetryFiscalYear?: () => void
}

const teamScopeValue = ''

/** Budget the editor saves: the one shown for the report period, or a new budget per period. */
type TimeBudgetEditTarget = 'shown' | 'newPeriod'

/**
 * Budget of the Team or one of its Projects next to the actual cost and hours of the report
 * period, with an editor. Shown only to members the server returns budgets and costs to.
 *
 * @param props - Scope, report, and actions.
 * @returns Budget panel.
 */
export function TimeBudgetPanel({
  defaultCurrency,
  fiscalYearStartMonth,
  hasFiscalYearError = false,
  hasLoadError = false,
  isLoading = false,
  locale,
  onChangeScope,
  onDeletePeriod,
  onRetry,
  onSave,
  onRetryFiscalYear,
  onUseBudgetPeriod,
  projects,
  reportRange,
  scope,
  summary,
  t,
}: TimeBudgetPanelProps) {
  const id = useId()
  const [editTarget, setEditTarget] = useState<TimeBudgetEditTarget>()
  const isEditing = editTarget !== undefined
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const projectId = scope.scopeType === 'project' ? scope.projectId : undefined
  const comparison = summary ? compareTimeBudget(summary, projectId) : undefined
  const budget = comparison?.budget
  const currency = budget?.currency ?? defaultCurrency
  const budgetPeriods = summary?.budgetPeriods ?? []
  // A budget per period keeps its dates; changing them would save another period's budget.
  const isPeriodLocked = editTarget === 'shown' && budget?.periodBudget === true
  const savesPeriodBudget = editTarget === 'newPeriod' || isPeriodLocked
  // Only a Project's default budget notifies its owner when its use reaches the alert (ADR 0105).
  const editsAlertPercent = projectId !== undefined && !savesPeriodBudget
  /**
   * Reads the period the editor starts with.
   *
   * @param target - Budget being edited.
   * @returns Start and end dates, empty when unset.
   */
  const initialPeriodOf = (target: TimeBudgetEditTarget | undefined) => target === 'newPeriod'
    // A new budget per period starts with the report period, which is the period it is compared with.
    ? { from: reportRange.from, to: reportRange.to }
    : { from: budget?.periodFrom ?? '', to: budget?.periodTo ?? '' }
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  // The key names the budget being edited, so switching to another period's budget, or between a
  // budget per period and the default budget, resets the form even at the same revision. Its update
  // time is part of it too: a period deleted and saved again restarts at the same revision, and the
  // form must not keep the old values while the save expects the new budget.
  const editedBudgetKey = editTarget === 'newPeriod'
    ? `new:${reportRange.from}/${reportRange.to}`
    : budget?.periodBudget ? `period:${budget.periodFrom ?? ''}/${budget.periodTo ?? ''}` : 'default'
  const formKey = `${projectId ?? 'team'}:${editTarget ?? 'closed'}:${editedBudgetKey}:${budget?.revision ?? 0}:${budget?.updatedAt ?? ''}`
  const [periodFormKey, setPeriodFormKey] = useState(formKey)
  if (periodFormKey !== formKey) {
    // The keyed form resets amount and currency when the saved budget changes; reset the period with them.
    const initial = initialPeriodOf(editTarget)
    setPeriodFormKey(formKey)
    setPeriodFrom(initial.from)
    setPeriodTo(initial.to)
  }
  const fiscalYearOptions = useMemo(
    () => fiscalYearStartMonth === undefined
      ? []
      : listTimeBudgetFiscalYearOptions(toWorkspaceLocalDate(new Date()), fiscalYearStartMonth),
    [fiscalYearStartMonth],
  )
  const selectedFiscalYear = fiscalYearStartMonth === undefined
    ? undefined
    : findTimeBudgetFiscalYear(periodFrom, periodTo, fiscalYearStartMonth)
  const budgetFiscalYear = fiscalYearStartMonth === undefined || !budget
    ? undefined
    : findTimeBudgetFiscalYear(budget.periodFrom, budget.periodTo, fiscalYearStartMonth)

  /**
   * Opens the editor with the period of the budget being edited.
   *
   * @param target - Budget being edited.
   */
  const startEditing = (target: TimeBudgetEditTarget) => {
    const initial = initialPeriodOf(target)
    setMessage(undefined)
    setPeriodFrom(initial.from)
    setPeriodTo(initial.to)
    setEditTarget(target)
  }

  /**
   * Deletes a budget per period and reports the outcome.
   *
   * @param target - Budget per period to delete.
   */
  const deletePeriod = async (target: TimeBudget) => {
    setMessage(undefined)
    // Only an editor of the deleted budget closes; a form opened while the delete ran stays open.
    const editsDeletedBudget = editTarget === 'shown' && budget?.periodBudget === true &&
      budget.periodFrom === target.periodFrom && budget.periodTo === target.periodTo
    try {
      await onDeletePeriod(target)
      if (editsDeletedBudget) setEditTarget(undefined)
      setMessage({ tone: 'status', text: t('timeTracking.budget.periodDeleted') })
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
    }
  }

  /**
   * Validates and saves the typed budget.
   *
   * @param event - Budget form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSaving) return
    const data = new FormData(event.currentTarget)
    /**
     * Reads one trimmed text field of the form.
     *
     * @param name - Field name.
     * @returns Trimmed value, or an empty string when absent.
     */
    const read = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value.trim() : ''
    }
    const nextCurrency = read('currency').toUpperCase()
    const amountMinor = /^[A-Z]{3}$/u.test(nextCurrency) ? parseMajorAmount(read('amount'), nextCurrency) : undefined
    if (amountMinor === undefined) {
      setMessage({ tone: 'error', text: t('timeTracking.budget.invalidAmount') })
      return
    }
    const alertPercent = editsAlertPercent && read('alertPercent') ? Number(read('alertPercent')) : undefined
    if (alertPercent !== undefined && !isTimeBudgetAlertPercent(alertPercent)) {
      setMessage({ tone: 'error', text: t('timeTracking.budget.invalidAlertPercent') })
      return
    }
    if (savesPeriodBudget && (!periodFrom || !periodTo)) {
      setMessage({ tone: 'error', text: t('timeTracking.budget.periodRequired') })
      return
    }
    if (periodFrom && periodTo && !isTimeReportRangeOrdered({ from: periodFrom, to: periodTo })) {
      setMessage({ tone: 'error', text: t('timeTracking.report.invalidRange') })
      return
    }
    // Saving a period that already has a budget replaces it, so its revision is expected.
    const replaced = editTarget === 'newPeriod'
      ? budgetPeriods.find((candidate) => candidate.periodFrom === periodFrom && candidate.periodTo === periodTo)
      : budget
    setIsSaving(true)
    setMessage(undefined)
    try {
      await onSave({
        amountMinor,
        currency: nextCurrency,
        ...(periodFrom ? { periodFrom } : {}),
        ...(periodTo ? { periodTo } : {}),
        ...(savesPeriodBudget ? { periodBudget: true } : {}),
        ...(alertPercent === undefined ? {} : { alertPercent }),
        expectedRevision: replaced?.revision ?? 0,
        ...(replaced ? { expectedUpdatedAt: replaced.updatedAt } : {}),
      })
      setEditTarget(undefined)
      setMessage({ tone: 'status', text: t('timeTracking.budget.saved') })
    } catch (error) {
      setMessage({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-4" data-testid="time-budget-panel">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.budget.title')}</h2>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('timeTracking.budget.scope')}
          <select
            className="workbench-input min-h-9 px-2"
            onChange={(event) => {
              setEditTarget(undefined)
              setMessage(undefined)
              onChangeScope(event.target.value === teamScopeValue ? { scopeType: 'team' } : { scopeType: 'project', projectId: event.target.value })
            }}
            value={projectId ?? teamScopeValue}
          >
            <option value={teamScopeValue}>{t('timeTracking.budget.teamScope')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      </div>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.budget.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isLoading ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}

      {summary && !isLoading ? (
        comparison ? (
          <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4" data-testid="time-budget-comparison">
            <div className="grid gap-0.5">
              <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.budget.amount')}</dt>
              <dd className="font-semibold tabular-nums text-[var(--workbench-text)]">{formatMinorAmount(comparison.budget.amountMinor, comparison.budget.currency, locale)}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.budget.actual')}</dt>
              <dd className="font-semibold tabular-nums text-[var(--workbench-text)]">
                {formatMinorAmount(comparison.actualMinor, comparison.budget.currency, locale)}
                <span className="ml-1 font-normal text-[var(--workbench-muted)]">({formatMinutes(comparison.actualMinutes)})</span>
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.budget.remaining')}</dt>
              <dd className={`font-semibold tabular-nums ${(comparison.remainingMinor ?? 0) < 0 ? 'text-fg-red-700' : 'text-[var(--workbench-text)]'}`}>
                {comparison.remainingMinor === undefined ? '—' : formatMinorAmount(comparison.remainingMinor, comparison.budget.currency, locale)}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.budget.used')}</dt>
              <dd className="font-semibold tabular-nums text-[var(--workbench-text)]">{comparison.usedPercent === undefined ? '—' : `${comparison.usedPercent}%`}</dd>
            </div>
            <div className="col-span-2 grid gap-0.5 sm:col-span-4">
              <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.budget.period')}</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2 text-[var(--workbench-text)]">
                {comparison.budget.periodFrom || comparison.budget.periodTo
                  ? `${comparison.budget.periodFrom ?? ''} – ${comparison.budget.periodTo ?? ''}`
                  : t('timeTracking.budget.noPeriod')}
                {comparison.budget.periodBudget ? (
                  <span className="rounded border border-[var(--workbench-border)] px-1.5 text-xs font-semibold" data-testid="time-budget-period-badge">
                    {t('timeTracking.budget.periodBudgetBadge')}
                  </span>
                ) : null}
                {budgetFiscalYear === undefined ? null : (
                  <span className="font-semibold" data-testid="time-budget-fiscal-year">
                    {interpolate(t('timeTracking.budget.fiscalYearLabel'), { year: String(budgetFiscalYear) })}
                  </span>
                )}
                {comparison.budget.periodFrom && comparison.budget.periodTo ? (
                  <button
                    className="workbench-button-secondary min-h-8 px-3"
                    onClick={() => {
                      if (comparison.budget.periodFrom && comparison.budget.periodTo) {
                        onUseBudgetPeriod({ from: comparison.budget.periodFrom, to: comparison.budget.periodTo })
                      }
                    }}
                    type="button"
                  >
                    {t('timeTracking.budget.usePeriod')}
                  </button>
                ) : null}
              </dd>
            </div>
            {comparison.isPartialScope ? (
              <p className="col-span-2 text-sm font-semibold text-fg-amber-800 sm:col-span-4" role="note">
                {t('timeTracking.budget.teamPartial')}
              </p>
            ) : null}
            {Object.keys(comparison.otherCurrencyCosts).length > 0 ? (
              <p className="col-span-2 text-sm font-semibold text-fg-amber-800 sm:col-span-4" role="note">
                {interpolate(t('timeTracking.budget.otherCurrencies'), { amounts: formatCostsByCurrency(comparison.otherCurrencyCosts, locale) })}
              </p>
            ) : null}
            <p className="col-span-2 text-xs text-[var(--workbench-muted)] sm:col-span-4">{t('timeTracking.budget.actualNote')}</p>
          </dl>
        ) : (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('timeTracking.budget.empty')}</p>
        )
      ) : null}

      {summary && !isLoading && budgetPeriods.length > 0 ? (
        <TimeBudgetPeriodList
          budgets={budgetPeriods}
          locale={locale}
          onDelete={deletePeriod}
          onUsePeriod={onUseBudgetPeriod}
          t={t}
        />
      ) : null}

      <div aria-live="polite" role="status">
        {message?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{message.text}</p> : null}
      </div>
      {message?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{message.text}</p> : null}

      {summary && !isLoading ? (
        isEditing ? (
          <form className="grid min-w-0 gap-3" key={formKey} onSubmit={(event) => { void submit(event) }}>
            <div className="flex min-w-0 flex-wrap items-end gap-3">
              <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t('timeTracking.budget.amount')}
                <input
                  className="workbench-input min-h-9 w-40 px-2"
                  defaultValue={budget && editTarget === 'shown' ? toMajorAmountInput(budget.amountMinor, budget.currency) : ''}
                  inputMode="decimal"
                  name="amount"
                  required
                />
              </label>
              <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t('timeTracking.budget.currency')}
                <input
                  autoCapitalize="characters"
                  className="workbench-input min-h-9 w-20 px-2 uppercase"
                  defaultValue={currency}
                  maxLength={3}
                  name="currency"
                  pattern="[A-Za-z]{3}"
                  required
                />
              </label>
              {editsAlertPercent ? (
                <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('timeTracking.budget.alertPercent')}
                  <input
                    className="workbench-input min-h-9 w-24 px-2"
                    data-testid="time-budget-alert-percent"
                    defaultValue={String(budget?.alertPercent ?? TIME_BUDGET_ALERT_PERCENT_DEFAULT)}
                    inputMode="numeric"
                    max={TIME_BUDGET_ALERT_PERCENT_MAX}
                    min={TIME_BUDGET_ALERT_PERCENT_MIN}
                    name="alertPercent"
                    step={1}
                    type="number"
                  />
                </label>
              ) : null}
              {fiscalYearOptions.length > 0 && !isPeriodLocked ? (
                <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('timeTracking.budget.fiscalYear')}
                  <select
                    className="workbench-input min-h-9 px-2"
                    data-testid="time-budget-fiscal-year-select"
                    onChange={(event) => {
                      const option = fiscalYearOptions.find((candidate) => String(candidate.fiscalYear) === event.target.value)
                      if (!option) return
                      setPeriodFrom(option.from)
                      setPeriodTo(option.to)
                    }}
                    value={selectedFiscalYear === undefined ? '' : String(selectedFiscalYear)}
                  >
                    <option value="">{t('timeTracking.budget.fiscalYearCustom')}</option>
                    {/* A saved fiscal year outside the three offered stays selectable as itself. */}
                    {selectedFiscalYear !== undefined && !fiscalYearOptions.some((option) => option.fiscalYear === selectedFiscalYear) ? (
                      <option value={String(selectedFiscalYear)}>
                        {interpolate(t('timeTracking.budget.fiscalYearOption'), { from: periodFrom, to: periodTo, year: String(selectedFiscalYear) })}
                      </option>
                    ) : null}
                    {fiscalYearOptions.map((option) => (
                      <option key={option.fiscalYear} value={String(option.fiscalYear)}>
                        {interpolate(t('timeTracking.budget.fiscalYearOption'), { from: option.from, to: option.to, year: String(option.fiscalYear) })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t(savesPeriodBudget ? 'timeTracking.budget.periodFromRequired' : 'timeTracking.budget.periodFrom')}
                <input className="workbench-input min-h-9 px-2" disabled={isPeriodLocked} name="periodFrom" onChange={(event) => setPeriodFrom(event.target.value)} required={savesPeriodBudget} type="date" value={periodFrom} />
              </label>
              <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t(savesPeriodBudget ? 'timeTracking.budget.periodToRequired' : 'timeTracking.budget.periodTo')}
                <input className="workbench-input min-h-9 px-2" disabled={isPeriodLocked} name="periodTo" onChange={(event) => setPeriodTo(event.target.value)} required={savesPeriodBudget} type="date" value={periodTo} />
              </label>
            </div>
            <p className="text-xs text-[var(--workbench-muted)]">
              {t(savesPeriodBudget ? 'timeTracking.budget.periodBudgetNote' : 'timeTracking.budget.defaultBudgetNote')}
            </p>
            {hasFiscalYearError && !isPeriodLocked ? (
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg-amber-800" role="alert">
                <span>{t('timeTracking.budget.fiscalYearError')}</span>
                {onRetryFiscalYear ? (
                  <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetryFiscalYear} type="button">
                    {t('timeTracking.budget.fiscalYearRetry')}
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button className="workbench-button-primary min-h-9 px-3" disabled={isSaving} type="submit">{t('timeTracking.budget.save')}</button>
              <button className="workbench-button-secondary min-h-9 px-3" onClick={() => setEditTarget(undefined)} type="button">{t('timeTracking.form.cancel')}</button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button className="workbench-button-secondary min-h-9 px-3" onClick={() => startEditing('shown')} type="button">
              {budget ? t('timeTracking.budget.edit') : t('timeTracking.budget.create')}
            </button>
            <button className="workbench-button-secondary min-h-9 px-3" data-testid="time-budget-add-period" onClick={() => startEditing('newPeriod')} type="button">
              {t('timeTracking.budget.addPeriod')}
            </button>
          </div>
        )
      ) : null}
      {summary && !budget && scope.scopeType === 'project' ? (
        <p className="text-xs text-[var(--workbench-muted)]">{interpolate(t('timeTracking.budget.projectHint'), { project: projects.find((project) => project.id === projectId)?.name ?? '' })}</p>
      ) : null}
    </section>
  )
}
