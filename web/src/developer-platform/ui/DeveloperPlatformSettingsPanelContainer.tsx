import { useMemo } from 'react'
import { useLocation } from 'react-router'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { Locale } from '../../shared/i18n/i18n'
import { DeveloperPlatformPanelContainer } from './DeveloperPlatformPanel'
import { createDeveloperPlatformLabels } from './labels'

/**
 * Inputs for the Settings-page Developer Platform adapter.
 */
export type DeveloperPlatformSettingsPanelContainerProps = {
  /** Access token used by Developer Platform APIs. */
  accessToken: string
  /** Locale used for labels and date formatting. */
  locale: Locale
  /** Workspace directory used to build import destinations. */
  teams: readonly ProjectDirectoryTeam[]
}

/**
 * Adapts Workspace settings context to the Developer Platform feature container.
 *
 * @param props - Authentication, locale, and Workspace directory inputs.
 * @returns The Developer Platform panel with route and import options configured.
 */
export function DeveloperPlatformSettingsPanelContainer({
  accessToken,
  locale,
  teams,
}: DeveloperPlatformSettingsPanelContainerProps) {
  const location = useLocation()
  const labels = useMemo(() => createDeveloperPlatformLabels(locale), [locale])
  const importTeamOptions = useMemo(
    () => teams.map((team) => ({
      value: team.id,
      label: team.name,
      description: team.id,
    })),
    [teams],
  )
  const importProjectOptions = useMemo(
    () => teams.flatMap((team) =>
      team.projects.map((project) => ({
        value: project.id,
        label: project.name,
        description: team.name,
        teamId: team.id,
      })),
    ),
    [teams],
  )
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    [locale],
  )
  const initialSection = useMemo(
    () => new URLSearchParams(location.search).get('developerSection') === 'connectors'
      ? 'connectors'
      : undefined,
    [location.search],
  )

  return (
    <DeveloperPlatformPanelContainer
      accessToken={accessToken}
      formatDateTime={(value) => dateTimeFormatter.format(new Date(value))}
      initialSection={initialSection}
      importProjectOptions={importProjectOptions}
      importTeamOptions={importTeamOptions}
      labels={labels}
    />
  )
}
