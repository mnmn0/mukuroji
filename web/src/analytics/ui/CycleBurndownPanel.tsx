import type { PlanningEntity, PlanningWorkItemLink } from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { useCycleBurndown, type CycleBurndownState } from '../queries/useCycleBurndown'
import { AnalyticsFlowChart } from './AnalyticsFlowChart'

/** Props of {@link CycleBurndownPanel}. */
export type CycleBurndownPanelProps = {
  /** Cycle to chart. */
  cycle: PlanningEntity
  /** Display locale. */
  locale: Locale
  /** Retries a failed load. */
  onRetry?: () => void
  /** Screen state of the burndown. */
  state: CycleBurndownState
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
  cycle,
  locale,
  onRetry,
  state,
  t,
  timeZone,
}: CycleBurndownPanelProps) {
  return (
    <section className="workbench-panel p-5" data-testid="cycle-burndown">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">
        {t('analytics.flow.cycleBurndown')}
        <span className="ml-2 text-sm font-medium text-[var(--workbench-muted)]">{cycle.title}</span>
      </h2>
      <div className="mt-4">
        {state.kind === 'ready' && state.series.length > 0 ? (
          <AnalyticsFlowChart
            height={180}
            label={`${t('analytics.flow.cycleBurndown')} ${cycle.title}`}
            locale={locale}
            plannedEndDate={cycle.baseline.endDate}
            series={state.series}
            t={t}
            timeZone={timeZone}
            visualization="burndown"
          />
        ) : state.kind === 'error' ? (
          <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
            <p className="text-sm font-semibold text-fg-red-800">{t('analytics.flow.cycleBurndownError')}</p>
            {onRetry ? (
              <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={onRetry}>
                {t('analytics.action.retry')}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">
            {state.kind === 'loading'
              ? t('analytics.loading')
              : state.kind === 'empty'
                ? t('analytics.flow.cycleBurndownEmpty')
                : state.kind === 'too-many'
                  ? t('analytics.flow.cycleBurndownTooMany')
                  : t('analytics.widget.empty')}
          </p>
        )}
      </div>
    </section>
  )
}

/** Props of {@link CycleBurndown}. */
export type CycleBurndownProps = Omit<CycleBurndownPanelProps, 'onRetry' | 'state'> & {
  /** Access token of the Analytics API. */
  accessToken: string
  /** Planning Work Item links of the snapshot. */
  links: readonly PlanningWorkItemLink[]
}

/**
 * Loads and shows the burndown of one Cycle.
 *
 * @param props - Cycle, links, and display settings.
 * @returns The burndown panel bound to the Analytics API.
 */
export function CycleBurndown({ accessToken, links, ...panelProps }: CycleBurndownProps) {
  const { state, retry } = useCycleBurndown(accessToken, panelProps.cycle, links, panelProps.timeZone)
  return <CycleBurndownPanel {...panelProps} state={state} onRetry={retry} />
}
