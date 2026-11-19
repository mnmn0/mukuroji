import type { ProjectRaidEntry, ProjectRaidEntryInput } from '@mukuroji/contracts'
import { useCallback } from 'react'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createProjectRaidEntry, updateProjectRaidEntry } from '../api/raidLog'
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
  /** Whether the viewer may add and change entries; the server checks again. */
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
export function ProjectRaidLogSection({ accessToken, teamId, projectId, enabled, canEdit, t }: ProjectRaidLogSectionProps) {
  const log = useProjectRaidLog(accessToken, teamId, projectId, enabled)
  const { mutate } = log
  const save = useCallback(async (entry: ProjectRaidEntry | undefined, input: ProjectRaidEntryInput) => {
    if (!accessToken || !teamId) return
    const context = createMutationRequestContext()
    if (entry) {
      await updateProjectRaidEntry(accessToken, teamId, projectId, entry.id, entry.revision, input, context)
    } else {
      await createProjectRaidEntry(accessToken, teamId, projectId, input, context)
    }
    await mutate()
  }, [accessToken, mutate, projectId, teamId])

  if (!teamId) return null
  return (
    <ProjectRaidLogPanel
      key={JSON.stringify([teamId, projectId])}
      canEdit={canEdit}
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
