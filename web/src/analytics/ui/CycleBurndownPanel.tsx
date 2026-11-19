import type { PlanningEntity, PlanningWorkItemLink } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { queryAnalytics } from '../api/queries'
import { CYCLE_BURNDOWN_WIDGET_ID, createCycleBurndownQuery } from '../model/cycleBurndown'
import { AnalyticsFlowChart } from './AnalyticsFlowChart'

/** Props of {@link CycleBurndownPanel}. */
export type CycleBurndownPanelProps = {
  /** Access token of the Analytics API. */
  accessToken: string
  /** Cycle to chart. */
  cycle: PlanningEntity
  /** Planning Work Item links of the snapshot. */
  links: readonly PlanningWorkItemLink[]
  /** Display locale. */
  locale: Locale
  /** Translator of the current locale. */
  t: (key: MessageKey) => string
  /** IANA timezone of the daily buckets. */
  timeZone: string
}

/**
 * Shows the burndown of one Cycle: remaining Work Items per day and the ideal line to the Cycle end.
 *
 * @param props - Panel props.
 * @returns The burndown panel.
 */
export function CycleBurndownPanel({
  accessToken,
  cycle,
  links,
  locale,
  t,
  timeZone,
}: CycleBurndownPanelProps) {
  const [asOf] = useState(() => new Date())
  const plan = useMemo(
    () => createCycleBurndownQuery(cycle, links, timeZone, asOf),
    [asOf, cycle, links, timeZone],
  )
  const serializedQuery = plan.kind === 'query' ? JSON.stringify(plan.query) : null
  const { data, error, isLoading } = useSWR(
    serializedQuery ? ['cycle-burndown', accessToken, serializedQuery] as const : null,
    ([, token, query]) => queryAnalytics(token, JSON.parse(query)),
    { dedupingInterval: 10_000, shouldRetryOnError: false },
  )
  const result = data?.widgets.find((widget) => widget.widgetId === CYCLE_BURNDOWN_WIDGET_ID)

  return (
    <section className="workbench-panel p-5" data-testid="cycle-burndown">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">
        {t('analytics.flow.cycleBurndown')}
        <span className="ml-2 text-sm font-medium text-[var(--workbench-muted)]">{cycle.title}</span>
      </h2>
      <div className="mt-4">
        {plan.kind === 'empty' || plan.kind === 'not-started' ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {plan.kind === 'empty' ? t('analytics.flow.cycleBurndownEmpty') : t('analytics.widget.empty')}
          </p>
        ) : plan.kind === 'too-many' ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('analytics.flow.cycleBurndownTooMany')}</p>
        ) : error ? (
          <p className="text-sm font-semibold text-fg-red-800" role="alert">{t('analytics.flow.cycleBurndownError')}</p>
        ) : isLoading || !result ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('analytics.loading')}</p>
        ) : (
          <AnalyticsFlowChart
            height={180}
            label={`${t('analytics.flow.cycleBurndown')} ${cycle.title}`}
            locale={locale}
            plannedEndDate={cycle.baseline.endDate}
            series={result.series}
            t={t}
            timeZone={timeZone}
            visualization="burndown"
          />
        )}
      </div>
    </section>
  )
}
