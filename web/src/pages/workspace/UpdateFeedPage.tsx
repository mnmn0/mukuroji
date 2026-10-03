import { useSearchParams } from 'react-router'
import { isUpdateFeedView } from '../../features/update-feed/model/updateFeed'
import { useUpdateFeedReadState } from '../../features/update-feed/mutations/useUpdateFeedReadState'
import { useUpdateFeed } from '../../features/update-feed/queries/useUpdateFeed'
import { UpdateFeed } from '../../features/update-feed/ui/UpdateFeed'
import { createTranslator } from '../../shared/i18n/i18n'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** Hosts the server-ranked feed within the current Workspace session.
 * @returns URL-selected feed inside the shared session boundary.
 */
export function UpdateFeedPage() {
  const workspace = useWorkspaceRouteContext()
  return <UpdateFeedSession key={workspace.accessToken} />
}

/** Keeps pending actions isolated from a replacement authenticated session. */
function UpdateFeedSession() {
  const workspace = useWorkspaceRouteContext()
  const [params, setParams] = useSearchParams()
  const rawView = params.get('view')
  const view = isUpdateFeedView(rawView) ? rawView : 'for-me'
  const query = useUpdateFeed(workspace.accessToken, workspace.canLoadWorkspaceData, view)
  const actions = useUpdateFeedReadState(workspace.accessToken, () => query.mutate(), workspace.guardEnterpriseSession)
  return <WorkspaceRouteContent sessionErrors={[query.error, actions.error]}>
    <div className="px-[clamp(16px,3vw,34px)] py-5">
      <UpdateFeed response={query.data} view={view} locale={workspace.locale} t={createTranslator(workspace.locale)} loading={query.isLoading} failed={Boolean(query.error)} mutationFailed={Boolean(actions.error)} pending={actions.pending} onRetry={() => { void query.mutate() }} onToggle={(entry) => { void actions.toggle(entry) }} onViewChange={(next) => setParams({ view: next })} />
    </div>
  </WorkspaceRouteContent>
}
