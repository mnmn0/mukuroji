import { useMemo } from 'react'
import { Navigate, useParams } from 'react-router'
import { TeamIssuesApiError } from '../../issues/api'
import { readWorkItemKeyInput } from '../../work-items/model/workItemKeys'
import { useWorkItemKeyLocation } from '../../issues/queries/useWorkItemKeyLocation'
import { WorkItemKeyStatus, type WorkItemKeyLookupStatus } from '../../issues/ui/WorkItemKeyStatus'
import { createTranslator } from '../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Opens the Work Item named by a key URL such as `/browse/PT-12`.
 * The key never changes, so the URL keeps working after the Work Item moves to another Project.
 *
 * @returns A short status page that redirects to the Work Item when the key resolves.
 */
export function WorkItemKeyPage() {
  const workspace = useWorkspaceRouteContext()
  const { workItemKey: rawKey = '' } = useParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const key = readWorkItemKeyInput(rawKey)
  const lookup = useWorkItemKeyLocation(workspace.accessToken, key, workspace.canLoadWorkspaceData)

  if (lookup.data) {
    return <Navigate replace to={createTeamIssuesPath(lookup.data.teamId, lookup.data.workItemId)} />
  }

  const status: WorkItemKeyLookupStatus = !key
    ? 'invalid'
    : !lookup.error
      ? 'loading'
      : lookup.error instanceof TeamIssuesApiError && lookup.error.status === 404
        ? 'not-found'
        : 'failed'

  return (
    <WorkspaceRouteContent
      isLoading={false}
      sessionErrors={status === 'failed' ? [lookup.error] : []}
    >
      <WorkItemKeyStatus
        onRetry={() => void lookup.mutate()}
        retrying={lookup.isValidating}
        status={status}
        t={t}
        workItemKey={key ?? rawKey}
      />
    </WorkspaceRouteContent>
  )
}
