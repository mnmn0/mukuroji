import { useMemo } from 'react'
import { useProjectIssues } from '../../issues/queries/useWorkItems'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { createDecisionDateTimeFormatter } from '../model/projectDecisionMessages'
import { useSaveProjectDecision } from '../mutations/useSaveProjectDecision'
import { useProjectDecisionLog } from '../queries/useProjectDecisionLog'
import type { ProjectDecisionReferenceOption } from './ProjectDecisionForm'
import { ProjectDecisionLogPanel } from './ProjectDecisionLogPanel'

/** Props of the self-loading Project decision log section. */
export type ProjectDecisionLogSectionProps = {
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
  /** Project members who may be named as deciders. */
  memberOptions?: readonly ProjectDecisionReferenceOption[]
  /** Display locale of timestamps. */
  locale: Locale
  /** Translator for every label. */
  t: (key: MessageKey) => string
}

/**
 * Connects the Project decision log panel to its query and save mutation.
 *
 * @param props - Session, Project identity, and permission.
 * @returns The panel, or nothing while the owning Team is unknown.
 */
export function ProjectDecisionLogSection({
  accessToken,
  teamId,
  projectId,
  enabled,
  canMutate,
  memberOptions,
  locale,
  t,
}: ProjectDecisionLogSectionProps) {
  const log = useProjectDecisionLog(accessToken, teamId, projectId, enabled)
  // Every Work Item of the Project, so related Work Items outside the shown period keep their labels.
  const { data: projectIssues } = useProjectIssues(accessToken, projectId, enabled, true)
  const workItemOptions = useMemo<ProjectDecisionReferenceOption[] | undefined>(
    () => projectIssues
      ?.filter((issue) => issue.teamId === teamId)
      .map((issue) => ({ id: issue.id, label: issue.key ? `${issue.key} ${issue.title}` : issue.title })),
    [projectIssues, teamId],
  )
  const formatDateTime = useMemo(() => createDecisionDateTimeFormatter(locale), [locale])
  const save = useSaveProjectDecision({ accessToken })
  if (!teamId) return null
  return (
    <ProjectDecisionLogPanel
      key={JSON.stringify([teamId, projectId])}
      canEdit={canMutate && log.data?.viewer.canEdit === true}
      entries={log.data?.entries}
      formatDateTime={formatDateTime}
      hasLoadError={Boolean(log.error)}
      isLoading={log.isLoading}
      memberOptions={memberOptions ?? []}
      t={t}
      workItemOptions={workItemOptions}
      onReload={() => void log.mutate()}
      onSave={(entry, input) => save(teamId, projectId, entry, input)}
    />
  )
}
