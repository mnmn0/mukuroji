import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../../../shared/routing/paths'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import {
  chooseProjectBudgetReportInterval,
  isProjectBudgetReportRangeValid,
  resolveProjectBudgetReportRange,
} from '../model/projectBudgetReport'
import { resolveBrowserTimeZone, toLocalDateKey } from '../model/timePeriod'
import type { TimeReportRange } from '../model/timeReport'
import { useProjectBudgetReportExport } from '../mutations/useProjectBudgetReportExport'
import { useProjectBudgetReport } from '../queries/useProjectBudgetReport'
import { ProjectBudgetReportPanel } from './ProjectBudgetReportPanel'
import { ProjectExpensesSection } from './ProjectExpensesSection'

/** Props of {@link ProjectBudgetReportSection}. */
export type ProjectBudgetReportSectionProps = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Project; the section waits while it is unknown. */
  teamId?: string
  /** Project identifier. */
  projectId?: string
  /** Display locale. */
  locale: Locale
  /** Whether loading is allowed for the current session. */
  enabled: boolean
}

/** A report range together with the Team and Project it was chosen for. */
type ScopedRange = {
  /** `teamId/projectId` the range belongs to. */
  scope: string
  /** The chosen range. */
  range: TimeReportRange
}

/**
 * Connects the Project budget report panel and the Project expenses below it to their APIs.
 *
 * The first read uses the 90 days up to today; when the Project budget has a period, the section
 * then shows that period until the viewer picks a range. The report is for Project managers
 * only, so a 403 hides the section instead of showing an error.
 *
 * @param props - Session and Project identity.
 * @returns The section, or nothing for a viewer who may not read it.
 */
export function ProjectBudgetReportSection({ accessToken, enabled, locale, projectId, teamId }: ProjectBudgetReportSectionProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const timeZone = resolveBrowserTimeZone()
  const today = toLocalDateKey(new Date())
  // Ranges remember the Project they were chosen for, so another Project starts from its own default.
  const scope = `${teamId ?? ''}/${projectId ?? ''}`
  const [pickedState, setPickedState] = useState<ScopedRange>()
  const [budgetState, setBudgetState] = useState<ScopedRange>()
  const csvExport = useProjectBudgetReportExport(accessToken, teamId, projectId)
  const pickedRange = pickedState?.scope === scope ? pickedState.range : undefined
  const budgetRange = budgetState?.scope === scope ? budgetState.range : undefined
  const range = pickedRange ?? budgetRange ?? resolveProjectBudgetReportRange(undefined, today)
  const input = { ...range, timeZone, interval: chooseProjectBudgetReportInterval(range) }
  const report = useProjectBudgetReport(
    accessToken,
    teamId,
    projectId,
    input,
    enabled && isProjectBudgetReportRangeValid(range),
  )
  if (!pickedRange && !budgetRange && report.data?.budget) {
    const next = resolveProjectBudgetReportRange(report.data.budget, today)
    if (next.from !== range.from || next.to !== range.to) setBudgetState({ scope, range: next })
  }

  if (!teamId || !projectId) return null
  if (report.error instanceof TimeTrackingApiError && (report.error.status === 403 || report.error.status === 404)) return null
  return (
    <>
      <ProjectBudgetReportPanel
        budgetEditPath={createTeamTimeTrackingPath(teamId, 'report', undefined, { ...range, groupBy: 'project' })}
        hasExportError={csvExport.hasExportError}
        hasLoadError={Boolean(report.error)}
        isExporting={csvExport.isExporting}
        isLoading={report.isLoading}
        locale={locale}
        onChangeRange={(next) => setPickedState({ scope, range: next })}
        onExport={() => csvExport.exportCsv(input)}
        onRetry={() => { void report.mutate().catch(() => undefined) }}
        range={range}
        renderLink={(path, children) => <Link className="workbench-button-secondary inline-flex min-h-9 items-center px-3" to={path}>{children}</Link>}
        t={t}
        {...(report.data ? { report: report.data } : {})}
      />
      <ProjectExpensesSection
        {...(accessToken ? { accessToken } : {})}
        defaultCurrency={report.data?.budget?.currency ?? 'JPY'}
        enabled={enabled}
        locale={locale}
        projectId={projectId}
        t={t}
        teamId={teamId}
      />
    </>
  )
}
