import type { TimeBudget } from '@mukuroji/contracts'
import { useId, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { formatMinorAmount, type TimeReportRange } from '../model/timeReport'
import type { TimeTrackingTranslator } from './timeTrackingText'

/** Props of the list of a scope's budgets per period. */
export type TimeBudgetPeriodListProps = {
  /** Budgets per period of the scope, each with its period. */
  budgets: readonly TimeBudget[]
  /** Display locale, used for money. */
  locale: Locale
  /** Translator. */
  t: TimeTrackingTranslator
  /** Shows the report for a budget's period, which makes the panel compare with that budget. */
  onUsePeriod: (range: TimeReportRange) => void
  /** Deletes a budget per period. */
  onDelete: (budget: TimeBudget) => Promise<void>
}

/**
 * Reads the key of a budget per period: its scope and period, so a delete confirmed for one scope
 * is not carried over to the same period of another.
 *
 * @param budget - Budget per period.
 * @returns Key of the budget.
 */
function periodKeyOf(budget: TimeBudget): string {
  return `${budget.teamId}/${budget.scopeType}/${budget.scopeId}/${budget.periodFrom ?? ''}/${budget.periodTo ?? ''}`
}

/**
 * Lists a scope's budgets per period, with actions to report a period or delete its budget. A
 * delete asks once more on the same row before it is sent.
 *
 * @param props - Budgets and actions.
 * @returns List of budgets per period.
 */
export function TimeBudgetPeriodList({ budgets, locale, onDelete, onUsePeriod, t }: TimeBudgetPeriodListProps) {
  const id = useId()
  const [confirmingKey, setConfirmingKey] = useState<string>()
  const [deletingKey, setDeletingKey] = useState<string>()

  /**
   * Sends the delete of a confirmed budget per period.
   *
   * @param budget - Budget per period to delete.
   */
  const confirmDelete = async (budget: TimeBudget) => {
    const key = periodKeyOf(budget)
    if (deletingKey) return
    setDeletingKey(key)
    try {
      await onDelete(budget)
    } finally {
      setDeletingKey(undefined)
      setConfirmingKey(undefined)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-2" data-testid="time-budget-periods">
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.budget.periods')}</h3>
      <ul className="grid min-w-0 gap-2">
        {budgets.map((budget) => {
          const key = periodKeyOf(budget)
          const { periodFrom, periodTo } = budget
          // Every row has the same button names, so each names its period for assistive technology.
          const periodId = `${id}-${key}`
          return (
            <li className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-[var(--workbench-text)]" data-testid="time-budget-period-row" key={key}>
              <span className="tabular-nums" id={periodId}>{`${periodFrom ?? ''} – ${periodTo ?? ''}`}</span>
              <span className="font-semibold tabular-nums">{formatMinorAmount(budget.amountMinor, budget.currency, locale)}</span>
              {periodFrom && periodTo ? (
                <button aria-describedby={periodId} className="workbench-button-secondary min-h-8 px-3" onClick={() => onUsePeriod({ from: periodFrom, to: periodTo })} type="button">
                  {t('timeTracking.budget.usePeriod')}
                </button>
              ) : null}
              {confirmingKey === key ? (
                <>
                  <button
                    aria-describedby={periodId}
                    className="workbench-button-secondary min-h-8 px-3 text-fg-red-700"
                    disabled={deletingKey !== undefined}
                    onClick={() => { void confirmDelete(budget) }}
                    type="button"
                  >
                    {t('timeTracking.budget.confirmDeletePeriod')}
                  </button>
                  <button className="workbench-button-secondary min-h-8 px-3" onClick={() => setConfirmingKey(undefined)} type="button">
                    {t('timeTracking.form.cancel')}
                  </button>
                </>
              ) : (
                <button aria-describedby={periodId} className="workbench-button-secondary min-h-8 px-3" onClick={() => setConfirmingKey(key)} type="button">
                  {t('timeTracking.budget.deletePeriod')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
