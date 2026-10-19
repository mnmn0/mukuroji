import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { createTranslator, type MessageKey } from '../../shared/i18n/i18n'
import { createTeamTriagePath } from '../../shared/routing/paths'
import {
  cancelStoredSharedContent,
  discardStoredSharedContent,
  isStoredSharedContentCancelled,
  readStoredSharedContent,
  sharedContentNotSavedStatus,
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

/** Message shown for each failed send that created nothing and can be edited. */
const failureMessageKeys: Record<ShareHandoffFailure, MessageKey> = {
  forbidden: 'triage.share.forbidden',
  rejected: 'triage.share.error',
  uncertain: 'triage.share.uncertain',
  unsaved: 'triage.share.unsaved',
}

/** Message shown for each failed retry of a send that may already be saved. */
const lockedFailureMessageKeys: Record<ShareHandoffFailure, MessageKey> = {
  forbidden: 'triage.share.lockedForbidden',
  rejected: 'triage.share.uncertain',
  uncertain: 'triage.share.uncertain',
  unsaved: 'triage.share.uncertain',
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

  // The worker could not keep the share, so there is nothing to confirm.
  if (searchParams.get('status') === sharedContentNotSavedStatus) return <ShareNotSaved />

  return <ShareCapture key={sharedId} sharedId={sharedId} />
}

/**
 * Explains that the service worker could not keep a share and offers a way out.
 *
 * @returns The storage failure message inside the Workspace shell.
 */
function ShareNotSaved() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])

  return (
    <WorkspaceRouteContent isLoading={workspace.isLoading}>
      <div className="mx-auto grid w-full max-w-2xl gap-5 px-[clamp(16px,3vw,34px)] py-5">
        <section aria-label={t('triage.share.title')} className="workbench-panel grid gap-4 p-5" data-testid="share-capture">
          <p className="text-sm text-[var(--workbench-text)]" role="alert">{t('triage.share.notSaved')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="workbench-button-secondary min-h-11 px-4"
              onClick={() => { void navigate('/home', { replace: true }) }}
              type="button"
            >
              {t('triage.share.cancel')}
            </button>
          </div>
        </section>
      </div>
    </WorkspaceRouteContent>
  )
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
  const [loadFailed, setLoadFailed] = useState(false)
  const [missing, setMissing] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [receivedAt, setReceivedAt] = useState<number>()
  const [loadAttempt, setLoadAttempt] = useState(0)
  const mountedRef = useRef(true)
  const access = useWorkspaceAccess(workspace.accessToken, workspace.canLoadWorkspaceData)
  const handoff = useShareHandoff({
    accessToken: workspace.accessToken,
    guardEnterpriseSession: workspace.guardEnterpriseSession,
    requesterDisplayName: workspace.userLabel,
    handoffKey: sharedId,
    accountKey: `${workspace.workspaceId ?? ''}/${workspace.userKey ?? ''}`,
    receivedAt,
  })
  const teams = useMemo(
    () => workspace.teams.map((team) => ({ id: team.id, name: team.name })),
    [workspace.teams],
  )
  const isGuest = access.data?.currentMember.role === 'guest'
  // The form stays unavailable until both the content and the person's role are known.
  const accessFailed = access.error !== undefined && !access.data
  const loadErrorKey: MessageKey | undefined = loadFailed && !content
    ? 'triage.share.loadError'
    : accessFailed ? 'triage.share.accessError' : undefined
  // A locked attempt keeps its own copy of the content, so it can still be resent unless the
  // person cancelled the share in another tab.
  const isMissing = cancelled || (missing && !handoff.locked)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let active = true
    readStoredSharedContent(sharedId).then(
      (fields) => {
        if (!active) return
        setLoadFailed(false)
        // A share ID whose content is gone (expired, already sent, or never stored) must not
        // become a blank form that looks like the share.
        setMissing(sharedId !== '' && fields === undefined)
        setReceivedAt(fields?.receivedAt)
        setContent(readSharedContent(fields))
      },
      () => {
        // A storage failure is not an empty share; offer a retry instead of a blank draft.
        if (active) setLoadFailed(true)
      },
    )
    return () => { active = false }
  }, [loadAttempt, sharedId])

  /** Leaves the form, ending the handoff in every tab and deleting the stored attempt. */
  function leave() {
    handoff.abandon()
    void cancelStoredSharedContent(sharedId)
    void navigate('/home', { replace: true })
  }

  return (
    <WorkspaceRouteContent
      isLoading={workspace.isLoading || (content === undefined && !loadFailed) || (access.isLoading && !access.data)}
      sessionErrors={access.error ? [access.error] : undefined}
    >
      <div className="mx-auto grid w-full max-w-2xl gap-5 px-[clamp(16px,3vw,34px)] py-5">
        {loadErrorKey ? (
          <section aria-label={t('triage.share.title')} className="workbench-panel grid gap-4 p-5" data-testid="share-capture">
            <p className="text-sm text-[var(--workbench-text)]" role="alert">{t(loadErrorKey)}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="workbench-button-secondary min-h-11 px-4" onClick={leave} type="button">
                {t('triage.share.cancel')}
              </button>
              <button
                className="workbench-button-primary min-h-11 px-4"
                onClick={() => {
                  if (loadFailed) setLoadAttempt((attempt) => attempt + 1)
                  if (accessFailed) void access.mutate()
                }}
                type="button"
              >
                {t('triage.share.reload')}
              </button>
            </div>
          </section>
        ) : null}
        {isMissing && !loadErrorKey ? (
          <section aria-label={t('triage.share.title')} className="workbench-panel grid gap-4 p-5" data-testid="share-capture">
            <p className="text-sm text-[var(--workbench-text)]" role="alert">{t('triage.share.missing')}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="workbench-button-secondary min-h-11 px-4" onClick={leave} type="button">
                {t('triage.share.cancel')}
              </button>
            </div>
          </section>
        ) : null}
        {content && !loadErrorKey && !isMissing ? (
          <ShareCaptureForm
            errorMessage={handoff.failure
              ? t((handoff.locked ? lockedFailureMessageKeys : failureMessageKeys)[handoff.failure])
              : undefined}
            initialContent={content}
            isSubmitting={handoff.isSubmitting}
            lockedSend={handoff.locked}
            onCancel={leave}
            onSubmit={(teamId, draft) => {
              void isStoredSharedContentCancelled(sharedId).then((wasCancelled) => {
                if (!wasCancelled) return handoff.submit(teamId, draft)
                // Cancel in another tab ends the handoff here too.
                handoff.abandon()
                setCancelled(true)
                return undefined
              }).then((result) => {
                if (!result) return
                // The handoff forgot its replay state, so the share must not be sendable again.
                void discardStoredSharedContent(sharedId)
                // Leaving through the shell mid-send must not be undone by a late success.
                if (!mountedRef.current) return
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
