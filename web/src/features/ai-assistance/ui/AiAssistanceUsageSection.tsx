import type {
  AiAssistanceTask,
  AiAssistanceUsageSummary,
  AiAssistanceUsageTotals,
} from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'

/** Props for the monthly AI usage section shown to Workspace AI managers. */
export type AiAssistanceUsageSectionProps = {
  /** Usage summary of the month; undefined while it loads. */
  usage?: AiAssistanceUsageSummary
  /** Whether the usage could not be loaded. */
  loadError?: boolean
  /** Locale used for numbers and currency. */
  locale: Locale
  /** Retries a failed load. */
  onRetry?: () => void
  /** Names a member; the member ID is shown when it returns nothing. */
  resolveMemberLabel?: (memberId: string) => string | undefined
  /** Translates settings labels. */
  t: (key: MessageKey) => string
}

/** Label of each AI workflow in the usage table. */
const taskLabelKeys: Record<AiAssistanceTask, MessageKey> = {
  planning: 'ai.settings.policy.task.planning',
  search: 'ai.settings.policy.task.search',
  summary: 'ai.settings.policy.task.summary',
  triage: 'ai.settings.policy.task.triage',
}

/**
 * Shows this month's AI usage, its estimated cost, the caps, and the pause state.
 *
 * @param props - Usage summary, load state, locale, and translator.
 * @returns The usage section.
 */
export function AiAssistanceUsageSection({
  loadError = false,
  locale,
  onRetry,
  resolveMemberLabel,
  t,
  usage,
}: AiAssistanceUsageSectionProps) {
  const numberFormat = new Intl.NumberFormat(locale)
  const costFormat = new Intl.NumberFormat(locale, {
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
    style: 'currency',
  })
  /**
   * Formats the estimated cost of one scope, noting generations without an estimate.
   *
   * @param totals - Scope totals.
   * @returns Cost text.
   */
  const formatCost = (totals: AiAssistanceUsageTotals) => {
    const cost = costFormat.format(totals.costUsd)
    if (totals.costUnavailableGenerations === 0) return cost
    return `${cost} ${t('ai.settings.usage.costPartial').replace(
      '{count}',
      numberFormat.format(totals.costUnavailableGenerations),
    )}`
  }

  return (
    <section
      aria-labelledby="ai-assistance-usage-title"
      className="workbench-panel p-5"
      data-testid="ai-assistance-usage-section"
    >
      <h2 className="text-base font-semibold text-[var(--workbench-text)]" id="ai-assistance-usage-title">
        {t('ai.settings.usage.title')}
      </h2>
      <p className="mt-1 text-app-caption text-[var(--workbench-muted)]">
        {t('ai.settings.usage.description')}
      </p>
      {loadError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('ai.settings.usage.loadError')}
          </p>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onRetry} type="button">
              {t('ai.settings.retry')}
            </button>
          ) : null}
        </div>
      ) : usage === undefined ? (
        <p className="mt-4 text-app-caption text-[var(--workbench-muted)]" role="status">
          {t('ai.settings.usage.loading')}
        </p>
      ) : (
        <div className="mt-4 grid gap-4">
          {usage.deploymentPaused ? (
            <p className="text-app-caption font-semibold text-[var(--workbench-danger)]" role="status">
              {t('ai.settings.usage.paused')}
            </p>
          ) : null}
          {usage.exhausted ? (
            <p className="text-app-caption font-semibold text-[var(--workbench-danger)]" role="status">
              {t('ai.settings.usage.exhausted')}
            </p>
          ) : usage.warning ? (
            <p className="text-app-caption font-semibold text-[var(--workbench-warning)]" role="status">
              {t('ai.settings.usage.warning')}
            </p>
          ) : null}
          <dl className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1">
            <UsageFigure label={t('ai.settings.usage.month')} value={usage.month} />
            <UsageFigure
              label={t('ai.settings.usage.tokens')}
              value={formatLimited(
                numberFormat.format(usage.totals.inputTokens + usage.totals.outputTokens),
                usage.monthlyTokenLimit === undefined ? undefined : numberFormat.format(usage.monthlyTokenLimit),
              )}
            />
            <UsageFigure
              label={t('ai.settings.usage.cost')}
              value={formatLimited(
                formatCost(usage.totals),
                usage.monthlyCostLimitUsd === undefined ? undefined : costFormat.format(usage.monthlyCostLimitUsd),
              )}
            />
          </dl>
          <UsageTable
            caption={t('ai.settings.usage.byTask')}
            emptyLabel={t('ai.settings.usage.empty')}
            formatCost={formatCost}
            numberFormat={numberFormat}
            rows={usage.tasks.map((row) => ({ key: row.task, label: t(taskLabelKeys[row.task]), totals: row }))}
            scopeLabel={t('ai.settings.usage.task')}
            t={t}
          />
          <UsageTable
            caption={t('ai.settings.usage.byMember')}
            emptyLabel={t('ai.settings.usage.empty')}
            formatCost={formatCost}
            numberFormat={numberFormat}
            rows={usage.members.map((row) => ({
              key: row.memberId,
              label: resolveMemberLabel?.(row.memberId) ?? row.memberId,
              totals: row,
            }))}
            scopeLabel={t('ai.settings.usage.member')}
            t={t}
          />
        </div>
      )}
    </section>
  )
}

/** Props for one headline usage figure. */
type UsageFigureProps = {
  /** Figure name. */
  label: string
  /** Formatted value. */
  value: string
}

/**
 * Shows one headline usage figure.
 *
 * @param props - Label and value.
 * @returns A term and its value.
 */
function UsageFigure({ label, value }: UsageFigureProps) {
  return (
    <div className="grid gap-1">
      <dt className="text-app-caption font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="text-app-body font-semibold text-[var(--workbench-text)]">{value}</dd>
    </div>
  )
}

/** One row of a usage breakdown table. */
type UsageRow = {
  /** Stable React key. */
  key: string
  /** Workflow or member name. */
  label: string
  /** Usage of the row. */
  totals: AiAssistanceUsageTotals
}

/** Props for one usage breakdown table. */
type UsageTableProps = {
  /** Table caption. */
  caption: string
  /** Text shown when the month has no usage. */
  emptyLabel: string
  /** Formats the estimated cost of a row. */
  formatCost: (totals: AiAssistanceUsageTotals) => string
  /** Number format of the locale. */
  numberFormat: Intl.NumberFormat
  /** Rows, largest cost first. */
  rows: readonly UsageRow[]
  /** Heading of the name column. */
  scopeLabel: string
  /** Translates column headings. */
  t: (key: MessageKey) => string
}

/**
 * Shows usage by workflow or by member.
 *
 * @param props - Caption, rows, and formatters.
 * @returns A scrollable table, or a note when nothing was recorded.
 */
function UsageTable({ caption, emptyLabel, formatCost, numberFormat, rows, scopeLabel, t }: UsageTableProps) {
  if (rows.length === 0) {
    return (
      <div className="grid gap-1">
        <h3 className="text-app-caption font-semibold text-[var(--workbench-muted)]">{caption}</h3>
        <p className="text-app-caption text-[var(--workbench-muted)]">{emptyLabel}</p>
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-app-caption">
        <caption className="mb-2 text-left font-semibold text-[var(--workbench-muted)]">{caption}</caption>
        <thead>
          <tr className="border-b border-[var(--workbench-border)]">
            <th className="py-2 pr-3" scope="col">{scopeLabel}</th>
            <th className="py-2 pr-3 text-right" scope="col">{t('ai.settings.usage.generations')}</th>
            <th className="py-2 pr-3 text-right" scope="col">{t('ai.settings.usage.tokens')}</th>
            <th className="py-2 text-right" scope="col">{t('ai.settings.usage.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-b border-[var(--workbench-border)]" key={row.key}>
              <th className="py-2 pr-3 font-normal" scope="row">{row.label}</th>
              <td className="py-2 pr-3 text-right">{numberFormat.format(row.totals.generations)}</td>
              <td className="py-2 pr-3 text-right">
                {numberFormat.format(row.totals.inputTokens + row.totals.outputTokens)}
              </td>
              <td className="py-2 text-right">{formatCost(row.totals)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Writes a used amount with its cap.
 *
 * @param used - Formatted used amount.
 * @param limit - Formatted cap, when one is set.
 * @returns `used / limit`, or just the used amount.
 */
function formatLimited(used: string, limit: string | undefined): string {
  return limit === undefined ? used : `${used} / ${limit}`
}
