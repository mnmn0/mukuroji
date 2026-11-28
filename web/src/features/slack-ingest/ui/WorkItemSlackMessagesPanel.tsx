import type { SlackMessageView } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../../shared/i18n/i18n'
import { useWorkItemSlackMessages } from '../queries/useWorkItemSlackMessages'

/** Props of the pure Slack message panel. */
export type WorkItemSlackMessagesPanelProps = {
  /** Messages newest first. */
  messages: readonly SlackMessageView[]
  /** Whether older messages were left out. */
  truncated: boolean
  /** Whether the read failed. */
  hasLoadError?: boolean
  /** Formats an ISO time for display. */
  formatDateTime: (value: string) => string
  /** Translator. */
  t: (key: MessageKey) => string
  /** Reads the messages again. */
  onRetry?: () => void
}

/** Props of the panel bound to the Web API. */
export type WorkItemSlackMessagesPanelContainerProps = {
  /** Access token. */
  accessToken: string
  /** Display locale. */
  locale: Locale
  /** Team of the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
}

/**
 * Shows the Slack messages that mention the Work Item's key. The panel stays hidden while
 * there are none, so Workspaces without the Slack app see nothing new.
 *
 * @param props - Container props.
 * @returns The panel, or nothing.
 */
export function WorkItemSlackMessagesPanelContainer({ accessToken, locale, teamId, workItemId }: WorkItemSlackMessagesPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )
  const { data, error, mutate } = useWorkItemSlackMessages(accessToken, teamId, workItemId)
  if (!data && !error) return null
  if (data && data.messages.length === 0) return null
  return (
    <WorkItemSlackMessagesPanel
      formatDateTime={(value) => formatter.format(new Date(value))}
      hasLoadError={Boolean(error) && !data}
      messages={data?.messages ?? []}
      onRetry={() => void mutate()}
      t={t}
      truncated={data?.truncated ?? false}
    />
  )
}

/**
 * Renders Slack messages that mention a Work Item, each linking back to Slack.
 *
 * @param props - Messages, state, and actions.
 * @returns The panel.
 */
export function WorkItemSlackMessagesPanel({
  messages,
  truncated,
  hasLoadError = false,
  formatDateTime,
  t,
  onRetry,
}: WorkItemSlackMessagesPanelProps) {
  return (
    <section className="border-t border-[var(--workbench-border)] bg-surface px-6 py-6" data-testid="work-item-slack-messages-panel">
      <h2 className="workbench-eyebrow text-[var(--workbench-muted)]">{t('slackIngest.workItem.title')}</h2>
      <p className="mt-2 text-sm font-medium leading-5 text-[var(--workbench-muted)]">{t('slackIngest.workItem.description')}</p>
      {hasLoadError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-[var(--workbench-muted)]" role="alert">
          <span>{t('slackIngest.workItem.loadError')}</span>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetry} type="button">
              {t('slackIngest.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-4 grid gap-3">
          {messages.map((message) => (
            <li className="min-w-0 rounded-lg border border-[var(--workbench-border)] px-4 py-3" key={`${message.channelId}:${message.ts}`}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-[var(--workbench-muted)]">
                <span>#{message.channelName ?? message.channelId}</span>
                <span>{message.authorName ?? message.authorId}</span>
                <time dateTime={message.postedAt}>{formatDateTime(message.postedAt)}</time>
                {message.threadTs ? <span className="workbench-badge">{t('slackIngest.workItem.reply')}</span> : null}
                {message.editedAt ? <span>{t('slackIngest.workItem.edited')}</span> : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--workbench-text)]">{message.text}</p>
              <a
                className="mt-2 inline-flex text-sm font-semibold text-[var(--workbench-primary-text)] underline-offset-2 hover:underline"
                href={message.permalink}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t('slackIngest.workItem.open')}
              </a>
            </li>
          ))}
        </ul>
      )}
      {truncated ? <p className="mt-3 text-xs font-medium text-[var(--workbench-muted)]">{t('slackIngest.workItem.truncated')}</p> : null}
    </section>
  )
}
