import type { WorkspaceMember } from '../../workspace/api/access'
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import {
  createCrossProjectWorkItemJobRoleOptions,
  createCrossProjectWorkItemListSearchParams,
  createCrossProjectWorkItemMemberOptions,
  createCrossProjectWorkItemProjectOptions,
  createCrossProjectWorkItemServerFilter,
  filterCrossProjectWorkItems,
  groupCrossProjectWorkItems,
  parseCrossProjectWorkItemListState,
  type CrossProjectWorkItemListState,
} from '../../features/cross-project-work-items/model/crossProjectWorkItems'
import { CrossProjectWorkItemList } from '../../features/cross-project-work-items/ui/CrossProjectWorkItemList'
import { createTranslator } from '../../shared/i18n/i18n'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import { useWorkspaceWorkItemData } from '../../workspace/queries/useWorkspaceWorkItemData'
import {
  WorkspaceConfigurationLoadNotice,
  WorkspaceTaskLoadNotice,
} from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

const emptyWorkspaceMembers: WorkspaceMember[] = []

/**
 * Renders the Workspace-wide Work Item list across every Project the viewer can read.
 *
 * Work Items come from the permission-filtered `GET /api/work-items`, so a shared URL only shows
 * what each viewer may read. Filters and grouping live in the URL.
 *
 * @returns The cross-Project Work Item list inside the shared Workspace shell.
 */
export function WorkItemsPage() {
  const workspace = useWorkspaceRouteContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const state = useMemo(() => parseCrossProjectWorkItemListState(searchParams), [searchParams])
  const serverFilter = useMemo(() => createCrossProjectWorkItemServerFilter(state), [state])
  const workItems = useWorkspaceWorkItemData(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
    workspace.teams,
    false,
    serverFilter,
  )
  const workspaceAccess = useWorkspaceAccess(workspace.accessToken, workspace.canLoadWorkspaceData)
  const members = workspaceAccess.data?.members ?? emptyWorkspaceMembers
  const memberLabels = useMemo(
    () => new Map(members.map((member) => [member.memberKey, member.name ?? member.email])),
    [members],
  )
  const filteredWorkItems = useMemo(
    () => filterCrossProjectWorkItems(workItems.tasks, state, workspace.userIdentityAliases),
    [state, workItems.tasks, workspace.userIdentityAliases],
  )
  const groups = useMemo(
    () => groupCrossProjectWorkItems(filteredWorkItems, state.grouping, workspace.teams),
    [filteredWorkItems, state.grouping, workspace.teams],
  )
  const projectOptions = useMemo(
    () => createCrossProjectWorkItemProjectOptions(workspace.teams),
    [workspace.teams],
  )
  const memberOptions = useMemo(
    () => createCrossProjectWorkItemMemberOptions(workItems.tasks, memberLabels, state.contributorMemberId),
    [memberLabels, state.contributorMemberId, workItems.tasks],
  )
  const jobRoleOptions = useMemo(
    () => createCrossProjectWorkItemJobRoleOptions(
      workItems.tasks,
      workItems.configurationsByTeam,
      workspace.teams,
      state.contributorJobRole,
    ),
    [state.contributorJobRole, workItems.configurationsByTeam, workItems.tasks, workspace.teams],
  )
  const changeState = useCallback((next: CrossProjectWorkItemListState) => {
    setSearchParams(createCrossProjectWorkItemListSearchParams(next), { replace: true })
  }, [setSearchParams])
  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      return true
    } catch {
      return false
    }
  }, [])

  return (
    // The list shows its own loading state, so changing a filter keeps the toolbar mounted.
    <WorkspaceRouteContent
      sessionErrors={[
        workItems.workItemsError,
        workItems.configurationsError,
        ...workItems.configurationErrors,
        workspaceAccess.error,
      ]}
    >
      <div className="grid gap-4 px-[clamp(16px,3vw,34px)] py-5">
        <WorkspaceTaskLoadNotice
          error={workItems.workItemsError}
          failedProjectCount={workItems.failedProjectCount}
          t={t}
        />
        <WorkspaceConfigurationLoadNotice
          failedTeamCount={workItems.configurationFailedTeamIds.length}
          onRetry={() => void workItems.mutateConfigurations()}
          t={t}
          testId="work-items-configuration-error"
        />
        <CrossProjectWorkItemList
          configurationsByTeam={workItems.configurationsByTeam}
          groups={groups}
          isLoading={workItems.isWorkItemsLoading}
          loadFailed={Boolean(workItems.workItemsError)}
          jobRoleOptions={jobRoleOptions}
          memberLabels={memberLabels}
          memberOptions={memberOptions}
          onChangeState={changeState}
          onCopyLink={copyLink}
          onOpenWorkItem={workspace.onOpenTask}
          onRetry={() => void workItems.mutateWorkItems()}
          projectOptions={projectOptions}
          state={state}
          t={t}
          totalCount={filteredWorkItems.length}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
