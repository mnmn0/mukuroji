import type { GitHubPullRequestInboxView } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { usePullRequestInboxQuery } from '../queries/useGitHubReviewsQueries'
import { PullRequestInbox } from './PullRequestInbox'

/** Inputs of the review inbox container. */
export type PullRequestInboxContainerProps = {
  /** Access token of the signed-in member, or `undefined` before sign-in. */
  accessToken: string | undefined
  /** Locale of the screen. */
  locale: Locale
  /** Teams the member can see, for the Team names. */
  teams: readonly { id: string, name: string }[]
  /** Path of the personal settings panel with the GitHub login. */
  loginSettingsPath: string
}

/**
 * Connects the review inbox to the API; the tab is kept while the page stays open.
 *
 * @param props - Session, locale, Teams, and the login settings path.
 * @returns The inbox.
 */
export function PullRequestInboxContainer({ accessToken, locale, teams, loginSettingsPath }: PullRequestInboxContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [view, setView] = useState<GitHubPullRequestInboxView>('to-review')
  const { data, error, isLoading, mutate } = usePullRequestInboxQuery(accessToken, view)
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )
  const teamNames = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams])
  return (
    <PullRequestInbox
      formatDateTime={(value) => formatter.format(new Date(value))}
      hasLoadError={Boolean(error)}
      isLoading={isLoading}
      loginSettingsPath={loginSettingsPath}
      t={t}
      teamName={(teamId) => teamNames.get(teamId)}
      view={view}
      onReload={() => void mutate()}
      onViewChange={setView}
      {...(data ? { inbox: data } : {})}
    />
  )
}
