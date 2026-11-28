import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { useSlackIngestChanges } from '../mutations/useSlackIngestChanges'
import { SlackIngestPanel, type SlackIngestTeamOption } from './SlackIngestPanel'

/** Inputs of the Slack ingest settings container. */
export type SlackIngestPanelContainerProps = {
  /** Administrator access token. */
  accessToken: string
  /** Display locale. */
  locale: Locale
  /** Teams and Projects offered as targets. */
  teams: readonly SlackIngestTeamOption[]
}

/**
 * Connects the Slack ingest settings to the Workspace API.
 *
 * @param props - Session, locale, and Teams.
 * @returns The settings section.
 */
export function SlackIngestPanelContainer({ accessToken, locale, teams }: SlackIngestPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const changes = useSlackIngestChanges(accessToken)
  return (
    <SlackIngestPanel
      {...(changes.busyOperation ? { busyOperation: changes.busyOperation } : {})}
      hasLoadError={changes.hasLoadError}
      hasOperationError={changes.hasOperationError}
      onReload={changes.reload}
      onSaveRetention={changes.saveRetention}
      onSetTarget={changes.setTarget}
      {...(changes.status ? { status: changes.status } : {})}
      t={t}
      teams={teams}
    />
  )
}
