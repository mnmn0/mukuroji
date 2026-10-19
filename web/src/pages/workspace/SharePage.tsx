import { useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import { createTranslator } from '../../shared/i18n/i18n'
import { createTeamTriagePath } from '../../shared/routing/paths'
import {
  createShareHandoffIdentity,
  createShareHandoffInput,
  readSharedContent,
  type ShareHandoffDraft,
} from '../../features/share-capture/model/sharedContent'
import { ShareCaptureForm } from '../../features/share-capture/ui/ShareCaptureForm'
import { createTriageManualHandoff } from '../../triage/api'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders the Web Share Target route that hands shared content off to a Team Triage queue.
 *
 * Nothing is sent until the person confirms the form. A retry of the same content reuses the
 * idempotency key, so a lost response does not create a second entry.
 *
 * @returns The share confirmation form inside the Workspace shell.
 */
export function SharePage() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const [initialContent] = useState(() => readSharedContent(searchParams))
  const [identity] = useState(() => createShareHandoffIdentity())
  const runnerRef = useRef(createMutationRequestRunner())
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()
  const teams = useMemo(
    () => workspace.teams.map((team) => ({ id: team.id, name: team.name })),
    [workspace.teams],
  )
  const { accessToken, guardEnterpriseSession, userLabel } = workspace

  /**
   * Sends the confirmed content and opens the created entry in the Team's Triage queue.
   *
   * @param teamId - Destination Team.
   * @param draft - Confirmed title and body.
   */
  async function handleSubmit(teamId: string, draft: ShareHandoffDraft) {
    if (!accessToken) return
    const input = createShareHandoffInput(draft, identity, userLabel)
    setIsSubmitting(true)
    setErrorMessage(undefined)
    try {
      const fingerprint = await createMutationFingerprint(teamId, JSON.stringify(input))
      const receipt = await guardEnterpriseSession(runnerRef.current.run(
        `triage:share:${identity.sourceId}`,
        fingerprint,
        (context) => createTriageManualHandoff(teamId, input, accessToken, context),
      ))
      void navigate(createTeamTriagePath(teamId, receipt.entry.id), { replace: true })
    } catch {
      setErrorMessage(t('triage.share.error'))
      setIsSubmitting(false)
    }
  }

  return (
    <WorkspaceRouteContent isLoading={workspace.isLoading}>
      <div className="mx-auto grid w-full max-w-2xl gap-5 px-[clamp(16px,3vw,34px)] py-5">
        <ShareCaptureForm
          errorMessage={errorMessage}
          initialContent={initialContent}
          isSubmitting={isSubmitting}
          onCancel={() => { void navigate('/home', { replace: true }) }}
          onSubmit={(teamId, draft) => { void handleSubmit(teamId, draft) }}
          t={t}
          teams={teams}
        />
      </div>
    </WorkspaceRouteContent>
  )
}
