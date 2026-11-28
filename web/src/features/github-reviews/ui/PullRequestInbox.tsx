import {
  GITHUB_PULL_REQUEST_INBOX_VIEWS,
  GITHUB_PULL_REQUEST_SECTIONS,
  type GitHubPullRequestInboxResponse,
  type GitHubPullRequestInboxView,
  type GitHubPullRequestSummary,
} from '@mukuroji/contracts'
import { useId, useRef, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import type { MessageKey } from '../../../shared/i18n/i18n'

/** Inputs of the pull request review inbox. */
export type PullRequestInboxProps = {
  /** Tab shown. */
  view: GitHubPullRequestInboxView
  /** Inbox of the tab, or `undefined` while loading. */
  inbox?: GitHubPullRequestInboxResponse
  /** Whether the inbox is loading for the first time. */
  isLoading: boolean
  /** Whether the inbox failed to load. */
  hasLoadError: boolean
  /** Path of the personal settings panel where the member registers a GitHub login. */
  loginSettingsPath: string
  /** Resolves a Team ID to its name. */
  teamName: (teamId: string) => string | undefined
  /** Formats an ISO timestamp for display. */
  formatDateTime: (value: string) => string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Switches the tab. */
  onViewChange: (view: GitHubPullRequestInboxView) => void
  /** Loads the inbox again. */
  onReload: () => void
}

/**
 * Renders the review inbox: a `To review` and a `Created` tab, each grouped into ready to merge,
 * open, merged, and closed pull requests.
 *
 * @param props - Inbox, state, and actions.
 * @returns The inbox.
 */
export function PullRequestInbox({
  view,
  inbox,
  isLoading,
  hasLoadError,
  loginSettingsPath,
  teamName,
  formatDateTime,
  t,
  onViewChange,
  onReload,
}: PullRequestInboxProps) {
  const baseId = useId()
  const tabRefs = useRef<Partial<Record<GitHubPullRequestInboxView, HTMLButtonElement | null>>>({})

  /**
   * Moves between tabs with the arrow keys.
   *
   * @param event - Key event of the focused tab.
   * @param current - Focused tab.
   */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: GitHubPullRequestInboxView) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = GITHUB_PULL_REQUEST_INBOX_VIEWS.indexOf(current)
    const offset = event.key === 'ArrowRight' ? 1 : -1
    const next = GITHUB_PULL_REQUEST_INBOX_VIEWS[(index + offset + GITHUB_PULL_REQUEST_INBOX_VIEWS.length) % GITHUB_PULL_REQUEST_INBOX_VIEWS.length]
    onViewChange(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <section className="mx-auto grid w-full max-w-5xl gap-4" aria-label={t('githubReviews.title')} data-testid="pull-request-inbox">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div aria-label={t('githubReviews.tabs.label')} className="flex gap-1 border-b border-[var(--workbench-border)]" role="tablist">
          {GITHUB_PULL_REQUEST_INBOX_VIEWS.map((value) => (
            <button
              aria-controls={`${baseId}-panel`}
              aria-selected={view === value}
              className={`-mb-px min-h-10 border-b-2 px-3 text-sm font-semibold ${view === value
                ? 'border-[var(--workbench-primary)] text-[var(--workbench-text)]'
                : 'border-transparent text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'}`}
              data-testid={`pull-request-inbox-tab-${value}`}
              id={`${baseId}-${value}-tab`}
              key={value}
              ref={(element) => {
                tabRefs.current[value] = element
              }}
              role="tab"
              tabIndex={view === value ? 0 : -1}
              type="button"
              onClick={() => onViewChange(value)}
              onKeyDown={(event) => handleTabKeyDown(event, value)}
            >
              {t(`githubReviews.tabs.${value}`)}
            </button>
          ))}
        </div>
        {inbox?.githubLogin ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t('githubReviews.signedInAs')}: <span className="font-mono">{inbox.githubLogin}</span>
          </p>
        ) : null}
      </div>
      <div aria-labelledby={`${baseId}-${view}-tab`} className="grid gap-4" id={`${baseId}-panel`} role="tabpanel">
        <InboxBody
          formatDateTime={formatDateTime}
          hasLoadError={hasLoadError}
          inbox={inbox}
          isLoading={isLoading}
          loginSettingsPath={loginSettingsPath}
          t={t}
          teamName={teamName}
          view={view}
          onReload={onReload}
        />
      </div>
    </section>
  )
}

/**
 * Renders the state or the grouped pull requests of one tab.
 *
 * @param props - The inbox props without the tab switch.
 * @returns The tab content.
 */
function InboxBody({
  view,
  inbox,
  isLoading,
  hasLoadError,
  loginSettingsPath,
  teamName,
  formatDateTime,
  t,
  onReload,
}: Omit<PullRequestInboxProps, 'onViewChange'>) {
  if (hasLoadError) {
    return (
      <div className="workbench-panel flex flex-wrap items-center justify-between gap-3 px-5 py-4" role="alert">
        <span className="text-sm font-semibold text-[var(--workbench-danger)]">{t('githubReviews.loadError')}</span>
        <button className="workbench-button-secondary min-h-10 px-4" onClick={onReload} type="button">
          {t('githubReviews.retry')}
        </button>
      </div>
    )
  }
  if (isLoading || !inbox) {
    return <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('githubReviews.loading')}</p>
  }
  if (!inbox.configured) {
    return <p className="workbench-panel px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t('githubReviews.notConfigured')}</p>
  }
  if (!inbox.githubLogin) {
    return (
      <div className="workbench-panel grid gap-3 px-5 py-4" data-testid="pull-request-inbox-no-login">
        <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('githubReviews.noLogin')}</p>
        <Link className="workbench-button-primary inline-flex min-h-10 w-fit items-center px-4" to={loginSettingsPath}>
          {t('githubReviews.noLoginAction')}
        </Link>
      </div>
    )
  }
  const incompleteWarning = inbox.incomplete ? (
    <p className="text-sm font-medium text-[var(--workbench-warning)]" role="status">{t('githubReviews.incomplete')}</p>
  ) : null
  if (inbox.items.length === 0) {
    return (
      <>
        {incompleteWarning}
        <p className="workbench-panel px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t(`githubReviews.empty.${view}`)}</p>
      </>
    )
  }
  return (
    <>
      {incompleteWarning}
      {GITHUB_PULL_REQUEST_SECTIONS.map((section) => {
        const items = inbox.items.filter((item) => item.section === section)
        if (items.length === 0) return null
        return (
          <section className="workbench-panel overflow-hidden" data-testid={`pull-request-section-${section}`} key={section}>
            <h2 className="flex items-center gap-2 px-5 py-3 text-sm font-semibold text-[var(--workbench-text)]">
              {t(`githubReviews.section.${section}`)}
              <span className="text-[var(--workbench-muted)]">{items.length}</span>
            </h2>
            <ul className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
              {items.map((item) => (
                <PullRequestRow
                  formatDateTime={formatDateTime}
                  item={item}
                  key={`${item.repositoryId}#${item.number}`}
                  t={t}
                  teamName={teamName}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </>
  )
}

/**
 * Renders one pull request with its badges and failed checks.
 *
 * @param props - Pull request and formatters.
 * @param props.item - Pull request.
 * @param props.teamName - Resolves a Team ID to its name.
 * @param props.formatDateTime - Formats an ISO timestamp.
 * @param props.t - Localized message resolver.
 * @returns The list item.
 */
function PullRequestRow({
  item,
  teamName,
  formatDateTime,
  t,
}: {
  item: GitHubPullRequestSummary
  teamName: (teamId: string) => string | undefined
  formatDateTime: (value: string) => string
  t: (key: MessageKey) => string
}) {
  const open = item.state === 'open'
  const team = teamName(item.teamId)
  return (
    <li className="grid gap-2 px-5 py-4" data-testid="pull-request-row">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <a
          className="min-w-0 break-words text-sm font-semibold text-[var(--workbench-text)] hover:underline"
          href={item.url}
          rel="noreferrer noopener"
          target="_blank"
        >
          <span className="text-[var(--workbench-muted)]">{item.repository}#{item.number}</span> {item.title}
          <span className="sr-only"> ({t('githubReviews.openOnGitHub')})</span>
        </a>
        <span className="text-xs font-medium text-[var(--workbench-muted)]">
          {t('githubReviews.updatedAt')} {formatDateTime(item.updatedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {open && item.draft ? <span className="workbench-badge">{t('githubReviews.draft')}</span> : null}
        {open && item.mergeable === 'conflicting' ? <span className="workbench-badge-danger">{t('githubReviews.conflict')}</span> : null}
        {open && item.checks.state === 'failure' ? <span className="workbench-badge-danger">{t('githubReviews.checks.failure')}</span> : null}
        {open && item.checks.state === 'pending' ? <span className="workbench-badge-warning">{t('githubReviews.checks.pending')}</span> : null}
        {open && item.checks.state === 'success' ? <span className="workbench-badge-success">{t('githubReviews.checks.success')}</span> : null}
        {open && item.reviewDecision !== 'none' ? (
          <span className={item.reviewDecision === 'approved'
            ? 'workbench-badge-success'
            : item.reviewDecision === 'changes-requested' ? 'workbench-badge-warning' : 'workbench-badge'}
          >
            {t(`githubReviews.review.${item.reviewDecision}`)}
          </span>
        ) : null}
        <span className="font-medium text-[var(--workbench-muted)]">
          {item.authorLogin ? `${t('githubReviews.author')} ${item.authorLogin}` : null}
          {team ? ` · ${team}` : null}
          {` · ${item.baseRef} ← ${item.headRef}`}
        </span>
      </div>
      {open && item.checks.failedNames.length > 0 ? (
        <p className="text-xs font-medium text-[var(--workbench-danger)]">
          {t('githubReviews.failedChecks')}: {item.checks.failedNames.join(', ')}
        </p>
      ) : null}
    </li>
  )
}
