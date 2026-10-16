import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { CollectionApiError } from '../../features/collections/api/collections'
import { collectionCandidateKey } from '../../features/collections/model/collectionCandidates'
import { resolveCollectionErrorMessageKey } from '../../features/collections/model/collectionErrors'
import { useCollectionActions } from '../../features/collections/mutations/useCollectionActions'
import { useCollectionCandidates, useCollectionItems, useCollections } from '../../features/collections/queries/useCollections'
import { CollectionsWorkspace } from '../../features/collections/ui/CollectionsWorkspace'
import { createTranslator } from '../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Hosts Collections within the current Workspace session.
 *
 * @returns The Collections page, reset whenever the session changes.
 */
export function CollectionsPage() {
  const workspace = useWorkspaceRouteContext()
  return <CollectionsSession key={workspace.accessToken} />
}

/**
 * Loads Collections, the selected Collection's readable Work Items, and add candidates.
 *
 * @returns The Collections workspace inside the shared session boundary.
 */
function CollectionsSession() {
  const workspace = useWorkspaceRouteContext()
  const t = createTranslator(workspace.locale)
  const [params, setParams] = useSearchParams()
  const collections = useCollections(workspace.accessToken, workspace.canLoadWorkspaceData)
  const selectedId = params.get('collectionId') ?? collections.data?.collections[0]?.collectionId
  const canEdit = workspace.canMutateTeamConfiguration && collections.data?.canWrite === true
  // Only load items for a Collection the list contains; an unknown selection shows a notice instead.
  const selectedExists = collections.data?.collections.some((collection) => collection.collectionId === selectedId) === true
  const items = useCollectionItems(workspace.accessToken, selectedExists ? selectedId : undefined, workspace.canLoadWorkspaceData)
  const [candidateQuery, setCandidateQuery] = useState('')
  const listedItems = items.data?.collection.collectionId === selectedId ? items.data?.items : undefined
  const candidates = useCollectionCandidates(
    workspace.accessToken,
    candidateQuery,
    (listedItems ?? []).map((item) => collectionCandidateKey(item.teamId, item.issueId)),
    workspace.canLoadWorkspaceData && canEdit && Boolean(selectedId) && listedItems !== undefined,
  )
  const actions = useCollectionActions(workspace.accessToken, workspace.guardEnterpriseSession)
  const actionError = actions.error instanceof CollectionApiError
    ? resolveCollectionErrorMessageKey(actions.error.status, actions.error.code)
    : actions.error ? resolveCollectionErrorMessageKey(undefined, undefined) : undefined

  return (
    <WorkspaceRouteContent sessionErrors={[collections.error, items.error, candidates.error]}>
      <div className="px-[clamp(16px,3vw,34px)] py-5">
        <CollectionsWorkspace
          candidateQuery={candidateQuery}
          candidates={candidates.data}
          candidatesFailed={Boolean(candidates.error)}
          canEdit={canEdit}
          collections={collections.data?.collections}
          accessDenied={collections.error instanceof CollectionApiError && collections.error.status === 403}
          collectionsFailed={Boolean(collections.error)}
          errorMessage={actionError ? t(actionError) : undefined}
          items={listedItems}
          itemsFailed={Boolean(items.error)}
          onAddItem={(teamId, issueId) => {
            if (selectedId) void actions.addItem(selectedId, teamId, issueId)
          }}
          onCreate={async (name, description) => {
            const created = await actions.create(name, description || undefined)
            if (created) setParams({ collectionId: created.collectionId })
            return Boolean(created)
          }}
          onDelete={(collection) => {
            void actions.remove(collection).then((deleted) => {
              if (deleted) setParams({})
            })
          }}
          onSearchCandidates={setCandidateQuery}
          onRetryCandidates={() => { void candidates.mutate() }}
          onRetryCollections={() => { void collections.mutate() }}
          onRetryItems={() => { void items.mutate() }}
          onRemoveItem={(teamId, issueId) => {
            if (selectedId) void actions.removeItem(selectedId, teamId, issueId)
          }}
          onRename={async (collection, name, description) => Boolean(await actions.rename(collection, name, description))}
          onSelect={(collectionId) => {
            actions.clearError()
            setParams({ collectionId })
          }}
          pending={actions.pending}
          selectedId={selectedId}
          t={t}
          workItemHref={(teamId, issueId) => createTeamIssuesPath(teamId, issueId)}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
