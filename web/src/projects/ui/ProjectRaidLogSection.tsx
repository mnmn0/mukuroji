import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectRaidReferenceOption } from '../model/projectRaidLogExport'
import { useSaveProjectRaidEntry } from '../mutations/useSaveProjectRaidEntry'
import { useProjectRaidLog } from '../queries/useProjectRaidLog'
import { ProjectRaidLogPanel } from './ProjectRaidLogPanel'

/** Props of the self-loading Project log section. */
export type ProjectRaidLogSectionProps = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Project; the section waits while it is unknown. */
  teamId?: string
  /** Project identifier. */
  projectId: string
  /** Whether loading is allowed for the current session. */
  enabled: boolean
  /** Whether this session may change content at all, for example while online. */
  canMutate: boolean
  /** Fallback edit permission used until the server states the viewer's capabilities. */
  canEdit: boolean
  /** Project members who may own an entry. */
  ownerOptions?: readonly ProjectRaidReferenceOption[]
  /** Work Items of the Project an entry may name as related. */
  workItemOptions?: readonly ProjectRaidReferenceOption[]
  /** Translator for every label. */
  t: (key: MessageKey) => string
  /**
   * Receives each failed load with the access token it was sent with, so an expired session can
   * be sent to sign in again without acting on a token that was already replaced.
   */
  onSessionError?: (error: unknown, requestAccessToken: string) => void
}

/**
 * Formats a date as `YYYY-MM-DD` in the viewer's time zone.
 *
 * @param date - Date to format.
 * @returns The local calendar date.
 */
function toLocalDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Connects the Project risk, issue, and change request log panel to its query and mutations.
 *
 * @param props - Session, Project identity, and permission.
 * @returns The panel, or nothing while the owning Team is unknown.
 */
export function ProjectRaidLogSection({
  accessToken,
  teamId,
  projectId,
  enabled,
  canMutate,
  canEdit,
  ownerOptions,
  workItemOptions,
  t,
  onSessionError,
}: ProjectRaidLogSectionProps) {
  const log = useProjectRaidLog(accessToken, teamId, projectId, enabled, onSessionError)
  const { mutate } = log
  const save = useSaveProjectRaidEntry({ accessToken, teamId, projectId })

  if (!teamId) return null
  return (
    <ProjectRaidLogPanel
      key={JSON.stringify([teamId, projectId])}
      canEdit={canMutate && (log.data?.viewer?.canEdit ?? canEdit)}
      entries={log.data?.entries}
      hasLoadError={Boolean(log.error)}
      isLoading={log.isLoading}
      ownerOptions={ownerOptions}
      t={t}
      today={toLocalDate(new Date())}
      workItemOptions={workItemOptions}
      onReload={() => void mutate()}
      onSave={save}
    />
  )
}
