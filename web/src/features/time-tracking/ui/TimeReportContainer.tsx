import { DEFAULT_WORKSPACE_CURRENCY, type TimeTrackingGroupBy } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { downloadTimeTrackingCsv, type TimeReportBudgetScope } from '../api/timeReport'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { createTimeReportFileName, isTimeReportRangeOrdered, type TimeReportRange } from '../model/timeReport'
import { resolveBrowserTimeZone } from '../model/timePeriod'
import { useSaveTeamTimeEntryPolicy } from '../mutations/useSaveTeamTimeEntryPolicy'
import { useDeleteTimeBudgetPeriod, useSaveTimeBudget } from '../mutations/useSaveTimeBudget'
import { useSaveTeamInvestmentAssignments } from '../mutations/useSaveTeamInvestmentAssignments'
import { useSaveTimeRateCard } from '../mutations/useSaveTimeRateCard'
import { useTeamInvestmentAssignments } from '../queries/useTeamInvestmentAssignments'
import { useTeamTimeEntryPolicy } from '../queries/useTeamTimeEntryPolicy'
import { useTimeRateCard, useTimeTrackingTeamSettings } from '../queries/useTimeRateCard'
import { useTimeTrackingSummary } from '../queries/useTimeTrackingSummary'
import { useWorkspaceInvestmentCategories } from '../../../workspace/queries/useWorkspaceInvestmentCategories'
import { InvestmentAssignmentsPanel } from './InvestmentAssignmentsPanel'
import { TimeBudgetPanel, type TimeBudgetProjectOption } from './TimeBudgetPanel'
import { TimeEntryPolicyPanel } from './TimeEntryPolicyPanel'
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
  /** Job roles of the Team's Work Item configuration, offered in the rate card; absent until read. */
  jobRoles?: readonly TimeRateCardJobRoleOption[]
  /** Whether reading the job roles failed. */
  hasJobRoleError?: boolean
  /** Reads the job roles again. */
  onRetryJobRoles?: () => void
  /** Opens another period or grouping. */
  onChange: (range: TimeReportRange, groupBy: TimeTrackingGroupBy) => void
  /** First month of the Workspace fiscal year, offered as budget periods once known. */
  fiscalYearStartMonth?: number
  /** Whether reading the Workspace fiscal year failed. */
  hasFiscalYearError?: boolean
  /** Reads the Workspace fiscal year again. */
  onRetryFiscalYear?: () => void
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
 * Connects the Team report, its CSV export, the budget panel, the investment category assignments,
 * and the Team's time entry checks to the API.
 *
 * The budget panel appears only when the server returns costs (`costsRedacted` is false), so
 * members who may not see confidential money never see budgets either.
 *
 * @param props - Team, period, grouping, and labels.
 * @returns Connected report.
 */
export function TimeReportContainer({
  accessToken,
  fiscalYearStartMonth,
  groupBy,
  hasFiscalYearError = false,
  hasJobRoleError = false,
  jobRoles,
  labels,
  locale,
  onChange,
  onRetryFiscalYear,
  onRetryJobRoles,
  projects,
  range,
  teamId,
}: TimeReportContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const timeZone = resolveBrowserTimeZone()
  const ordered = isTimeReportRangeOrdered(range)
  const [budgetScope, setBudgetScope] = useState<TimeReportBudgetScope>({ scopeType: 'team' })
  const [filterProjectId, setFilterProjectId] = useState<string>()
  const reportInput = useMemo(
    () => ({ ...range, timeZone, groupBy, ...(filterProjectId ? { filterProjectId } : {}) }),
    [filterProjectId, groupBy, range, timeZone],
  )
  const report = useTimeTrackingSummary(accessToken, teamId, reportInput, ordered)
  const canSeeCosts = report.data ? !report.data.costsRedacted : false
  const budgetInput = useMemo(
    () => ({ ...range, timeZone, groupBy: 'project' as const, budgetScope }),
    [budgetScope, range, timeZone],
  )
  const budgetReport = useTimeTrackingSummary(accessToken, teamId, budgetInput, ordered && canSeeCosts)
  const saveBudget = useSaveTimeBudget(accessToken, teamId)
  const deleteBudgetPeriod = useDeleteTimeBudgetPeriod(accessToken, teamId)
  const entryPolicy = useTeamTimeEntryPolicy(accessToken, teamId)
  const saveEntryPolicy = useSaveTeamTimeEntryPolicy(accessToken, teamId)
  const settings = useTimeTrackingTeamSettings(accessToken, teamId)
  const canManageRateCard = settings.data?.canManageRateCard === true
  const rateCard = useTimeRateCard(accessToken, teamId, canManageRateCard)
  const saveRateCard = useSaveTimeRateCard(accessToken, teamId)
  const investmentCategories = useWorkspaceInvestmentCategories(accessToken)
  // Only a manager of the whole Team may read the assignments, the same managers as the rate card.
  const investmentAssignments = useTeamInvestmentAssignments(accessToken, canManageRateCard ? teamId : undefined)
  const saveInvestmentAssignments = useSaveTeamInvestmentAssignments(accessToken, teamId)
  const workItemOptions = useMemo(
    () => Object.entries(labels.workItems)
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, locale)),
    [labels.workItems, locale],
  )
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
        projectFilter={{
          options: projects,
          onChange: setFilterProjectId,
          ...(filterProjectId ? { projectId: filterProjectId } : {}),
        }}
        range={range}
        t={t}
        {...(investmentCategories.settings ? { investmentCategories: investmentCategories.settings } : {})}
        hasInvestmentCategoriesError={Boolean(investmentCategories.error) && !investmentCategories.settings}
        onRetryInvestmentCategories={() => { investmentCategories.retry() }}
        {...(report.data ? { summary: report.data } : {})}
      />
      {canSeeCosts ? (
        <TimeBudgetPanel
          defaultCurrency={settings.data?.defaultCurrency ?? DEFAULT_WORKSPACE_CURRENCY}
          fiscalYearStartMonth={fiscalYearStartMonth}
          hasFiscalYearError={hasFiscalYearError}
          {...(onRetryFiscalYear ? { onRetryFiscalYear } : {})}
          // The Workspace currency seeds a new budget, so the editor waits for the settings too.
          hasLoadError={Boolean(budgetReport.error ?? settings.error)}
          isLoading={budgetReport.isLoading || (!settings.data && !settings.error)}
          locale={locale}
          onChangeScope={setBudgetScope}
          onDeletePeriod={(budget) => deleteBudgetPeriod(budgetScope, budget)}
          onRetry={() => {
            void Promise.all([budgetReport.mutate(), settings.mutate()]).catch(() => undefined)
          }}
          onSave={(input) => saveBudget(budgetScope, input)}
          onUseBudgetPeriod={(next) => onChange(next, groupBy)}
          projects={projects}
          reportRange={range}
          scope={budgetScope}
          t={t}
          {...(budgetReport.data && settings.data ? { summary: budgetReport.data } : {})}
        />
      ) : null}
      {canManageRateCard ? (
        <TimeRateCardPanel
          // A failed job role read is shown, not taken as a Team without job roles.
          hasLoadError={Boolean(rateCard.error) || hasJobRoleError}
          isLoading={rateCard.isLoading || (!jobRoles && !hasJobRoleError)}
          jobRoles={jobRoles ?? []}
          members={members}
          onRetry={() => {
            void rateCard.mutate().catch(() => undefined)
            onRetryJobRoles?.()
          }}
          onSave={saveRateCard}
          t={t}
          {...(rateCard.data ? { rateCard: rateCard.data } : {})}
        />
      ) : null}
      {canManageRateCard ? (
        <InvestmentAssignmentsPanel
          hasLoadError={Boolean(investmentAssignments.error ?? investmentCategories.error)}
          isLoading={investmentAssignments.isLoading || (!investmentCategories.settings && !investmentCategories.error)}
          onRetry={() => {
            void investmentAssignments.mutate().catch(() => undefined)
            investmentCategories.retry()
          }}
          onSave={saveInvestmentAssignments}
          projects={projects}
          t={t}
          workItems={workItemOptions}
          {...(investmentCategories.settings ? { settings: investmentCategories.settings } : {})}
          {...(investmentAssignments.data ? { view: investmentAssignments.data } : {})}
        />
      ) : null}
      <TimeEntryPolicyPanel
        hasLoadError={Boolean(entryPolicy.error)}
        isLoading={entryPolicy.isLoading}
        onRetry={() => { void entryPolicy.mutate().catch(() => undefined) }}
        onSave={saveEntryPolicy}
        t={t}
        {...(entryPolicy.data ? { view: entryPolicy.data } : {})}
      />
    </div>
  )
}
