import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { createTranslator, type MessageKey } from '../../shared/i18n/i18n'
import { createTeamTriagePath } from '../../shared/routing/paths'
import {
  discardStoredSharedContent,
  readStoredSharedContent,
} from '../../shared/lib/pwa/sharedContentInbox'
import {
  readSharedContent,
  type SharedContent,
} from '../../features/share-capture/model/sharedContent'
import {
  useShareHandoff,
  type ShareHandoffFailure,
} from '../../features/share-capture/mutations/useShareHandoff'
import { ShareCaptureForm } from '../../features/share-capture/ui/ShareCaptureForm'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** Message shown for each failed send. */
const failureMessageKeys: Record<ShareHandoffFailure, MessageKey> = {
  forbidden: 'triage.share.forbidden',
  rejected: 'triage.share.error',
  uncertain: 'triage.share.uncertain',
}

/**
 * Renders the Web Share Target route that hands shared content off to a Team Triage queue.
 *
 * The service worker stores the shared content and passes only its opaque ID in `shared`, so
 * each new share remounts the form with fresh content and a fresh handoff identity.
 *
 * @returns The share confirmation form inside the Workspace shell.
 */
export function SharePage() {
  const [searchParams] = useSearchParams()
  const sharedId = searchParams.get('shared') ?? ''

  return <ShareCapture key={sharedId} sharedId={sharedId} />
}

/** Props of one share confirmation. */
type ShareCaptureProps = {
  /** Opaque ID of the stored shared content; empty when nothing was shared. */
  readonly sharedId: string
}

/**
 * Loads one share and lets the person send it to a Team Triage queue.
 *
 * Nothing is sent until the person confirms the form. The stored content is deleted once it
 * is sent or the person leaves through Cancel.
 *
 * @param props - Stored content ID.
 * @returns The share confirmation form.
 */
function ShareCapture({ sharedId }: ShareCaptureProps) {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const [content, setContent] = useState<SharedContent>()
  const access = useWorkspaceAccess(workspace.accessToken, workspace.canLoadWorkspaceData)
  const handoff = useShareHandoff({
    accessToken: workspace.accessToken,
    guardEnterpriseSession: workspace.guardEnterpriseSession,
    requesterDisplayName: workspace.userLabel,
  })
  const teams = useMemo(
    () => workspace.teams.map((team) => ({ id: team.id, name: team.name })),
    [workspace.teams],
  )
  const isGuest = access.data?.currentMember.role === 'guest'

  useEffect(() => {
    let active = true
    void readStoredSharedContent(sharedId)
      .catch(() => undefined)
      .then((fields) => {
        if (active) setContent(readSharedContent(fields))
      })
    return () => { active = false }
  }, [sharedId])

  /** Leaves the form and deletes the stored content. */
  function leave() {
    void discardStoredSharedContent(sharedId)
    void navigate('/home', { replace: true })
  }

  return (
    <WorkspaceRouteContent
      isLoading={workspace.isLoading || content === undefined || (access.isLoading && !access.data)}
      sessionErrors={access.error ? [access.error] : undefined}
    >
      <div className="mx-auto grid w-full max-w-2xl gap-5 px-[clamp(16px,3vw,34px)] py-5">
        {content ? (
          <ShareCaptureForm
            errorMessage={handoff.failure ? t(failureMessageKeys[handoff.failure]) : undefined}
            initialContent={content}
            isSubmitting={handoff.isSubmitting}
            lockedSend={handoff.locked}
            onCancel={leave}
            onSubmit={(teamId, draft) => {
              void handoff.submit(teamId, draft).then((result) => {
                if (!result) return
                void discardStoredSharedContent(sharedId)
                void navigate(createTeamTriagePath(result.teamId, result.receipt.entry.id), { replace: true })
              })
            }}
            t={t}
            teams={teams}
            unavailableMessage={isGuest ? t('triage.share.guest') : undefined}
          />
        ) : null}
      </div>
    </WorkspaceRouteContent>
  )
}
