import { useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { DocumentsApiError } from '../../documents/api/errors'
import { useDocumentBacklinks } from '../../documents/queries/useDocumentQueries'
import { useProjectActionItems } from '../../documents/queries/useProjectActionItems'
import { useProjectDocuments } from '../../documents/queries/useProjectDocuments'
import { useTeamAgentRunBoard } from '../../features/factory-board/queries/useFactoryBoard'
import { TeamIssuesApiError } from '../../issues/api'
import { useProjectIssues } from '../../issues/queries/useWorkItems'
import { PlanningApiError } from '../../planning/api/errors'
import { usePlanningSnapshot } from '../../planning/queries/usePlanningSnapshot'
import { isActiveProjectAssignmentCandidate, ProjectDirectoryApiError } from '../../projects/api'
import {
  findProjectOverviewUpdateTarget,
  selectProjectOverviewDocuments,
  selectProjectOverviewSchedule,
  summarizeProjectOverviewActionItems,
  summarizeProjectOverviewAgentRuns,
  summarizeProjectOverviewMembers,
  summarizeProjectOverviewRaid,
  summarizeProjectOverviewWorkItems,
} from '../../projects/model/projectOverview'
import { buildProjectStatusReport, PROJECT_STATUS_REPORT_ROW_LIMIT } from '../../projects/model/projectStatusReport'
import { useProjectMembers } from '../../projects/queries/useProjectMembers'
import { useProjectRaidLog } from '../../projects/queries/useProjectRaidLog'
import { ProjectStatusReportDialog } from '../../projects/ui/ProjectStatusReportDialog'
import {
  ProjectOverviewView,
  type ProjectOverviewAgentRunsError,
  type ProjectOverviewDocumentsError,
  type ProjectOverviewMembersError,
  type ProjectOverviewRaidError,
  type ProjectOverviewWorkItemsError,
} from '../../projects/ui/ProjectOverviewView'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkItemConfigurationApiError } from '../../work-items/api/errors'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the Team-qualified Project overview route.
 *
 * The overview reads the Project's Work Items, the Planning snapshot, the Project members, the
 * Project log, and the related Documents in parallel through the existing read APIs, so each
 * widget shows its own loading or failure state and a failed read never hides the others.
 *
 * @returns Project overview content rendered inside the shared Workspace shell.
 */
export function ProjectOverviewPage() {
  const workspace = useWorkspaceRouteContext()
  const params = useParams()
  const [searchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const projectId = params.projectId
  const teamId = searchParams.get('teamId') ?? undefined
  const team = workspace.teams.find((candidate) => candidate.id === teamId)
  const project = team?.projects.find((candidate) => candidate.id === projectId)
  const canRead = workspace.canLoadWorkspaceData && Boolean(team && project)
  const workItems = useProjectIssues(workspace.accessToken, projectId, canRead)
  const planning = usePlanningSnapshot(workspace.accessToken, canRead)
  const members = useProjectMembers(workspace.accessToken, projectId, canRead, team?.id)
  const raidLog = useProjectRaidLog(workspace.accessToken, team?.id, projectId ?? '', canRead && Boolean(projectId))
  const documentBacklinks = useDocumentBacklinks(
    canRead ? workspace.accessToken : undefined,
    'project',
    projectId,
  )
  const projectDocuments = useProjectDocuments(canRead ? workspace.accessToken : undefined, projectId)
  // Action items are read once the first page of Project Documents is in, so
  // a slow later page never holds the list back.
  const actionItemsQuery = useProjectActionItems(
    canRead ? workspace.accessToken : undefined,
    projectDocuments.isLoading || projectDocuments.error ? undefined : projectDocuments.documents,
  )
  const actionItems = useMemo(
    () => actionItemsQuery.data
      ? summarizeProjectOverviewActionItems(
          actionItemsQuery.data.items,
          {
            failedDocumentCount: actionItemsQuery.data.failedCount,
            hasMoreDocuments: projectDocuments.hasMore,
            skippedDocumentCount: actionItemsQuery.data.skippedCount,
          },
          (members.data ?? []).filter(isActiveProjectAssignmentCandidate),
          toLocalDate(new Date()),
        )
      : undefined,
    [actionItemsQuery.data, members.data, projectDocuments.hasMore],
  )
  const agentRunBoard = useTeamAgentRunBoard(
    canRead && workspace.softwareFactoryEnabled ? workspace.accessToken : undefined,
    team?.id,
  )
  const workItemSummary = useMemo(
    () => workItems.data && team
      ? summarizeProjectOverviewWorkItems(workItems.data, team.id, new Date(), planning.data?.workItems)
      : undefined,
    [planning.data?.workItems, team, workItems.data],
  )
  const raid = useMemo(
    () => raidLog.data ? summarizeProjectOverviewRaid(raidLog.data.entries, toLocalDate(new Date())) : undefined,
    [raidLog.data],
  )
  const raidError: ProjectOverviewRaidError | undefined = raidLog.error
    ? raidLog.error instanceof ProjectDirectoryApiError && raidLog.error.status === 403
      ? 'denied'
      : 'load'
    : undefined
  const isBacklinksLoading = Boolean(documentBacklinks.key) && documentBacklinks.data === undefined &&
    !documentBacklinks.error
  const documents = !projectId || (isBacklinksLoading && projectDocuments.isLoading)
    ? undefined
    : selectProjectOverviewDocuments(
        projectId,
        documentBacklinks.data?.backlinks ?? [],
        projectDocuments.documents,
        Boolean(documentBacklinks.data?.nextCursor) || projectDocuments.hasMore,
      )
  const documentsError = resolveDocumentsError(documentBacklinks.error, projectDocuments.error)
  const workItemsError: ProjectOverviewWorkItemsError | undefined = workItems.error
    ? workItems.error instanceof TeamIssuesApiError && workItems.error.code === 'WorkItemListLimitExceeded'
      ? 'limit'
      : 'load'
    : undefined
  const membersError: ProjectOverviewMembersError | undefined = members.error
    ? members.error instanceof ProjectDirectoryApiError && members.error.status === 403
      ? 'denied'
      : 'load'
    : undefined
  const agentRunsError: ProjectOverviewAgentRunsError | undefined = agentRunBoard.error
    ? agentRunBoard.error instanceof WorkItemConfigurationApiError && agentRunBoard.error.status === 403
      ? 'denied'
      : 'load'
    : undefined
  // The board hook keeps the previous Team's board while another Team's board loads or after its
  // read fails, so the counts need a successful read of the current Team's board.
  const agentRuns = useMemo(
    () => agentRunBoard.data && projectId && !agentRunBoard.isLoading && !agentRunBoard.error
      ? summarizeProjectOverviewAgentRuns(agentRunBoard.data, projectId)
      : undefined,
    [agentRunBoard.data, agentRunBoard.error, agentRunBoard.isLoading, projectId],
  )
  const updateTarget = team && projectId && planning.data
    ? findProjectOverviewUpdateTarget(planning.data.updateTargets, team.id, projectId)
    : undefined
  const schedule = useMemo(
    () => team && projectId && planning.data
      ? selectProjectOverviewSchedule(planning.data.entities, team.id, projectId)
      : undefined,
    [planning.data, projectId, team],
  )
  const memberSummary = useMemo(
    () => members.data
      ? summarizeProjectOverviewMembers(members.data.filter(isActiveProjectAssignmentCandidate))
      : undefined,
    [members.data],
  )

  const [isReportOpen, setIsReportOpen] = useState(false)
  // A failed read must not turn into a report that silently lacks the section, so the report
  // waits for a retry. Only a denied read (and the Work Item list limit) leaves its section out,
  // because those do not change on a retry and the creator cannot see that data either.
  const isPlanningDenied = planning.error instanceof PlanningApiError && planning.error.status === 403
  const reportReadFailed = (Boolean(planning.error) && !isPlanningDenied) ||
    (Boolean(workItems.error) && workItemsError !== 'limit' &&
      !(workItems.error instanceof TeamIssuesApiError && workItems.error.status === 403)) ||
    raidError === 'load' ||
    resolveDocumentsError(projectDocuments.error, actionItemsQuery.error) === 'load'
  const retryReport = () => {
    if (planning.error) void planning.mutate()
    if (workItems.error) void workItems.mutate()
    if (raidLog.error) void raidLog.mutate()
    if (projectDocuments.error) void projectDocuments.refresh()
    else if (actionItemsQuery.error) void actionItemsQuery.mutate()
  }
  // The report reads more rows than the overview widgets show, and only once it is opened.
  const report = useMemo(() => {
    if (!isReportOpen || !team || !project || !projectId || reportReadFailed) return undefined
    if (planning.data === undefined && !isPlanningDenied) return undefined
    if (workItems.isLoading || raidLog.isLoading || projectDocuments.isLoading || actionItemsQuery.isLoading) return undefined
    const today = toLocalDate(new Date())
    const activeMembers = (members.data ?? []).filter(isActiveProjectAssignmentCandidate)
    return buildProjectStatusReport({
      locale: workspace.locale === 'en' ? 'en' : 'ja',
      projectName: project.name,
      teamName: team.name,
      asOf: new Date(),
      updateTarget: planning.data ? findProjectOverviewUpdateTarget(planning.data.updateTargets, team.id, projectId) : undefined,
      schedule: planning.data
        ? selectProjectOverviewSchedule(planning.data.entities, team.id, projectId, PROJECT_STATUS_REPORT_ROW_LIMIT)
        : undefined,
      workItemSummary,
      raid: raidLog.data
        ? summarizeProjectOverviewRaid(raidLog.data.entries, today, PROJECT_STATUS_REPORT_ROW_LIMIT)
        : undefined,
      actionItems: actionItemsQuery.data
        ? summarizeProjectOverviewActionItems(
            actionItemsQuery.data.items,
            {
              failedDocumentCount: actionItemsQuery.data.failedCount,
              hasMoreDocuments: projectDocuments.hasMore,
              skippedDocumentCount: actionItemsQuery.data.skippedCount,
            },
            activeMembers,
            today,
            PROJECT_STATUS_REPORT_ROW_LIMIT,
          )
        : undefined,
      members: activeMembers,
    })
  }, [
    actionItemsQuery.data,
    actionItemsQuery.isLoading,
    isPlanningDenied,
    isReportOpen,
    members.data,
    planning.data,
    project,
    projectDocuments.hasMore,
    projectDocuments.isLoading,
    projectId,
    raidLog.data,
    raidLog.isLoading,
    reportReadFailed,
    team,
    workItemSummary,
    workItems.isLoading,
    workspace.locale,
  ])

  return (
    <WorkspaceRouteContent
      isLoading={workspace.isLoading}
      sessionErrors={[
        workItems.error,
        planning.error,
        members.error,
        agentRunBoard.error,
        raidLog.error,
        documentBacklinks.error,
        projectDocuments.error,
        actionItemsQuery.error,
      ]}
    >
      <div className="px-[clamp(16px,3vw,34px)] py-5">
        <ProjectOverviewView
          actionItems={actionItems}
          actionItemsError={resolveDocumentsError(actionItemsQuery.error, projectDocuments.error)}
          agentRuns={agentRuns}
          agentRunsError={agentRunsError}
          documents={documents}
          documentsError={documentsError}
          headerActions={team && project ? (
            <button
              className="workbench-button-secondary min-h-10 px-4"
              data-testid="project-overview-status-report"
              onClick={() => setIsReportOpen(true)}
              type="button"
            >
              {t('projects.statusReport.open')}
            </button>
          ) : undefined}
          isActionItemsLoading={projectDocuments.isLoading || actionItemsQuery.isLoading}
          isAgentRunsLoading={agentRunBoard.isLoading}
          isDocumentsLoading={isBacklinksLoading || projectDocuments.isLoading}
          isMembersLoading={Boolean(members.key) && members.data === undefined && !members.error}
          isPlanningError={Boolean(planning.error)}
          isPlanningLoading={Boolean(planning.key) && planning.data === undefined && !planning.error}
          isRaidLoading={raidLog.isLoading}
          isWorkItemsLoading={workItems.isLoading}
          locale={workspace.locale}
          members={memberSummary}
          membersError={membersError}
          onRetryActionItems={() => {
            if (projectDocuments.error) void projectDocuments.refresh()
            else void actionItemsQuery.mutate()
          }}
          onRetryAgentRuns={() => void agentRunBoard.mutate()}
          onRetryDocuments={() => {
            if (documentBacklinks.error) void documentBacklinks.mutate()
            if (projectDocuments.error) void projectDocuments.refresh()
          }}
          onRetryMembers={() => void members.mutate()}
          onRetryPlanning={() => void planning.mutate()}
          onRetryRaid={() => void raidLog.mutate()}
          onRetryWorkItems={() => void workItems.mutate()}
          project={project}
          raid={raid}
          raidError={raidError}
          schedule={schedule}
          showAgentRuns={workspace.softwareFactoryEnabled}
          t={t}
          team={team}
          updateTarget={updateTarget}
          workItemSummary={workItemSummary}
          workItemsError={workItemsError}
        />
        {isReportOpen && team && projectId ? (
          <ProjectStatusReportDialog
            accessToken={workspace.accessToken}
            hasReportError={reportReadFailed}
            onClose={() => setIsReportOpen(false)}
            onRetryReport={retryReport}
            projectId={projectId}
            report={report}
            t={t}
            teamId={team.id}
          />
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}

/**
 * Formats a date as `YYYY-MM-DD` in the viewer's time zone.
 *
 * @param date - Date to format.
 * @returns The local calendar date.
 */
function toLocalDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Decides how the related Documents widget reports failed reads.
 *
 * A 403 from either source means the viewer's role may not read Documents, which reading
 * again cannot fix; any other failure is a load failure the viewer can retry.
 *
 * @param errors - Errors of the backlink and Project scope reads.
 * @returns The widget error, or `undefined` when neither read failed.
 */
function resolveDocumentsError(...errors: readonly unknown[]): ProjectOverviewDocumentsError | undefined {
  const failures = errors.filter((error) => error !== undefined && error !== null)
  if (failures.length === 0) return undefined
  if (failures.some((error) => !(error instanceof DocumentsApiError && error.status === 403))) return 'load'
  return 'denied'
}
