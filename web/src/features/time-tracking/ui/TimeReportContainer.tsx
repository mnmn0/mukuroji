import { DEFAULT_WORKSPACE_CURRENCY, type TimeTrackingGroupBy } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { downloadTimeTrackingCsv, type TimeReportBudgetScope } from '../api/timeReport'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { createTimeReportFileName, isTimeReportRangeOrdered, type TimeReportRange } from '../model/timeReport'
import { resolveBrowserTimeZone } from '../model/timePeriod'
import { useSaveTimeBudget } from '../mutations/useSaveTimeBudget'
import { useSaveTimeRateCard } from '../mutations/useSaveTimeRateCard'
import { useTimeRateCard, useTimeTrackingTeamSettings } from '../queries/useTimeRateCard'
import { useTimeTrackingSummary } from '../queries/useTimeTrackingSummary'
import { TimeBudgetPanel, type TimeBudgetProjectOption } from './TimeBudgetPanel'
import { TimeRateCardPanel, type TimeRateCardJobRoleOption } from './TimeRateCardPanel'
import { TimeReport, type TimeReportLabels } from './TimeReport'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Props of the report connected to the API. */
export type TimeReportContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Team whose entries are reported. */
  teamId: string
  /** Display locale. */
  locale: Locale
  /** Inclusive local period. */
  range: TimeReportRange
  /** Grouping. */
  groupBy: TimeTrackingGroupBy
  /** Names that label member, Project, and Work Item rows. */
  labels: TimeReportLabels
  /** Projects of the Team, offered as budget scopes. */
  projects: readonly TimeBudgetProjectOption[]
  /** Job roles of the Team's Work Item configuration, offered in the rate card. */
  jobRoles: readonly TimeRateCardJobRoleOption[]
  /** Opens another period or grouping. */
  onChange: (range: TimeReportRange, groupBy: TimeTrackingGroupBy) => void
}

/**
 * Starts a browser download of a CSV body.
 *
 * @param blob - CSV body.
 * @param fileName - Offered file name.
 */
function triggerCsvDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

/**
 * Connects the Team report, its CSV export, and the budget panel to the API.
 *
 * The budget panel appears only when the server returns costs (`costsRedacted` is false), so
 * members who may not see confidential money never see budgets either.
 *
 * @param props - Team, period, grouping, and labels.
 * @returns Connected report.
 */
export function TimeReportContainer({
  accessToken,
  groupBy,
  jobRoles,
  labels,
  locale,
  onChange,
  projects,
  range,
  teamId,
}: TimeReportContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const timeZone = resolveBrowserTimeZone()
  const ordered = isTimeReportRangeOrdered(range)
  const [budgetScope, setBudgetScope] = useState<TimeReportBudgetScope>({ scopeType: 'team' })
  const reportInput = useMemo(() => ({ ...range, timeZone, groupBy }), [groupBy, range, timeZone])
  const report = useTimeTrackingSummary(accessToken, teamId, reportInput, ordered)
  const canSeeCosts = report.data ? !report.data.costsRedacted : false
  const budgetInput = useMemo(
    () => ({ ...range, timeZone, groupBy: 'project' as const, budgetScope }),
    [budgetScope, range, timeZone],
  )
  const budgetReport = useTimeTrackingSummary(accessToken, teamId, budgetInput, ordered && canSeeCosts)
  const saveBudget = useSaveTimeBudget(accessToken, teamId)
  const settings = useTimeTrackingTeamSettings(accessToken, teamId)
  const canManageRateCard = settings.data?.canManageRateCard === true
  const rateCard = useTimeRateCard(accessToken, teamId, canManageRateCard)
  const saveRateCard = useSaveTimeRateCard(accessToken, teamId)
  const members = useMemo(
    () => Object.entries(labels.members)
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, locale)),
    [labels.members, locale],
  )

  return (
    <div className="grid min-w-0 gap-6">
      <TimeReport
        formatters={formatters}
        groupBy={groupBy}
        hasLoadError={Boolean(report.error)}
        isLoading={report.isLoading}
        labels={labels}
        locale={locale}
        onChangeGroupBy={(next) => onChange(range, next)}
        onChangeRange={(next) => onChange(next, groupBy)}
        onDownloadCsv={async () => {
          if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to export.')
          const blob = await downloadTimeTrackingCsv(accessToken, teamId, reportInput)
          triggerCsvDownload(blob, createTimeReportFileName(range, groupBy))
        }}
        onRetry={() => { void report.mutate().catch(() => undefined) }}
        range={range}
        t={t}
        {...(report.data ? { summary: report.data } : {})}
      />
      {canSeeCosts ? (
        <TimeBudgetPanel
          defaultCurrency={settings.data?.defaultCurrency ?? DEFAULT_WORKSPACE_CURRENCY}
          hasLoadError={Boolean(budgetReport.error)}
          isLoading={budgetReport.isLoading}
          locale={locale}
          onChangeScope={setBudgetScope}
          onRetry={() => { void budgetReport.mutate().catch(() => undefined) }}
          onSave={(input) => saveBudget(budgetScope, input)}
          onUseBudgetPeriod={(next) => onChange(next, groupBy)}
          projects={projects}
          scope={budgetScope}
          t={t}
          {...(budgetReport.data ? { summary: budgetReport.data } : {})}
        />
      ) : null}
      {canManageRateCard ? (
        <TimeRateCardPanel
          hasLoadError={Boolean(rateCard.error)}
          isLoading={rateCard.isLoading}
          jobRoles={jobRoles}
          members={members}
          onRetry={() => { void rateCard.mutate().catch(() => undefined) }}
          onSave={saveRateCard}
          t={t}
          {...(rateCard.data ? { rateCard: rateCard.data } : {})}
        />
      ) : null}
    </div>
  )
}
