import { useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { createTranslator } from '../../shared/i18n/i18n'
import { replyToMyRequest } from '../../requests/api/myRequests'
import { readMyRequestId } from '../../requests/model/myRequests'
import { useMyRequest, useMyRequests } from '../../requests/queries/useRequestIntakeQueries'
import { MyRequestsView } from '../../requests/ui/MyRequestsView'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the "My requests" route, where a member follows the requests they sent.
 *
 * @returns The member's requests inside the shared Workspace shell.
 */
export function MyRequestsPage() {
  const workspace = useWorkspaceRouteContext()
  const [searchParams, setSearchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const selectedRequestId = readMyRequestId(searchParams.get('requestId'))
  const list = useMyRequests(workspace.accessToken, workspace.canLoadWorkspaceData)
  const detail = useMyRequest(
    workspace.canLoadWorkspaceData ? workspace.accessToken : undefined,
    selectedRequestId,
  )
  const requests = useMemo(() => (list.data ?? []).flatMap((page) => page.requests), [list.data])
  const lastPage = list.data?.at(-1)
  const accessToken = workspace.accessToken
  const { mutate: mutateDetail } = detail
  const { mutate: mutateList } = list

  /** Opens or closes one request, keeping the selection in the URL. */
  const selectRequest = useCallback((requestId: string | undefined) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (requestId) next.set('requestId', requestId)
      else next.delete('requestId')
      return next
    })
  }, [setSearchParams])

  /** Sends a reply and reloads the request and the list. */
  const reply = useCallback(async (requestId: string, body: string) => {
    if (!accessToken) throw new Error('Not signed in.')
    await mutationRunner.run(
      `my-request:reply:${requestId}`,
      body,
      (context) => replyToMyRequest(accessToken, requestId, { body }, context),
    )
    await Promise.all([mutateDetail(), mutateList()])
  }, [accessToken, mutateDetail, mutateList, mutationRunner])

  return (
    <WorkspaceRouteContent>
      <div className="grid gap-5 px-[clamp(20px,3vw,34px)] py-5">
        <MyRequestsView
          canLoadMore={Boolean(lastPage?.nextCursor)}
          hasDetailError={Boolean(detail.error)}
          hasLoadError={Boolean(list.error)}
          isLoading={list.isLoading}
          locale={workspace.locale}
          onLoadMore={() => void list.setSize(list.size + 1)}
          onReply={reply}
          onSelectRequest={selectRequest}
          requests={requests}
          selectedRequest={detail.data}
          selectedRequestId={selectedRequestId}
          t={t}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
