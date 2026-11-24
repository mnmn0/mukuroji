import type { CalendarFeed } from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { SectionHeader } from '../../../shared/ui/WorkbenchPrimitives'
import { toWebcalUrl } from '../api/calendarFeeds'

/** Team and its Projects a member can choose for a Project feed. */
export type CalendarFeedTeamOption = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
  /** Projects of the Team the member can see. */
  projects: readonly {
    /** Project ID. */
    id: string
    /** Project name. */
    name: string
  }[]
}

/** Inputs of the calendar feed settings section. */
export type CalendarFeedsPanelProps = {
  /** Feeds of the member, or `undefined` while loading. */
  feeds?: readonly CalendarFeed[]
  /** Whether the feeds are loading for the first time. */
  isLoading: boolean
  /** Whether the feeds failed to load. */
  hasLoadError: boolean
  /** Whether the last issue or revoke failed. */
  hasOperationError: boolean
  /** Key of the running operation, such as `issue:member` or `revoke:<id>`. */
  busyOperation?: string
  /** URL of the feed issued last, shown once. */
  issued?: {
    /** Issued feed. */
    feed: CalendarFeed
    /** Absolute feed URL. */
    url: string
  }
  /** Teams and Projects offered for a Project feed. */
  teams: readonly CalendarFeedTeamOption[]
  /** Formats an ISO timestamp for display. */
  formatDateTime: (value: string) => string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Issues or reissues the member feed. */
  onIssueMember: () => void
  /** Issues or reissues a Project feed. */
  onIssueProject: (teamId: string, projectId: string) => void
  /** Revokes a feed. */
  onRevoke: (feed: CalendarFeed) => void
  /** Loads the feeds again. */
  onReload: () => void
  /** Hides the issued URL. */
  onDismissIssued: () => void
  /** Copies text; resolves whether it was copied. */
  onCopy: (text: string) => Promise<boolean>
}

/** Separator of the Team and Project IDs in a select value. */
const OPTION_SEPARATOR = '\u0000'

/**
 * Renders the calendar feed settings: the member feed, the Project feeds, and the URL issued
 * last.
 *
 * @param props - Feeds, state, options, and actions.
 * @returns The settings section.
 */
export function CalendarFeedsPanel({
  feeds,
  isLoading,
  hasLoadError,
  hasOperationError,
  busyOperation,
  issued,
  teams,
  formatDateTime,
  t,
  onIssueMember,
  onIssueProject,
  onRevoke,
  onReload,
  onDismissIssued,
  onCopy,
}: CalendarFeedsPanelProps) {
  const [selectedProject, setSelectedProject] = useState('')
  const [copyState, setCopyState] = useState<'copied' | 'failed'>()
  const busy = busyOperation !== undefined
  const memberFeed = feeds?.find((feed) => feed.kind === 'member')
  const projectFeeds = feeds?.filter((feed) => feed.kind === 'project') ?? []
  const projectOptions = teams.flatMap((team) => team.projects.map((project) => ({
    value: `${team.id}${OPTION_SEPARATOR}${project.id}`,
    label: `${team.name} / ${project.name}`,
  })))

  /**
   * Names the Project of a feed from the Teams the member can see.
   *
   * @param feed - Project feed.
   * @returns `Team / Project`, or a placeholder when the Project is no longer visible.
   */
  const projectLabel = (feed: CalendarFeed) => {
    const team = teams.find((candidate) => candidate.id === feed.teamId)
    const project = team?.projects.find((candidate) => candidate.id === feed.projectId)
    return team && project ? `${team.name} / ${project.name}` : t('calendarFeeds.project.unknown')
  }

  /** Copies the issued URL and reports the result. */
  const copyIssued = () => {
    if (!issued) return
    void onCopy(issued.url).then((copied) => setCopyState(copied ? 'copied' : 'failed'))
  }

  /** Issues the selected Project feed. */
  const issueSelectedProject = () => {
    const [teamId, projectId] = selectedProject.split(OPTION_SEPARATOR)
    if (teamId && projectId) onIssueProject(teamId, projectId)
  }

  return (
    <section className="workbench-panel overflow-hidden" data-testid="calendar-feeds-panel">
      <SectionHeader title={t('calendarFeeds.title')} />
      <p className="px-5 pb-4 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {t('calendarFeeds.description')}
      </p>
      <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
        {issued ? (
          <div
            className="grid gap-3 bg-[var(--workbench-surface-muted)] px-5 py-4"
            data-testid="calendar-feed-issued"
            role="status"
          >
            <strong className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('calendarFeeds.issuedTitle')}
            </strong>
            <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('calendarFeeds.issuedDescription')}
            </p>
            <input
              aria-label={t('calendarFeeds.issuedTitle')}
              className="workbench-input min-h-10 w-full min-w-0 px-3 font-mono text-xs"
              data-testid="calendar-feed-url"
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={issued.url}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button className="workbench-button-primary min-h-10 px-4" onClick={copyIssued} type="button">
                {t('calendarFeeds.copy')}
              </button>
              <a className="workbench-button-secondary inline-flex min-h-10 items-center px-4" href={toWebcalUrl(issued.url)}>
                {t('calendarFeeds.openInApp')}
              </a>
              <button
                className="workbench-button-secondary min-h-10 px-4"
                onClick={() => {
                  setCopyState(undefined)
                  onDismissIssued()
                }}
                type="button"
              >
                {t('calendarFeeds.dismiss')}
              </button>
              {copyState ? (
                <span className="text-sm font-medium text-[var(--workbench-muted)]" role="status">
                  {t(copyState === 'copied' ? 'calendarFeeds.copied' : 'calendarFeeds.copyFailed')}
                </span>
              ) : null}
            </div>
            <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('calendarFeeds.refreshNote')}
            </p>
          </div>
        ) : null}

        {hasOperationError ? (
          <p className="px-5 py-3 text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('calendarFeeds.operationError')}
          </p>
        ) : null}

        {hasLoadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" role="alert">
            <span className="text-sm font-semibold text-[var(--workbench-danger)]">{t('calendarFeeds.loadError')}</span>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={onReload} type="button">
              {t('calendarFeeds.retry')}
            </button>
          </div>
        ) : isLoading || !feeds ? (
          <p className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t('calendarFeeds.loading')}</p>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5" data-testid="calendar-feed-member">
              <div className="min-w-0 max-w-[640px]">
                <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('calendarFeeds.member.title')}</h3>
                <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {t('calendarFeeds.member.description')}
                </p>
                <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                  {memberFeed
                    ? `${t('calendarFeeds.issuedAt')}: ${formatDateTime(memberFeed.issuedAt)}`
                    : t('calendarFeeds.notIssued')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="workbench-button-primary min-h-10 px-4"
                  disabled={busy}
                  onClick={onIssueMember}
                  type="button"
                >
                  {t(memberFeed ? 'calendarFeeds.reissue' : 'calendarFeeds.issue')}
                </button>
                {memberFeed ? (
                  <button
                    className="workbench-button-secondary min-h-10 px-4"
                    disabled={busy}
                    onClick={() => onRevoke(memberFeed)}
                    type="button"
                  >
                    {t('calendarFeeds.revoke')}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 px-5 py-5" data-testid="calendar-feed-projects">
              <div className="min-w-0 max-w-[640px]">
                <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('calendarFeeds.project.title')}</h3>
                <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {t('calendarFeeds.project.description')}
                </p>
              </div>
              {projectFeeds.length === 0 ? (
                <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('calendarFeeds.project.empty')}</p>
              ) : (
                <ul className="grid gap-2">
                  {projectFeeds.map((feed) => (
                    <li
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-4 py-3"
                      key={feed.id}
                    >
                      <span className="min-w-0">
                        <strong className="block break-words text-sm font-semibold text-[var(--workbench-text)]">
                          {projectLabel(feed)}
                        </strong>
                        <span className="text-xs font-medium text-[var(--workbench-muted)]">
                          {`${t('calendarFeeds.issuedAt')}: ${formatDateTime(feed.issuedAt)}`}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-2">
                        <button
                          className="workbench-button-secondary min-h-10 px-4"
                          disabled={busy}
                          onClick={() => {
                            if (feed.teamId && feed.projectId) onIssueProject(feed.teamId, feed.projectId)
                          }}
                          type="button"
                        >
                          {t('calendarFeeds.reissue')}
                        </button>
                        <button
                          className="workbench-button-secondary min-h-10 px-4"
                          disabled={busy}
                          onClick={() => onRevoke(feed)}
                          type="button"
                        >
                          {t('calendarFeeds.revoke')}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <select
                  aria-label={t('calendarFeeds.project.select')}
                  className="workbench-input min-h-10 min-w-0 max-w-full flex-1 px-3"
                  data-testid="calendar-feed-project-select"
                  onChange={(event) => setSelectedProject(event.target.value)}
                  value={selectedProject}
                >
                  <option value="">{t('calendarFeeds.project.select')}</option>
                  {projectOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <button
                  className="workbench-button-primary min-h-10 px-4"
                  disabled={busy || !selectedProject}
                  onClick={issueSelectedProject}
                  type="button"
                >
                  {t('calendarFeeds.issue')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
