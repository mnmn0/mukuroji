import type { GitHubRepositoryLink, GitHubRepositoryLinkListResponse } from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { SectionHeader } from '../../../shared/ui/WorkbenchPrimitives'
import type { GitHubSettingsOperationError } from '../mutations/useGitHubSettings'

/** Team an administrator can link a repository to. */
export type GitHubRepositoryTeamOption = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
}

/** Inputs of the GitHub repository link settings. */
export type GitHubRepositoryLinksPanelProps = {
  /** Repositories and their links, or `undefined` while loading. */
  listing?: GitHubRepositoryLinkListResponse
  /** Whether the listing is loading for the first time. */
  isLoading: boolean
  /** Whether the listing failed to load. */
  hasLoadError: boolean
  /** Key of the running operation, such as `link:<repositoryId>`. */
  busyOperation?: string
  /** Failure of the last operation. */
  operationError?: GitHubSettingsOperationError
  /** Teams offered. */
  teams: readonly GitHubRepositoryTeamOption[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Links a repository to a Team. */
  onLink: (repository: GitHubRepositoryLink, teamId: string) => void
  /** Removes a repository's link. */
  onUnlink: (repository: GitHubRepositoryLink) => void
  /** Loads the listing again. */
  onReload: () => void
}

/** Message of each operation failure. */
const OPERATION_ERROR_KEYS = {
  'login-taken': 'githubReviews.operationError',
  conflict: 'githubReviews.conflictError',
  'not-configured': 'githubReviews.notConfiguredError',
  failed: 'githubReviews.operationError',
} as const satisfies Record<GitHubSettingsOperationError, MessageKey>

/**
 * Renders the Workspace GitHub settings: each repository the App can read, with the Team it is
 * linked to.
 *
 * @param props - Listing, state, Teams, and actions.
 * @returns The settings section.
 */
export function GitHubRepositoryLinksPanel({
  listing,
  isLoading,
  hasLoadError,
  busyOperation,
  operationError,
  teams,
  t,
  onLink,
  onUnlink,
  onReload,
}: GitHubRepositoryLinksPanelProps) {
  const [selected, setSelected] = useState<Record<string, string>>({})
  const busy = busyOperation !== undefined

  return (
    <section className="workbench-panel overflow-hidden" data-testid="github-repository-links-panel">
      <SectionHeader title={t('githubReviews.links.title')} />
      <p className="px-5 pb-4 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {t('githubReviews.links.description')}
      </p>
      <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
        {operationError ? (
          <p className="px-5 py-3 text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
            {t(OPERATION_ERROR_KEYS[operationError])}
          </p>
        ) : null}
        {hasLoadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" role="alert">
            <span className="text-sm font-semibold text-[var(--workbench-danger)]">{t('githubReviews.loadError')}</span>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={onReload} type="button">
              {t('githubReviews.retry')}
            </button>
          </div>
        ) : isLoading || !listing ? (
          <p className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t('githubReviews.loading')}</p>
        ) : !listing.configured ? (
          <p className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t('githubReviews.links.notConfigured')}</p>
        ) : listing.repositories.length === 0 ? (
          <p className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t('githubReviews.links.empty')}</p>
        ) : (
          <>
            {listing.incomplete ? (
              <p className="px-5 py-3 text-sm font-medium text-[var(--workbench-warning)]" role="status">{t('githubReviews.links.incomplete')}</p>
            ) : null}
            <ul className="divide-y divide-[var(--workbench-border)]">
              {listing.repositories.map((repository) => {
                const choice = selected[repository.repositoryId] ?? repository.teamId ?? ''
                const unchanged = choice === (repository.teamId ?? '')
                return (
                  <li
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4"
                    data-testid="github-repository-link"
                    key={repository.repositoryId}
                  >
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm font-semibold text-[var(--workbench-text)]">{repository.repository}</p>
                      <p className="text-xs font-medium text-[var(--workbench-muted)]">
                        {repository.private ? t('githubReviews.links.private') : null}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor={`github-repository-team-${repository.repositoryId}`}>
                        {`${t('githubReviews.links.team')}: ${repository.repository}`}
                      </label>
                      <select
                        className="workbench-input min-h-10 px-3"
                        disabled={busy}
                        id={`github-repository-team-${repository.repositoryId}`}
                        onChange={(event) => {
                          const teamId = event.currentTarget.value
                          setSelected((current) => ({ ...current, [repository.repositoryId]: teamId }))
                        }}
                        value={choice}
                      >
                        <option value="">{t('githubReviews.links.unlinked')}</option>
                        {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                      </select>
                      <button
                        className="workbench-button-primary min-h-10 px-4"
                        disabled={busy || unchanged || choice === ''}
                        onClick={() => onLink(repository, choice)}
                        type="button"
                      >
                        {t('githubReviews.links.save')}
                      </button>
                      {repository.teamId ? (
                        <button
                          className="workbench-button-secondary min-h-10 px-4"
                          disabled={busy}
                          onClick={() => {
                            setSelected((current) => ({ ...current, [repository.repositoryId]: '' }))
                            onUnlink(repository)
                          }}
                          type="button"
                        >
                          {t('githubReviews.links.unlink')}
                        </button>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
