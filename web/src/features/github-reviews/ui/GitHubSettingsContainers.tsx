import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { useGitHubLogin, useGitHubRepositoryLinks } from '../mutations/useGitHubSettings'
import { GitHubLoginPanel } from './GitHubLoginPanel'
import { GitHubRepositoryLinksPanel, type GitHubRepositoryTeamOption } from './GitHubRepositoryLinksPanel'

/** Inputs of the GitHub settings containers. */
export type GitHubSettingsContainerProps = {
  /** Access token of the signed-in member. */
  accessToken: string
  /** Locale of the screen. */
  locale: Locale
}

/**
 * Connects the personal GitHub login settings to the API.
 *
 * @param props - Session and locale.
 * @returns The settings section.
 */
export function GitHubLoginPanelContainer({ accessToken, locale }: GitHubSettingsContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const login = useGitHubLogin(accessToken)
  return (
    <GitHubLoginPanel
      busyOperation={login.busyOperation}
      hasLoadError={login.hasLoadError}
      isLoading={login.isLoading}
      t={t}
      onReload={() => void login.reload()}
      onRemove={() => void login.remove()}
      onSave={login.save}
      {...(login.githubLogin ? { githubLogin: login.githubLogin } : {})}
      {...(login.operationError ? { operationError: login.operationError } : {})}
    />
  )
}

/**
 * Connects the Workspace GitHub repository link settings to the API.
 *
 * @param props - Session, locale, and the Teams offered.
 * @param props.teams - Teams an administrator can link a repository to.
 * @returns The settings section.
 */
export function GitHubRepositoryLinksPanelContainer({
  accessToken,
  locale,
  teams,
}: GitHubSettingsContainerProps & { teams: readonly GitHubRepositoryTeamOption[] }) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const links = useGitHubRepositoryLinks(accessToken)
  return (
    <GitHubRepositoryLinksPanel
      busyOperation={links.busyOperation}
      hasLoadError={links.hasLoadError}
      isLoading={links.isLoading}
      t={t}
      teams={teams}
      onLink={(repository, teamId) => void links.link(repository, teamId)}
      onReload={() => void links.reload()}
      onUnlink={(repository) => void links.unlink(repository)}
      {...(links.listing ? { listing: links.listing } : {})}
      {...(links.operationError ? { operationError: links.operationError } : {})}
    />
  )
}
