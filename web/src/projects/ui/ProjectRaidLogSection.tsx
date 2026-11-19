import type { MessageKey } from '../../shared/i18n/i18n'
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
  /** Translator for every label. */
  t: (key: MessageKey) => string
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
  t,
}: ProjectRaidLogSectionProps) {
  const log = useProjectRaidLog(accessToken, teamId, projectId, enabled)
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
      t={t}
      today={toLocalDate(new Date())}
      onReload={() => void mutate()}
      onSave={save}
    />
  )
}
