import { useSearchParams } from 'react-router'
import { useState } from 'react'
import { isUpdateFeedView } from '../../features/update-feed/model/updateFeed'
import { UpdateFeedApiError } from '../../features/update-feed/api/updateFeed'
import { useUpdateFeedReadState } from '../../features/update-feed/mutations/useUpdateFeedReadState'
import { useUpdateFeed } from '../../features/update-feed/queries/useUpdateFeed'
import { UpdateFeed } from '../../features/update-feed/ui/UpdateFeed'
import { SavedUpdateFeedsPanel } from '../../features/update-feed/ui/SavedUpdateFeedsPanel'
import { DigestPanelContainer } from '../../features/update-feed/ui/DigestPanelContainer'
import { useSavedUpdateFeeds, useUpdateFeedFilterOptions } from '../../features/update-feed/queries/useSavedUpdateFeeds'
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
  const [editing, setEditing] = useState(false)
  const saved = useSavedUpdateFeeds(workspace.accessToken, workspace.canLoadWorkspaceData, workspace.guardEnterpriseSession)
  const options = useUpdateFeedFilterOptions(workspace.accessToken, workspace.canLoadWorkspaceData && workspace.canMutateTeamConfiguration && editing, workspace.locale)
  const selectedId = params.get('feedId') ?? ''
  const definition = saved.data?.feeds.find((feed) => feed.id === selectedId)
  const rawView = params.get('view')
  const view = definition?.view ?? (isUpdateFeedView(rawView) ? rawView : 'for-me')
  const query = useUpdateFeed(workspace.accessToken, workspace.canLoadWorkspaceData && (!selectedId || definition !== undefined), view, workspace.locale, selectedId || undefined)
  const actions = useUpdateFeedReadState(workspace.accessToken, () => query.mutate(), workspace.guardEnterpriseSession)
  const t = createTranslator(workspace.locale)
  const controls = query.error ? undefined : <SavedUpdateFeedsPanel collection={saved.data} selectedId={selectedId} options={options.data} optionsFailed={Boolean(options.error)} failed={Boolean(saved.error)} denied={saved.error instanceof UpdateFeedApiError && saved.error.status === 403} canEdit={workspace.canMutateTeamConfiguration} pending={saved.pending} error={saved.mutationError} t={t} onEditingChange={setEditing} onClearError={saved.clearMutationError} onSelect={(feedId) => setParams(feedId ? { feedId } : { view: 'for-me' })} onReload={() => { void saved.mutate(); void options.mutate() }} onSave={saved.replace} />
  return <WorkspaceRouteContent sessionErrors={[query.error, actions.error, saved.error, saved.mutationError, options.error]}>
    <div className="px-[clamp(16px,3vw,34px)] py-5">
      {!query.error && !saved.error ? <DigestPanelContainer key={`${workspace.accessToken}:${workspace.locale}`} contentKey={`${selectedId}:${view}:${saved.data?.revision}:${query.data?.revision}`} token={workspace.accessToken} enabled={workspace.canLoadWorkspaceData} canEdit={workspace.canMutateTeamConfiguration} locale={workspace.locale} guard={workspace.guardEnterpriseSession} /> : null}
      <UpdateFeed controls={controls} response={query.data} view={view} locale={workspace.locale} t={t} loading={query.isLoading || Boolean(selectedId && saved.isLoading)} failed={Boolean(query.error)} denied={query.error instanceof UpdateFeedApiError && query.error.status === 403} canMarkRead={workspace.canMutateTeamConfiguration} mutationFailed={Boolean(actions.error)} pending={actions.pending} onRetry={() => { void query.mutate(); void saved.mutate() }} onToggle={(entry) => { void actions.toggle(entry) }} onViewChange={(next) => setParams({ view: next })} />
    </div>
  </WorkspaceRouteContent>
}
