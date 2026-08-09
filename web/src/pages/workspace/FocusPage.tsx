import type { FocusItem, FocusQueueSection } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useFocusQueueActions } from '../../features/focus-queue/mutations/useFocusQueueActions'
import {
  findDeepLinkedFocusItem,
  getFocusSourcePath,
} from '../../features/focus-queue/model/focusQueue'
import { useFocusQueue } from '../../features/focus-queue/queries/useFocusQueue'
import { FocusQueue } from '../../features/focus-queue/ui/FocusQueue'
import { createTranslator } from '../../shared/i18n/i18n'
import { useTeamWorkItemConfigurations } from '../../work-items/queries/useWorkItemConfigurations'
import { WorkspaceConfigurationLoadNotice } from '../../workspace/ui/WorkspaceDataNotices'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the URL-specific Focus route with a server-ranked attention queue.
 *
 * @returns Focus content rendered inside the shared Workspace shell.
 */
export function FocusPage() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const focusQuery = useFocusQueue(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const teamIds = useMemo(
    () => Array.from(new Set(
      focusQuery.data?.sections.flatMap((group) =>
        group.items.map((item) => item.workItem.teamId)) ?? [],
    )).sort(),
    [focusQuery.data],
  )
  const configurationQuery = useTeamWorkItemConfigurations(
    workspace.accessToken,
    'focus',
    teamIds,
    workspace.canLoadWorkspaceData,
  )
  const mutations = useFocusQueueActions({
    accessToken: workspace.accessToken,
    guardAuthenticatedRequest: workspace.guardEnterpriseSession,
    mutateFocusQueue: focusQuery.mutate,
  })
  const requestedSourceEventId = searchParams.get('sourceEventId')?.trim() || undefined
  const deepLinkedItem = findDeepLinkedFocusItem(focusQuery.data, {
    sourceEventId: requestedSourceEventId,
    teamId: searchParams.get('teamId')?.trim() || undefined,
    workItemId: searchParams.get('workItemId')?.trim() || undefined,
  })
  const selectedSection = deepLinkedItem?.section ?? readFocusQueueSection(
    searchParams.get('section'),
  )
  const configurationResult = configurationQuery.data
  const failedConfigurationTeamCount = configurationQuery.error
    ? Math.max(teamIds.length, configurationResult?.failedTeamIds.length ?? 0)
    : configurationResult?.failedTeamIds.length ?? 0

  /** Writes the selected section to the URL and clears a stale Inbox correlation. */
  const selectSection = (section: FocusQueueSection) => {
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('section', section)
    nextParams.delete('teamId')
    nextParams.delete('workItemId')
    nextParams.delete('sourceEventId')
    setSearchParams(nextParams, { replace: true })
  }

  /** Opens the first authorized application-relative source for one item. */
  const openSource = (item: FocusItem) => {
    const path = getFocusSourcePath(item, requestedSourceEventId)
    if (path) navigate(path)
  }

  return (
    <WorkspaceRouteContent
      sessionErrors={[
        focusQuery.error,
        configurationQuery.error,
        ...(configurationResult?.errors ?? []),
      ]}
    >
      <div className="grid gap-4 px-[clamp(16px,3vw,34px)] py-5">
        <WorkspaceConfigurationLoadNotice
          failedTeamCount={failedConfigurationTeamCount}
          onRetry={() => void configurationQuery.mutate()}
          t={t}
          testId="focus-configuration-error"
        />
        <FocusQueue
          configurationsByTeam={configurationResult?.configurationsByTeam}
          hasError={Boolean(focusQuery.error)}
          isActionPending={mutations.isPending}
          isLoading={Boolean(focusQuery.key && focusQuery.isLoading)}
          locale={workspace.locale}
          mutationError={mutations.error}
          onAssignToViewer={(item) => mutations.assignToViewer(
            item,
            focusQuery.data?.viewerMemberKey ?? '',
          )}
          onComplete={mutations.complete}
          onConfirmSchedule={mutations.confirmSchedule}
          onDismissMutationError={mutations.clearError}
          onDismissSnoozeFeedback={mutations.dismissSnoozeFeedback}
          onOpenItem={(item) => workspace.onOpenTask(item.workItem)}
          onOpenSource={openSource}
          onPreviewSchedule={mutations.previewSchedule}
          onRetry={() => {
            void Promise.all([focusQuery.mutate(), configurationQuery.mutate()])
          }}
          onSectionChange={selectSection}
          onSnooze={mutations.updateSnooze}
          onStatusChange={mutations.updateStatus}
          onUndoSnooze={mutations.undoSnooze}
          onUpdatePolicy={mutations.updatePolicy}
          onWatchingChange={mutations.updateWatching}
          requestedItemId={deepLinkedItem?.id}
          policyError={mutations.policyError}
          response={focusQuery.data}
          section={selectedSection}
          snoozeFeedback={mutations.snoozeFeedback}
          t={t}
        />
      </div>
    </WorkspaceRouteContent>
  )
}

/**
 * Parses one URL section while failing safely to the primary queue.
 *
 * @param value - Raw section search parameter.
 * @returns A supported Focus section.
 */
function readFocusQueueSection(value: string | null): FocusQueueSection {
  if (
    value === 'next' ||
    value === 'waiting' ||
    value === 'snoozed' ||
    value === 'done'
  ) {
    return value
  }
  return 'now'
}
