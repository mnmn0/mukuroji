import { toWorkspaceLocalDate, type TimeTrackingSummary } from '@mukuroji/contracts'
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
  onRetry,
  onSave,
  onRetryFiscalYear,
  onUseBudgetPeriod,
  projects,
  scope,
  summary,
  t,
}: TimeBudgetPanelProps) {
  const id = useId()
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const projectId = scope.scopeType === 'project' ? scope.projectId : undefined
  const comparison = summary ? compareTimeBudget(summary, projectId) : undefined
  const budget = comparison?.budget
  const currency = budget?.currency ?? defaultCurrency
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  const formKey = `${projectId ?? 'team'}:${budget?.revision ?? 0}`
  const [periodFormKey, setPeriodFormKey] = useState(formKey)
  if (periodFormKey !== formKey) {
    // The keyed form resets amount and currency when the saved budget changes; reset the period with them.
    setPeriodFormKey(formKey)
    setPeriodFrom(budget?.periodFrom ?? '')
    setPeriodTo(budget?.periodTo ?? '')
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

  /** Opens the editor with the saved period of the budget. */
  const startEditing = () => {
    setMessage(undefined)
    setPeriodFrom(budget?.periodFrom ?? '')
    setPeriodTo(budget?.periodTo ?? '')
    setIsEditing(true)
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
    if (periodFrom && periodTo && !isTimeReportRangeOrdered({ from: periodFrom, to: periodTo })) {
      setMessage({ tone: 'error', text: t('timeTracking.report.invalidRange') })
      return
    }
    setIsSaving(true)
    setMessage(undefined)
    try {
      await onSave({
        amountMinor,
        currency: nextCurrency,
        ...(periodFrom ? { periodFrom } : {}),
        ...(periodTo ? { periodTo } : {}),
        expectedRevision: budget?.revision ?? 0,
      })
      setIsEditing(false)
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
              setIsEditing(false)
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
                  defaultValue={budget ? toMajorAmountInput(budget.amountMinor, budget.currency) : ''}
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
              {fiscalYearOptions.length > 0 ? (
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
                {t('timeTracking.budget.periodFrom')}
                <input className="workbench-input min-h-9 px-2" name="periodFrom" onChange={(event) => setPeriodFrom(event.target.value)} type="date" value={periodFrom} />
              </label>
              <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t('timeTracking.budget.periodTo')}
                <input className="workbench-input min-h-9 px-2" name="periodTo" onChange={(event) => setPeriodTo(event.target.value)} type="date" value={periodTo} />
              </label>
            </div>
            {hasFiscalYearError ? (
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
              <button className="workbench-button-secondary min-h-9 px-3" onClick={() => setIsEditing(false)} type="button">{t('timeTracking.form.cancel')}</button>
            </div>
          </form>
        ) : (
          <div>
            <button className="workbench-button-secondary min-h-9 px-3" onClick={startEditing} type="button">
              {budget ? t('timeTracking.budget.edit') : t('timeTracking.budget.create')}
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
